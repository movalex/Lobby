import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { type TicketClaims, verifyTicket } from '@draftroom/auth-tickets'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { dataLayout } from '@draftroom/dev-assets'
import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from '@tldraw/sync-core'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  type AccessClient,
  type AccessMonitor,
  createAccessMonitor,
  createApiAccessClient,
} from './access.ts'
import { type BackupService, createBackupService } from './backup/service.ts'
import { isAllowedOrigin, type SyncConfig } from './config.ts'
import {
  BoardOpenRefused,
  type ElementRoomService,
  type InternalRoute,
  registeredElementRoom,
  type SessionDirectory,
} from './engine-switch.ts'
import { createRequestHandler } from './http/router.ts'
import { JoinQueue } from './join-queue.ts'
import { type BoardRole, canEditCanvas } from './permissions.ts'
import { InboundFrames, presenceIdentity } from './presence.ts'
import { BOARD_ID_RE, RoomRegistry } from './rooms.ts'
import { createApiSessionEndClient, createSessionEndReporter, type SessionEndClient } from './session-end.ts'
import { testHookRoutes } from './test-hooks.ts'
import { createApiTouchClient, createTouchReporter, type TouchClient, type TouchReporter } from './touch.ts'

export interface SyncServerOptions {
  /** Request log lines and room warnings. Default: console.log. */
  log?: (...a: unknown[]) => void
  /** Replaces the HTTP client for GET <api>/internal/access (tests). */
  accessClient?: AccessClient
  /** Replaces the HTTP client for GET <api>/internal/boards/:bid/touched (tests). */
  touchClient?: TouchClient
  /** Replaces the HTTP client for GET <api>/internal/boards/:bid/session-ended (tests). */
  sessionEndClient?: SessionEndClient
}

export interface SyncServer {
  http: Server
  registry: RoomRegistry
  /** Spike B: the ElementRoom service when DRAFTROOM_ENGINE=excalidraw (engine-switch.ts), else null. */
  elementRooms: ElementRoomService | null
  monitor: AccessMonitor
  /** Reports canvas edits to the API (dashboard "Edited …"; touch.ts). */
  touches: TouchReporter
  /** Offsite copies of the backups, staged restores, the backup status (backup/service.ts). */
  backups: BackupService
  /** Resolves with the bound port (useful with `port: 0`). */
  listen(): Promise<{ port: number }>
  /** Stops accepting, drops every socket, waits for in-flight requests, closes every room + DB. */
  close(): Promise<void>
}

