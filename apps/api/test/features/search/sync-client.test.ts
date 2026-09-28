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

  it('turns a refusal or an unreachable server into SyncUnavailable', async () => {
    const { baseUrl } = await serve(() => ({ status: 503, body: { error: { code: 'SHUTTING_DOWN' } } }))
    const client = createHttpSyncInternalClient({ baseUrl, secret: 's'.repeat(40) })
    await expect(client.boardText?.('b-one')).rejects.toBeInstanceOf(SyncUnavailable)
    const gone = createHttpSyncInternalClient({ baseUrl: 'http://127.0.0.1:1', secret: 's'.repeat(40) })
    await expect(gone.boardText?.('b-one')).rejects.toBeInstanceOf(SyncUnavailable)
  })
})
