import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { type TicketClaims, verifyTicket } from '@draftroom/auth-tickets'
import { CLOSE_TERMINAL, CONNECT_REV_PARAM, connectRevOf } from '@draftroom/canvas-schema/protocol'
import { dataLayout } from '@draftroom/dev-assets'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  type AccessClient,
  type AccessMonitor,
  createAccessMonitor,
  createApiAccessClient,
} from './access.ts'
import type { BackupEntry } from './backup/backup.ts'
import { ElementBackups } from './backup/element-backups.ts'
import { createRunAll } from './backup/run-all.ts'
import { type BackupService, createBackupService } from './backup/service.ts'
import { isAllowedOrigin, type SyncConfig } from './config.ts'
import { type DiskProbe, diskProbe } from './disk.ts'
import {
  type ElementRoomDeps,
  type ElementRoomService,
  extendElementRoom,
  type InternalRoute,
  registeredElementRoom,
} from './engine-switch.ts'
import { createRequestHandler, type MaintenanceControl } from './http/router.ts'
import { JoinQueue } from './join-queue.ts'
import { errorSummary } from './log-error.ts'
import { type BoardRole, canEditCanvas } from './permissions.ts'
import { presenceIdentity } from './presence.ts'
import { closeTerminal } from './room/closing.ts'
import { registerMaintenanceState } from './room/migrate/maintenance.ts'
import { BOARD_ID_RE, backupsDirFor } from './rooms.ts'
import { createApiSessionEndClient, createSessionEndReporter, type SessionEndClient } from './session-end.ts'
import { testHookRoutes } from './test-hooks.ts'
import { createApiTouchClient, createTouchReporter, type TouchClient, type TouchReporter } from './touch.ts'

/** The terminal close reason of every socket while maintenance is on (the web: "Lobby is updating"). */
export const MAINTENANCE_REASON = 'MAINTENANCE'

// ---- where a board socket's ticket is (security audit L7) ---------------------------------------------
//
// The web sends the ticket in the handshake's `Sec-WebSocket-Protocol` header, as a second offered
// subprotocol `lobby.ticket.<ticket>` next to `lobby.board.v1` (apps/web/src/board/ticket.ts defines the
// same two names), so platform logs that keep request URLs never hold one. The answer names exactly
// `lobby.board.v1`: a browser fails a handshake whose answer names a protocol it did not offer, and the
// ticket never comes back in a response header. The old transport, `?ticket=` in the URL, is still
// accepted for at least one release (tabs opened before the deploy, cached bundles, the headless and load
// clients). Either way the ticket is verified before the upgrade and never logged.

// ---- permessage-deflate (wave M, M7-2, CAP-BANDWIDTH) ------------------------------------------------------
//
// Presence goes out as JSON at 10 Hz to everyone on a board (30 lasers: about 2.3 MB/s), and Render bills
// WebSocket bytes past the included allowance. Browsers offer permessage-deflate on their own, so this needs no
// protocol frame, CONTRACTS_REV or reader-frame change: a client that does not offer it (or an edge that strips
// the header) talks uncompressed, exactly as before. Level 1 and memLevel 7 keep the CPU and the per-socket
// memory small (the server keeps its context per socket for the ratio; the client is asked not to, which costs
// nothing here: client frames are small). At most 4 zlib jobs run at once, process-wide. `threshold` (1 KiB) only
// applies to a sender without context takeover (ws/lib/sender.js), so with the server's context kept every text
// frame is deflated: a small cursor frame compresses well against the ones before it (the M7-7 NAS run measures
// the CPU). The gzip snapshot is sent with `compress: false` (room/outbound.ts). DRAFTROOM_WS_DEFLATE=off is the
// kill switch (config.ts; a restart).
export const WS_DEFLATE_OPTIONS = Object.freeze({
  zlibDeflateOptions: Object.freeze({ level: 1, memLevel: 7 }),
  threshold: 1024,
  concurrencyLimit: 4,
  clientNoContextTakeover: true,
  serverNoContextTakeover: false,
})

/** The subprotocol a board socket speaks: the one the server answers with. */
export const BOARD_SOCKET_PROTOCOL = 'lobby.board.v1'
/** The offered subprotocol that carries the ticket: this prefix, then the ticket. */
export const TICKET_PROTOCOL_PREFIX = 'lobby.ticket.'