export function createSyncServer(config: SyncConfig, opts: SyncServerOptions = {}): SyncServer {
  const log = opts.log ?? ((...a: unknown[]) => console.log(...a))
  // The registry reports removals to the monitor, which is created from the registry.
  let monitor: AccessMonitor | null = null
  const touches = createTouchReporter({
    client:
      opts.touchClient ??
      createApiTouchClient({ baseUrl: config.apiInternalUrl, internalSecret: config.internalSecret }),
    intervalMs: config.touchIntervalMs,
    log,
  })
  // The last editor leaving after changes (automatic checkpoints, session-end.ts).
  const sessionEnds = createSessionEndReporter({
    client:
      opts.sessionEndClient ??
      createApiSessionEndClient({ baseUrl: config.apiInternalUrl, internalSecret: config.internalSecret }),
    hasEditors: (boardId) => directory.sessionsOf(boardId).some((s) => canEditCanvas(s.meta.role)),
    log,
  })
  const registry = new RoomRegistry({
    dataDir: dataLayout(config.dataDir).rooms,
    schema: draftroomSchema,
    idleEvictMs: config.idleEvictMs,
    textLeaseMs: config.textLeaseMs,
    log,
    onSessionRemoved: (boardId, sessionId, meta) => {
      monitor?.removed(boardId, sessionId)
      sessionEnds.removed(boardId, meta)
    },
    onDocumentChange: (boardId) => {
      touches.touched(boardId)
      sessionEnds.changed(boardId)
    },
    backup: config.backupIntervalMs ? { intervalMs: config.backupIntervalMs } : undefined,
  })
  // Spike B (engine-switch.ts): with DRAFTROOM_ENGINE=excalidraw, sockets and board routes go to O1's
  // ElementRoom; the tldraw registry above stays idle (nothing opens a board file through it).
  const elementRooms: ElementRoomService | null =
    config.engine === 'excalidraw'
      ? createElementRooms(config, log, {
          removed: (boardId, sessionId, meta) => {
            monitor?.removed(boardId, sessionId)
            sessionEnds.removed(boardId, meta)
          },
          changed: (boardId) => {
            touches.touched(boardId)
            sessionEnds.changed(boardId)
          },
        })
      : null
  const directory: SessionDirectory = elementRooms ?? registry
  const backups = createBackupService({ config, backupsDir: registry.backupsDir(), log })
  const access: AccessMonitor = createAccessMonitor({
    registry: directory,
    client:
      opts.accessClient ??
      createApiAccessClient({ baseUrl: config.apiInternalUrl, internalSecret: config.internalSecret }),
    intervalMs: config.accessRecheckMs,
    log,
  })
  monitor = access

  let closing: Promise<void> | null = null
  const inflight = new Set<Promise<void>>()
  const engineRoutes: InternalRoute[] = [
    ...(elementRooms ? [...elementRooms.routes(), metricsRoute(elementRooms)] : []),
    ...(config.testHooks ? testHookRoutes() : []),
  ]
  const handle = createRequestHandler({
    internalSecret: config.internalSecret,
    registry,
    schema: draftroomSchema,
    monitor: access,
    backups,
    isClosing: () => closing !== null,
    log,
    engineRoutes,
    tldrawBoardRoutes: !elementRooms,
  })
  const http = createServer((req, res) => {
    const p = handle(req, res)
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const liveSockets = new Map<string, WebSocket>() // `${boardId}/${sid}` -> current ws
  // One expensive TLSync connect per macrotask (PERF-05, join-queue.ts): a crowd joining at once no
  // longer blocks everyone else's edits. Keyed per socket, not per session id (a replaced socket).
  const joins = new JoinQueue()
  let socketSeq = 0

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // ALLOWED_ORIGINS (platform): refused before the upgrade, before the ticket is read and before any
    // room is touched. Defense in depth against pages on other sites; the ticket stays the authentication.
    const origin = req.headers.origin
    if (!isAllowedOrigin(config.allowedOrigins, origin)) {
      const shown = typeof origin === 'string' ? JSON.stringify(origin.slice(0, 100)) : 'none'
      log(`[connect] refused: Origin ${shown} is not in ALLOWED_ORIGINS`) // never the URL (it holds the ticket)
      socket.on('error', () => socket.destroy()) // a reset mid-write must not become an uncaught error
      socket.once('finish', () => socket.destroy())
      return void socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
    let url: URL | null = null
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {}
    const m = url && /^\/connect\/([^/]+)$/.exec(url.pathname)
    const boardId = m?.[1]
    const clientSessionId = url?.searchParams.get('sessionId') // appended by useSync (TAB_ID)
    if (!url || !boardId || !BOARD_ID_RE.test(boardId) || !clientSessionId || clientSessionId.length > 128) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      return void socket.destroy()
    }
    // Verified BEFORE the upgrade and before any room is touched, so a refused ticket opens nothing.
    const verdict = verifyTicket(config.ticketSecret, url.searchParams.get('ticket'), { boardId })
    // close() may have started: never reopen a room after closeAll().
    if (closing) return void socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!verdict.ok) {
        // A valid signature for another board is an authorization failure, not an authentication one.
        const reason =
          verdict.reason === 'wrong_board'
            ? TLSyncErrorCloseEventReason.FORBIDDEN
            : TLSyncErrorCloseEventReason.NOT_AUTHENTICATED
        log(`[connect] refused on board ${boardId}: ${verdict.reason}`) // never the ticket itself
        // 4099 = terminal on the client (an HTTP 401 before the upgrade would retry forever)
        return ws.close(TLSyncErrorCloseEventCode, reason)
      }
      if (elementRooms) return connectElement(elementRooms, ws, boardId, clientSessionId, verdict.claims)
      const { uid, role, name, color, iat } = verdict.claims
      let room: ReturnType<RoomRegistry['getOrCreate']>
      try {
        room = registry.getOrCreate(boardId) // synchronous from here on
      } catch (e) {
        // Spike B: the R0 stand-in's born-after check refused a board made on the new canvas (§8.3 B8).
        if (e instanceof BoardOpenRefused) return ws.close(TLSyncErrorCloseEventCode, 'NEW_CANVAS_BOARD')
        log('room open failed', boardId, e)
        return ws.close(TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason.UNKNOWN_ERROR)
      }
      const sid = `${uid}:${clientSessionId}` // namespace the client-chosen id by user
      const liveKey = `${boardId}/${sid}`
      const prev = liveSockets.get(liveKey)
      liveSockets.set(liveKey, ws)
      if (prev && prev !== ws) prev.close(1000, 'replaced')
      // Who the TICKET is, never who the client claims to be: presence and the session's own tldraw
      // user record carry exactly this (presence.ts, user-records.ts).
      const who = presenceIdentity({ uid, name, color })
      room.handleSocketConnect({
        sessionId: sid,
        // wrapper WITHOUT addEventListener: the room must not bind listeners to the raw ws, or a late
        // 'close' from a replaced socket kills the new session that has the same sessionId
        socket: {
          send: (d: string) => ws.send(d),
          close: (c?: number, r?: string) => ws.close(c, r),
          get readyState() {
            return ws.readyState
          },
        },
        // The server is the enforcement: viewers and commenters get their writes discarded.
        isReadonly: !canEditCanvas(role),
        meta: { userId: uid, role, name, color: who.color },
      })
      access.admitted(boardId, sid, uid, iat)
      const isCurrent = () => liveSockets.get(liveKey) === ws
      const socketKey = ++socketSeq
      // Binds presence and the session's own user record to `who`. This also reassembles chunked
      // frames, so the room only ever receives whole, checked messages.
      const inbound = new InboundFrames(who)
      let refused = false // nothing more from a socket caught forging, while its close goes out
      // Checked again at delivery: the socket may have been replaced while its frames were queued.
      const deliver = (frame: string) => {
        if (!isCurrent() || refused) return
        const r = inbound.accept(frame)
        if (r.kind === 'deliver') room.handleSocketMessage(sid, r.text)
        else if (r.kind === 'forged' || r.kind === 'forged-user') {
          refused = true
          log(
            r.kind === 'forged'
              ? `[presence] refused a presence claiming another user on board ${boardId}`
              : `[user-record] refused a user record unlike the ticket on board ${boardId}`,
          )
          // 4099: terminal on the client, so a stale tab stops here instead of retrying in a loop.
          room.closeSession(sid, TLSyncErrorCloseEventReason.INVALID_RECORD)
        } else if (r.kind === 'malformed') room.handleSocketError(sid) // what the room's assembler does
      }
      let tokens = 400
      let last = Date.now()
      ws.on('message', (data, isBinary) => {
        if (!isCurrent()) return
        const now = Date.now()
        tokens = Math.min(400, tokens + ((now - last) / 1000) * 200)
        last = now
        if (--tokens < 0) return room.closeSession(sid, TLSyncErrorCloseEventReason.RATE_LIMITED)
        const text = isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString()
        const chunkHead = /^(\d+)_/.exec(text) // chunk frames: "<remaining>_<payload>"
        if (chunkHead && Number(chunkHead[1]) > 40)
          return room.closeSession(sid, TLSyncErrorCloseEventReason.INVALID_RECORD)
        joins.push(socketKey, text, deliver)
      })
      ws.on('close', () => {
        joins.drop(socketKey)
        if (!isCurrent()) return
        liveSockets.delete(liveKey)
        room.handleSocketClose(sid)
      })
      ws.on('error', () => {
        joins.drop(socketKey)
        if (!isCurrent()) return
        liveSockets.delete(liveKey)
        room.handleSocketError(sid)
      })
    })
  }
  // Spike B: a verified socket on the ElementRoom, with the same guards as the tldraw path: the
  // replaced-socket guard keyed by boardId/sid, the message token bucket (4099 RATE_LIMITED), the join
  // queue and the access monitor's admission. The room parses and answers every message (protocol.ts).
  const connectElement = (
    rooms: ElementRoomService,
    ws: WebSocket,
    boardId: string,
    clientSessionId: string,
    claims: TicketClaims,
  ) => {
    const { uid, role, name, color, iat } = claims
    const sid = `${uid}:${clientSessionId}`
    const liveKey = `${boardId}/${sid}`
    const who = presenceIdentity({ uid, name, color })
    let session: ReturnType<ElementRoomService['connect']>
    try {
      session = rooms.connect(
        {
          boardId,
          sid,
          uid,
          name,
          color: who.color,
          role,
          guest: claims.guest === true,
          readonly: !canEditCanvas(role),
          ticketIssuedAt: iat,
        },
        {
          send: (d: string | Uint8Array) => ws.send(d),
          close: (c: number, r: string) => ws.close(c, r),
          get readyState() {
            return ws.readyState
          },
          get bufferedAmount() {
            return ws.bufferedAmount
          },
        },
      )
    } catch (e) {
      log('room open failed', boardId, (e as Error)?.message ?? 'unknown') // the message only
      return ws.close(TLSyncErrorCloseEventCode, 'UNKNOWN_ERROR')
    }
    const prev = liveSockets.get(liveKey)
    liveSockets.set(liveKey, ws)
    if (prev && prev !== ws) prev.close(1000, 'replaced')
    access.admitted(boardId, sid, uid, iat)
    const isCurrent = () => liveSockets.get(liveKey) === ws
    const socketKey = ++socketSeq
    let ended = false
    const end = () => {
      joins.drop(socketKey)
      if (ended) return
      ended = true
      if (isCurrent()) liveSockets.delete(liveKey)
      session.closed()
    }
    const deliver = (frame: string) => {
      if (!isCurrent() || ended) return
      session.message(frame)
    }
    let tokens = 400
    let last = Date.now()
    ws.on('message', (data, isBinary) => {
      if (!isCurrent()) return
      const now = Date.now()
      tokens = Math.min(400, tokens + ((now - last) / 1000) * 200)
      last = now
      if (--tokens < 0) return ws.close(TLSyncErrorCloseEventCode, 'RATE_LIMITED')
      const text = isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString()
      joins.push(socketKey, text, deliver)
    })
    ws.on('close', end)
    ws.on('error', end)
  }

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      onUpgrade(req, socket, head)
    } catch (e) {
      log('[upgrade error]', (e as Error)?.message ?? 'unknown') // the message only: no URL, no ticket
      socket.destroy()
    }
  })

  return {
    http,
    registry,
    elementRooms,
    monitor: access,
    touches,
    backups,
    async listen() {
      await backups.start() // staged restores first: no room can be open yet
      return new Promise((resolve, reject) => {
        const onError = (e: Error) => reject(e)
        http.once('error', onError)
        http.listen(config.port, config.host, () => {
          http.off('error', onError)
          access.start()
          resolve({ port: (http.address() as AddressInfo).port })
        })
      })
    },
    close() {
      closing ??= (async () => {
        access.stop()
        const stopped = http.listening
          ? new Promise<void>((resolve) => http.close(() => resolve()))
          : Promise.resolve()
        joins.clear()
        registry.closeAll() // closes rooms (and their sessions' sockets), flushes the prune, closes DBs
        await elementRooms?.closeAll()
        // Upgraded sockets are no longer HTTP connections, so closeAllConnections() does not see them.
        for (const ws of wss.clients) ws.terminate()
        liveSockets.clear()
        http.closeAllConnections() // aborts in-flight requests (e.g. a half-sent seed body)
        await Promise.allSettled([...inflight])
        // The last edits' "Edited" times: best effort, never more than a second of shutdown.
        await Promise.race([
          Promise.all([touches.flush(), sessionEnds.flush()]),
          new Promise((r) => setTimeout(r, 1_000).unref()),
        ])
        touches.stop()
        sessionEnds.stop()
        await backups.stop()
        await stopped
        await new Promise<void>((resolve) => wss.close(() => resolve()))
      })()
      return closing
    },
  }
}

