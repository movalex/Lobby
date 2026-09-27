import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpSyncNotifier } from '../src/notifier.ts'

interface Received {
  method?: string
  url?: string
  secret?: string | string[]
  contentType?: string
  body: unknown
}

let server: Server | null = null
afterEach(async () => {
  const s = server
  server = null
  if (s) await new Promise<void>((r) => s.close(() => r()))
})

async function fakeSync(status: number, delayMs = 0): Promise<{ baseUrl: string; received: Received[] }> {
  const received: Received[] = []
  server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
    })
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        secret: req.headers[INTERNAL_SECRET_HEADER],
        contentType: req.headers['content-type'],
        body: JSON.parse(raw),
      })
      setTimeout(() => res.writeHead(status).end(), delayMs)
    })
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, received }
}

const SECRET = 'test-internal-secret-0123456789abcdefghij'

describe('HTTP sync notifier', () => {
  it('POSTs {boardId, userId?} to /internal/access-changed with the internal secret', async () => {
    const sync = await fakeSync(204)
    const warnings: object[] = []
    const n = createHttpSyncNotifier({
      baseUrl: sync.baseUrl,
      secret: SECRET,
      log: { warn: (o) => warnings.push(o) },
    })
    n.accessChanged({ boardId: 'b-abcdefghij', userId: 'usr_00000000000000000001' })
    n.accessChanged({ boardId: 'b-abcdefghij' })
    await n.drain()
    expect(sync.received).toEqual([
      {
        method: 'POST',
        url: '/internal/access-changed',
        secret: SECRET,
        contentType: 'application/json',
        body: { boardId: 'b-abcdefghij', userId: 'usr_00000000000000000001' },
      },
      expect.objectContaining({ body: { boardId: 'b-abcdefghij' } }),
    ])
    expect(warnings).toEqual([])
  })

  it('logs (never throws) when sync refuses, is down or is slow; logs carry no secret', async () => {
    const warnings: object[] = []
    const log = { warn: (o: object) => warnings.push(o) }

    const refusing = await fakeSync(401)
    const a = createHttpSyncNotifier({ baseUrl: refusing.baseUrl, secret: SECRET, log })
    a.accessChanged({ boardId: 'b-abcdefghij' })
    await a.drain()

    const down = createHttpSyncNotifier({
      baseUrl: 'http://127.0.0.1:9',
      secret: SECRET,
      log,
      // Generous: a refused connection can take a couple of seconds to surface on Windows.
      timeoutMs: 5_000,
    })
    expect(() => down.accessChanged({ boardId: 'b-abcdefghij' })).not.toThrow()
    await down.drain()

    await new Promise<void>((r) => server?.close(() => r()))
    server = null
    const slow = await fakeSync(204, 2_000)
    const c = createHttpSyncNotifier({ baseUrl: slow.baseUrl, secret: SECRET, log, timeoutMs: 100 })
    const started = Date.now()
    c.accessChanged({ boardId: 'b-abcdefghij' })
    await c.drain()
    expect(Date.now() - started).toBeLessThan(1_500)

    expect(warnings).toEqual([
      { boardId: 'b-abcdefghij', status: 401 },
      { boardId: 'b-abcdefghij', reason: 'unreachable' },
      { boardId: 'b-abcdefghij', reason: 'timeout' },
    ])
    expect(JSON.stringify(warnings)).not.toContain(SECRET)
  })
})