/**
 * The ticket an upgrade presents: the offered `lobby.ticket.<ticket>` subprotocol, else the URL's
 * `?ticket=` (the old transport), else null (refused NOT_AUTHENTICATED like a bad ticket).
 */
export function upgradeTicket(req: IncomingMessage, url: URL): string | null {
  const offered = req.headers['sec-websocket-protocol']
  if (typeof offered === 'string')
    for (const raw of offered.split(',')) {
      const p = raw.trim()
      if (p.startsWith(TICKET_PROTOCOL_PREFIX) && p.length > TICKET_PROTOCOL_PREFIX.length)
        return p.slice(TICKET_PROTOCOL_PREFIX.length)
    }
  return url.searchParams.get('ticket')
}

/** The subprotocol the server answers with: `lobby.board.v1` when offered, else none (the old transport). */
const selectProtocol = (offered: Set<string>): string | false =>
  offered.has(BOARD_SOCKET_PROTOCOL) ? BOARD_SOCKET_PROTOCOL : false

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
  /** The ElementRoom service: every open board's room (engine-switch.ts). */
  elementRooms: ElementRoomService
  monitor: AccessMonitor
  /** Reports canvas edits to the API (dashboard "Edited …"; touch.ts). */
  touches: TouchReporter
  /** Offsite copies of the backups, staged restores, the backup status (backup/service.ts). */
  backups: BackupService
  /** The local backups root (null when the data dir is not the server's layout: a bare folder in a test). */
  backupsDir: string | null
  /** Maintenance mode (bridge release R0; POST /internal/maintenance drives the same switch). */
  maintenance: MaintenanceControl
  /** Resolves with the bound port (useful with `port: 0`). */
  listen(): Promise<{ port: number }>
  /** Stops accepting, drops every socket, waits for in-flight requests, closes every room + DB. */
  close(): Promise<void>
}