/** Spike B: creates O1's ElementRoom service (engine-switch.ts) with the server's reporters. */
function createElementRooms(
  config: SyncConfig,
  log: (...a: unknown[]) => void,
  report: {
    removed: (
      boardId: string,
      sessionId: string,
      meta: { userId: string; role: BoardRole; name: string; color: string },
    ) => void
    changed: (boardId: string) => void
  },
): ElementRoomService {
  const factory = registeredElementRoom()
  if (!factory)
    throw new Error(
      'DRAFTROOM_ENGINE=excalidraw but no ElementRoom is registered (loadEngine() imports apps/sync/src/room/index.ts)',
    )
  return factory({
    dataDir: dataLayout(config.dataDir).rooms,
    config,
    log,
    onSessionRemoved: (boardId, sessionId, meta) => report.removed(boardId, sessionId, meta),
    onDocumentChange: (boardId) => report.changed(boardId),
  })
}

/** GET /internal/metrics (§2.4.6): the ElementRoom's Prometheus text. */
function metricsRoute(rooms: ElementRoomService): InternalRoute {
  return {
    method: 'GET',
    path: /^\/internal\/metrics$/,
    handle: (_req, res) => {
      const body = rooms.metrics()
      res
        .writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(body)),
          'Cache-Control': 'no-store',
        })
        .end(body)
    },
  }
}
