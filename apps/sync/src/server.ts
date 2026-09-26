import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { dataLayout, ensureLayout, resolveDataDir } from '@draftroom/dev-assets'
import { type WebSocket, WebSocketServer } from 'ws'
import { BOARD_ID_RE, RoomRegistry } from './rooms.ts'

const PORT = Number(process.env.PORT ?? 5858)
const HOST = process.env.HOST ?? '127.0.0.1'
// Development identities ONLY behind an explicit flag; never set in a deployment.
const DEV_AUTH = process.env.DRAFTROOM_DEV_AUTH === '1'
if (!DEV_AUTH) throw new Error('No real auth yet: set DRAFTROOM_DEV_AUTH=1 for local development only')
const layout = ensureLayout(dataLayout(resolveDataDir()))

const registry = new RoomRegistry({
  dataDir: layout.rooms,
  schema: draftroomSchema,
  idleEvictMs: Number(process.env.IDLE_EVICT_MS ?? 30_000),
  log: (...a) => console.log(...a),
})

async function authorize(url: URL): Promise<{ userId: string; canEdit: boolean } | null> {
  const user = url.searchParams.get('devUser') // DEV ONLY stand-in for a signed ticket
  if (!user || !/^[a-z0-9-]{1,32}$/.test(user)) return null
  return { userId: user, canEdit: url.searchParams.get('devRole') !== 'viewer' }
}

const http = createServer((req, res) => {
  if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
  res.writeHead(404).end()
})
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
const liveSockets = new Map<string, WebSocket>() // `${boardId}/${sid}` -> current ws

http.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = /^\/connect\/([^/]+)$/.exec(url.pathname)
  const boardId = m?.[1]
  const clientSessionId = url.searchParams.get('sessionId') // appended by useSync (TAB_ID)
  if (!boardId || !BOARD_ID_RE.test(boardId) || !clientSessionId || clientSessionId.length > 128) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    return void socket.destroy()
  }
  const auth = await authorize(url) // ALL async work happens before getOrCreate
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!auth) return ws.close(4099, 'NOT_AUTHENTICATED') // 4099 = terminal on the client (no retry loop)
    let room: ReturnType<RoomRegistry['getOrCreate']>
    try {
      room = registry.getOrCreate(boardId) // synchronous from here on
    } catch (e) {
      console.error('room open failed', boardId, e)
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
})

http.listen(PORT, HOST, () => console.log(`sync listening on ${HOST}:${PORT} (data: ${layout.root})`))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    registry.closeAll()
    http.close()
    process.exit(0)
  })
}