export function createSyncServer(config: SyncConfig, opts: SyncServerOptions = {}): SyncServer {
  const log = opts.log ?? ((...a: unknown[]) => console.log(...a))
  const roomsDir = dataLayout(config.dataDir).rooms
  mkdirSync(roomsDir, { recursive: true })
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
    hasEditors: (boardId) => elementRooms.sessionsOf(boardId).some((s) => canEditCanvas(s.meta.role)),
    log,
  })
  // Maintenance mode (below, where the switch is built): declared here because the rooms read it too
  // (ElementRoomDeps.maintenance, OPEN16: the second check after a write's body is read)
  let maintenance = config.bootMaintenance === true
  // M7-4: the disk's free share (statfs; the test hook's fixed answer), read by the rooms (DISK notice, the
  // metrics), the backup pass and the deep health check
  const disk: DiskProbe = diskProbe({ fixed: config.testDiskFree ?? null })
  // The ElementRoom (engine-switch.ts): sockets and the board routes go to it.
  const elementRooms: ElementRoomService = createElementRooms(config, log, () => maintenance, disk, {
    removed: (boardId, sessionId, meta) => {
      monitor?.removed(boardId, sessionId)
      sessionEnds.removed(boardId, meta)
    },
    changed: (boardId) => {
      touches.touched(boardId)
      sessionEnds.changed(boardId)
    },
  })
  // Local backups of the board files (backup/element-backups.ts): on when the data dir is the server's
  // layout (<DATA>/rooms -> <DATA>/backups), off for a bare folder (tests).
  const backupsDir = backupsDirFor(roomsDir)
  const backups = createBackupService({ config, backupsDir, log })
  const elementBackups = backupsDir
    ? new ElementBackups({
        roomsDir,
        backupsDir,
        ...(config.backupIntervalMs ? { intervalMs: config.backupIntervalMs } : {}),
        // M7-4: DRAFTROOM_BACKUP_KEEP; held and low-disk prunes read what the offsite store holds
        ...(config.backupKeep ? { keep: config.backupKeep } : {}),
        offsite: backups,
        disk,
        log,
      })
    : null
  const access: AccessMonitor = createAccessMonitor({
    registry: elementRooms,
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
    ...elementRooms.routes(),
    metricsRoute(elementRooms),
    ...(config.testHooks ? testHookRoutes() : []),
  ]

  // ---- maintenance mode (bridge release R0, docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 3) --------
  // POST /internal/maintenance {on}. On: the pushes that already reached the server (held behind a
  // queued connect, join-queue.ts) are delivered and commit, then every socket is closed with 4099
  // MAINTENANCE (terminal on the client: the web shows "Lobby is updating"; the CLOSING notice goes
  // first, room/closing.ts), and new ones are refused the same way, after the ticket check and before
  // any room is touched. Internal reads keep working (snapshot for the final checkpoints, backups,
  // run-all); the internal routes that write a board are refused (router.ts). A runtime switch: a
  // restart or a redeploy starts with it off, unless the server was started with
  // DRAFTROOM_BOOT_MAINTENANCE=1 (open item 11: the build deployed into the cut-over's maintenance
  // window starts in it; the same POST turns it off).
  if (maintenance) log('[maintenance] on at start (DRAFTROOM_BOOT_MAINTENANCE=1)')
  const setMaintenance = (on: boolean) => {
    const was = maintenance
    maintenance = on
    let closedSockets = 0
    if (on) {
      joins.flush()
      for (const ws of [...liveSockets.values()]) {
        // 0 CONNECTING, 1 OPEN. The room's session handler cleans up on the close.
        if (ws.readyState < 2) closeTerminal(ws, MAINTENANCE_REASON)
        closedSockets++
      }
    }
    if (on !== was) log(`[maintenance] ${on ? 'on' : 'off'}${on ? `: ${closedSockets} sockets closed` : ''}`)
    return { maintenance, closedSockets }
  }
  const maintenanceControl: MaintenanceControl = { on: () => maintenance, set: setMaintenance }
  // convert-all is refused while maintenance is off unless confirmed (room/migrate/maintenance.ts; audit L6)
  registerMaintenanceState(() => maintenance)
  const runAll = createRunAll({
    registry: elementBackups ?? BACKUPS_OFF,
    backups,
    log,
    maintenance: () => maintenance,
    // a run while a recent held set exists is refused unless forced (run-all.ts; audit L6)
    backupsDir: () => backupsDir,
  })

  const handle = createRequestHandler({
    internalSecret: config.internalSecret,
    monitor: access,
    backups,
    isClosing: () => closing !== null,
    log,
    engineRoutes,
    maintenance: maintenanceControl,
    runAll,
    backupsDir: () => backupsDir,
  })
  const http = createServer((req, res) => {
    const p = handle(req, res)
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  })

  const wss = new WebSocketServer({
    noServer: true,
    // also the most a compressed client frame may inflate to (ws checks the inflated size)
    maxPayload: 1024 * 1024,
    handleProtocols: selectProtocol,
    perMessageDeflate:
      config.wsDeflate === false
        ? false
        : { ...WS_DEFLATE_OPTIONS, zlibDeflateOptions: { ...WS_DEFLATE_OPTIONS.zlibDeflateOptions } },
  })
  log(`[connect] permessage-deflate ${config.wsDeflate === false ? 'off (DRAFTROOM_WS_DEFLATE=off)' : 'on'}`)
  const liveSockets = new Map<string, WebSocket>() // `${boardId}/${sid}` -> current ws
  // One expensive connect per macrotask (PERF-05, join-queue.ts): a crowd joining at once no longer
  // blocks everyone else's edits. Keyed per socket, not per session id (a replaced socket).
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
    const clientSessionId = url?.searchParams.get('sessionId') // appended by the client (TAB_ID)
    // CONTRACTS_REV 12: the contracts revision the client reads, from its connect URL (none: an older client)
    const contractsRev = connectRevOf(url?.searchParams.get(CONNECT_REV_PARAM))
    if (!url || !boardId || !BOARD_ID_RE.test(boardId) || !clientSessionId || clientSessionId.length > 128) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      return void socket.destroy()
    }
    // Verified BEFORE the upgrade and before any room is touched, so a refused ticket opens nothing.
    // From the handshake's subprotocol (L7), or the URL (the old transport, still accepted).
    const verdict = verifyTicket(config.ticketSecret, upgradeTicket(req, url), { boardId })
    // close() may have started: never reopen a room after closeAll().
    if (closing) return void socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!verdict.ok) {
        // A valid signature for another board is an authorization failure, not an authentication one.
        const reason = verdict.reason === 'wrong_board' ? 'FORBIDDEN' : 'NOT_AUTHENTICATED'
        log(`[connect] refused on board ${boardId}: ${verdict.reason}`) // never the ticket itself
        // 4099 = terminal on the client (an HTTP 401 before the upgrade would retry forever); the
        // CLOSING notice goes first (CONTRACTS_REV 9, SMK-2: the edge delivered an empty close frame)
        return closeTerminal(ws, reason)
      }
      // Maintenance (bridge release R0): refused before any room is touched; terminal on the client.
      if (maintenance) return closeTerminal(ws, MAINTENANCE_REASON)
      connectElement(elementRooms, ws, boardId, clientSessionId, verdict.claims, contractsRev)
    })
  }
  // A verified socket on the ElementRoom: the replaced-socket guard keyed by boardId/sid, the message
  // token bucket (4099 RATE_LIMITED), the join queue and the access monitor's admission. The room parses
  // and answers every message (protocol.ts).
  const connectElement = (
    rooms: ElementRoomService,
    ws: WebSocket,
    boardId: string,
    clientSessionId: string,
    claims: TicketClaims,
    contractsRev: number | null,
  ) => {
    const { uid, role, name, color, iat } = claims
    const sid = `${uid}:${clientSessionId}`
    const liveKey = `${boardId}/${sid}`
    // Who the TICKET is, never who the client claims to be (presence.ts).
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
          contractsRev,
        },
        {
          send: (d: string | Uint8Array, o?: { readonly compress?: boolean }) =>
            o ? ws.send(d, { compress: o.compress !== false }) : ws.send(d),
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
      log('room open failed', boardId, errorSummary(e)) // never the error object (L5)
      return ws.close(CLOSE_TERMINAL, 'UNKNOWN_ERROR')
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
      if (--tokens < 0) return ws.close(CLOSE_TERMINAL, 'RATE_LIMITED')
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
    elementRooms,
    monitor: access,
    touches,
    backups,
    backupsDir,
    maintenance: maintenanceControl,
    async listen() {
      await backups.start() // staged restores first: no room can be open yet
      elementBackups?.start()
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
        await elementRooms.closeAll() // closes rooms (and their sessions' sockets) and board files
        registerMaintenanceState(null)
        // Upgraded sockets are no longer HTTP connections, so closeAllConnections() does not see them.
        for (const ws of wss.clients) ws.terminate()
        liveSockets.clear()
        http.closeAllConnections() // aborts in-flight requests (e.g. a half-sent seed body)
        // A run-all in progress stops after its current board and ends failed (its report is never made).
        await Promise.allSettled([...inflight, runAll.stop()])
        // The last edits' "Edited" times: best effort, never more than a second of shutdown.
        await Promise.race([
          Promise.all([touches.flush(), sessionEnds.flush()]),
          new Promise((r) => setTimeout(r, 1_000).unref()),
        ])
        touches.stop()
        sessionEnds.stop()
        await elementBackups?.stop()
        await backups.stop()
        await stopped
        await new Promise<void>((resolve) => wss.close(() => resolve()))
      })()
      return closing
    },
  }
}

/** What run-all sees when local backups are off (the route answers 409 BACKUPS_OFF before any run). */
const BACKUPS_OFF = {
  boardFileIds: (): string[] => [],
  backupFresh: (): Promise<BackupEntry> => Promise.reject(new Error('backups are off')),
}

/** Creates the ElementRoom service (engine-switch.ts) with the server's reporters. */
function createElementRooms(
  config: SyncConfig,
  log: (...a: unknown[]) => void,
  maintenance: () => boolean,
  disk: DiskProbe,
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
    throw new Error('no ElementRoom is registered (loadEngine() imports apps/sync/src/room/index.ts)')
  const deps: ElementRoomDeps = {
    dataDir: dataLayout(config.dataDir).rooms,
    config,
    log,
    onSessionRemoved: (boardId, sessionId, meta) => report.removed(boardId, sessionId, meta),
    onDocumentChange: (boardId) => report.changed(boardId),
    maintenance,
    disk,
  }
  // CR 2F-1: the registered room extensions' routes (apps/sync/src/room-internal/) join the room's own
  return extendElementRoom(factory(deps), deps)
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
