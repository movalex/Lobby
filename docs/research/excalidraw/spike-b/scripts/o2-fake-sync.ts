// O2's dev-only stand-in for the sync server (spike B, before O1's room lands): the engine core's
// protocol fake (apps/web/src/canvas/sync/testing/fakeRoom.ts) behind a real WebSocket endpoint
// `/connect/:boardId?sessionId=…&ticket=…`, with the real ticket check (the api's DRAFTROOM_TICKET_SECRET),
// the binary gzip snapshot frame, `/healthz`, and the test snapshot route. It is NOT the room: no
// server-derived arrows, no stage 0, no persistence. It exists so the board page can be smoke-tested
// end to end; every spike B check runs against O1's real room.
//
//   DRAFTROOM_TICKET_SECRET=… DRAFTROOM_INTERNAL_SECRET=… node docs/research/excalidraw/spike-b/scripts/o2-fake-sync.ts 7870
//
// Ports: O2's range only (7870-7879).
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const imp = (p: string) => import(pathToFileURL(join(ROOT, p)).href)

const { WebSocketServer } = await imp('apps/sync/node_modules/ws/wrapper.mjs')
const { verifyTicket, checkInternalSecret, INTERNAL_SECRET_HEADER } = await imp('packages/auth-tickets/src/index.ts')
const { FakeRoom } = await imp('apps/web/src/canvas/sync/testing/fakeRoom.ts')
const { encodeSnapshotFrame } = await imp('packages/canvas-schema/src/protocol.ts')

const port = Number(process.argv[2] ?? 7870)
if (port < 7870 || port > 7879) throw new Error('O2 uses ports 7870-7879 only')
const secret = process.env.DRAFTROOM_TICKET_SECRET ?? ''
const internal = process.env.DRAFTROOM_INTERNAL_SECRET ?? ''
if (!secret) throw new Error('DRAFTROOM_TICKET_SECRET is required')

const realClock = {
  now: () => Date.now(),
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
// biome-ignore lint/suspicious/noExplicitAny: a dev script over the fake's untyped import
const rooms = new Map<string, any>()
const roomFor = (bid: string) => {
  let r = rooms.get(bid)
  if (!r) {
    r = new FakeRoom({ clock: realClock, strict: true })
    rooms.set(bid, r)
  }
  return r
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/healthz') {
    res.writeHead(200).end('ok')
    return
  }
  const m = /^\/internal\/test\/boards\/([^/]+)\/snapshot$/.exec(url.pathname)
  if (m && req.method === 'GET') {
    if (!checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], internal)) {
      res.writeHead(401).end()
      return
    }
    const room = roomFor(decodeURIComponent(m[1] as string))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ clock: room.clock, epoch: room.epoch, horizon: room.horizon, elements: room.snapshot() }))
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const m = /^\/connect\/([^/]+)$/.exec(url.pathname)
  const bid = m ? decodeURIComponent(m[1] as string) : ''
  const v = verifyTicket(secret, url.searchParams.get('ticket'), { boardId: bid })
  if (!m || !v.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  const claims = v.claims
  const tab = url.searchParams.get('sessionId') ?? 'tab'
  wss.handleUpgrade(req, socket, head, (ws: {
    send(d: unknown): void
    close(c?: number, r?: string): void
    on(e: string, f: (...a: unknown[]) => void): void
  }) => {
    const room = roomFor(bid)
    const t = room.connect({
      uid: claims.uid,
      name: claims.name,
      tab,
      readonly: claims.role === 'viewer' || claims.role === 'commenter',
    })
    t.onMessage((msg: { type: string }) => {
      if (process.env.O2_FAKE_SYNC_DEBUG) console.log('send', msg.type)
      if (msg.type === 'snapshot') void encodeSnapshotFrame(msg).then((b: Uint8Array) => ws.send(b))
      else ws.send(JSON.stringify(msg))
    })
    t.onState((s: string, c?: { code: number; reason: string }) => {
      if (s === 'closed' && c && c.code !== 1006) ws.close(c.code, c.reason)
    })
    ws.on('message', (data: unknown) => {
      if (process.env.O2_FAKE_SYNC_DEBUG) console.log('recv', String(data).slice(0, 80), t.state)
      try {
        t.send(JSON.parse(String(data)))
      } catch {
        ws.close(4099, 'INVALID_MESSAGE')
      }
    })
    ws.on('close', () => t.drop())
  })
})

server.listen(port, '127.0.0.1', () => console.log(`o2 fake sync listening on 127.0.0.1:${port}`))
