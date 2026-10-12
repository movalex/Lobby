// The api -> sync board-text call (sync-internal.ts boardText) against a local HTTP server.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpSyncInternalClient, SyncUnavailable } from '../../../src/sync-internal.ts'

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

async function serve(answer: (req: IncomingMessage) => { status: number; body: unknown }) {
  const seen: { url: string; secret: string | undefined; method: string }[] = []
  server = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      secret: req.headers[INTERNAL_SECRET_HEADER] as string | undefined,
      method: req.method ?? '',
    })
    const { status, body } = answer(req)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  return { seen, baseUrl: `http://127.0.0.1:${port}` }
}

describe('sync internal client: boardText', () => {
  it('asks GET /internal/boards/:bid/text with the secret, since and maxBytes', async () => {
    const { seen, baseUrl } = await serve(() => ({
      status: 200,
      body: { boardId: 'b-one', clock: 7, unchanged: true },
    }))
    const client = createHttpSyncInternalClient({ baseUrl, secret: 's'.repeat(40) })
    expect(await client.boardText?.('b-one', { since: 7, maxBytes: 1000 })).toEqual({
      boardId: 'b-one',
      clock: 7,
      unchanged: true,
    })
    await client.boardText?.('b-one')
    expect(seen).toEqual([
      { url: '/internal/boards/b-one/text?since=7&maxBytes=1000', secret: 's'.repeat(40), method: 'GET' },
      { url: '/internal/boards/b-one/text', secret: 's'.repeat(40), method: 'GET' },
    ])
  })

  it('wave N (N7-4): asks for the board links with ?links=1 only when told to', async () => {
    const { seen, baseUrl } = await serve(() => ({
      status: 200,
      body: { boardId: 'b-one', clock: 7, unchanged: true },
    }))
    const client = createHttpSyncInternalClient({ baseUrl, secret: 's'.repeat(40) })
    await client.boardText?.('b-one', { maxBytes: 1000, links: true })
    await client.boardText?.('b-one', { since: 3, links: false })
    expect(seen.map((s) => s.url)).toEqual([
      '/internal/boards/b-one/text?maxBytes=1000&links=1',
      '/internal/boards/b-one/text?since=3',
    ])
  })

  it('turns a refusal or an unreachable server into SyncUnavailable', async () => {
    const { baseUrl } = await serve(() => ({ status: 503, body: { error: { code: 'SHUTTING_DOWN' } } }))
    const client = createHttpSyncInternalClient({ baseUrl, secret: 's'.repeat(40) })
    await expect(client.boardText?.('b-one')).rejects.toBeInstanceOf(SyncUnavailable)
    const gone = createHttpSyncInternalClient({ baseUrl: 'http://127.0.0.1:1', secret: 's'.repeat(40) })
    await expect(gone.boardText?.('b-one')).rejects.toBeInstanceOf(SyncUnavailable)
  })
})

// Wave N.1 ("one clock"): the sync's time for the visit markers (src/sync-clock.ts measures the offset).
describe('sync internal client: clock', () => {
  it('asks GET /internal/clock with the secret and answers the sync’s ms', async () => {
    const { seen, baseUrl } = await serve(() => ({ status: 200, body: { now: 1_800_000_000_123 } }))
    const client = createHttpSyncInternalClient({ baseUrl, secret: 's'.repeat(40) })
    expect(await client.clock?.()).toBe(1_800_000_000_123)
    expect(seen).toEqual([{ url: '/internal/clock', secret: 's'.repeat(40), method: 'GET' }])
  })

  it('an older sync (404), a failure or an answer that is not a time: SyncUnavailable', async () => {
    for (const [status, body] of [
      [404, { error: { code: 'NOT_FOUND' } }],
      [500, {}],
      [200, { now: 'soon' }],
      [200, { now: 1.5 }],
      [200, {}],
    ] as const) {
      const { baseUrl } = await serve(() => ({ status, body }))
      const client = createHttpSyncInternalClient({ baseUrl, secret: 's'.repeat(40) })
      await expect(client.clock?.(), JSON.stringify(body)).rejects.toBeInstanceOf(SyncUnavailable)
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
      server = null
    }
  })
})
