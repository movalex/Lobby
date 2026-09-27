import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { dataLayout, ensureLayout } from '@draftroom/dev-assets'
import { type WebSocket, WebSocketServer } from 'ws'
import type { SyncConfig } from './config.ts'
import { createRequestHandler } from './http/router.ts'
import { DEV_USER_RE } from './http/upload.ts'
import { BOARD_ID_RE, RoomRegistry } from './rooms.ts'

export interface SyncServerOptions {
  /** Request log lines and room warnings. Default: console.log. */
  log?: (...a: unknown[]) => void
}

export interface SyncServer {
  http: Server
  registry: RoomRegistry
  /** Resolves with the bound port (useful with `port: 0`). */
  listen(): Promise<{ port: number }>
  /** Stops accepting, drops every socket, waits for in-flight requests, closes every room + DB. */
  close(): Promise<void>
}

async function authorize(url: URL): Promise<{ userId: string; canEdit: boolean } | null> {
  const user = url.searchParams.get('devUser') // DEV ONLY stand-in for a signed ticket
  if (!user || !DEV_USER_RE.test(user)) return null
  return { userId: user, canEdit: url.searchParams.get('devRole') !== 'viewer' }
}

export function createSyncServer(config: SyncConfig, opts: SyncServerOptions = {}): SyncServer {
  // Development identities ONLY behind an explicit flag (loadConfig refuses to produce anything else).
  if (config.devAuth !== true) throw new Error('No real auth yet: DRAFTROOM_DEV_AUTH=1 is required')
  const log = opts.log ?? ((...a: unknown[]) => console.log(...a))
  const layout = ensureLayout(dataLayout(config.dataDir))
  const registry = new RoomRegistry({
    dataDir: layout.rooms,
    schema: draftroomSchema,
    idleEvictMs: config.idleEvictMs,
    textLeaseMs: config.textLeaseMs,
    log,
  })

  let closing: Promise<void> | null = null
  const inflight = new Set<Promise<void>>()
  const handle = createRequestHandler({ layout, devRoutes: config.devAuth, log })
  const http = createServer((req, res) => {
    const p = handle(req, res)
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const liveSockets = new Map<string, WebSocket>() // `${boardId}/${sid}` -> current ws

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
    // Node detaches its own socket error handler on 'upgrade'; ws attaches one in handleUpgrade.
    // Until then a reset during authorize() would be an unhandled 'error' event.
    const onSocketError = () => socket.destroy()
    socket.on('error', onSocketError)
    const auth = await authorize(url) // ALL async work happens before getOrCreate
    socket.off('error', onSocketError)
    // close() may have run during authorize(): never reopen a room after closeAll().
    if (closing) return void socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!auth) return ws.close(4099, 'NOT_AUTHENTICATED') // 4099 = terminal on the client (no retry loop)
      let room: ReturnType<RoomRegistry['getOrCreate']>
      try {
        room = registry.getOrCreate(boardId) // synchronous from here on
      } catch (e) {
        log('room open failed', boardId, e)
        return ws.close(4099, 'UNKNOWN_ERROR')
      }
      const sid = `${auth.userId}:${clientSessionId}` // namespace the client-chosen id by user
      const liveKey = `${boardId}/${sid}`
      const prev = liveSockets.get(liveKey)
      liveSockets.set(liveKey, ws)
      if (prev && prev !== ws) prev.close(1000, 'replaced')
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
        isReadonly: !auth.canEdit,
        meta: { userId: auth.userId },
      })
      const isCurrent = () => liveSockets.get(liveKey) === ws
      let tokens = 400
      let last = Date.now()
      ws.on('message', (data, isBinary) => {
        if (!isCurrent()) return
        const now = Date.now()
        tokens = Math.min(400, tokens + ((now - last) / 1000) * 200)
        last = now
        if (--tokens < 0) return room.closeSession(sid, 'RATE_LIMITED')
        const text = isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString()
        const chunkHead = /^(\d+)_/.exec(text) // chunk frames: "<remaining>_<payload>"
        if (chunkHead && Number(chunkHead[1]) > 40) return room.closeSession(sid, 'INVALID_RECORD')
        room.handleSocketMessage(sid, text)
      })
      ws.on('close', () => {
        if (!isCurrent()) return
        liveSockets.delete(liveKey)
        room.handleSocketClose(sid)
      })
      ws.on('error', () => {
        if (!isCurrent()) return
        liveSockets.delete(liveKey)
        room.handleSocketError(sid)
      })
    })
  }
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    onUpgrade(req, socket, head).catch((e: unknown) => {
      log('[upgrade error]', e)
      socket.destroy()
    })
  })

  return {
    http,
    registry,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (e: Error) => reject(e)
        http.once('error', onError)
        http.listen(config.port, config.host, () => {
          http.off('error', onError)
          resolve({ port: (http.address() as AddressInfo).port })
        })
      })
    },
    close() {
      closing ??= (async () => {
        const stopped = http.listening
          ? new Promise<void>((resolve) => http.close(() => resolve()))
          : Promise.resolve()
        registry.closeAll() // closes rooms (and their sessions' sockets), flushes the prune, closes DBs
        // Upgraded sockets are no longer HTTP connections, so closeAllConnections() does not see them.
        for (const ws of wss.clients) ws.terminate()
        liveSockets.clear()
        http.closeAllConnections() // aborts in-flight uploads; their handlers delete partial files
        await Promise.allSettled([...inflight])
        await stopped
        await new Promise<void>((resolve) => wss.close(() => resolve()))
      })()
      return closing
    },
  }
}
