import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessUnavailableError, createApiAccessClient } from './access.ts'

const SECRET = 'internal-secret-for-this-unit-test-0123456789'

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

async function api(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

describe('createApiAccessClient', () => {
  it('asks GET /internal/access?boardId&userId with the internal secret and returns the role', async () => {
    const seen: Array<{ path: string | undefined; secret: unknown; method: string | undefined }> = []
    const base = await api((req, res) => {
      seen.push({ path: req.url, secret: req.headers['x-draftroom-internal'], method: req.method })
      const u = new URL(req.url ?? '/', 'http://x')
      json(res, 200, { role: u.searchParams.get('userId') === 'usr_gone' ? null : 'commenter' })
    })
    const client = createApiAccessClient({ baseUrl: base, internalSecret: SECRET })
    expect(await client.getRole('b-abcdefghij', 'usr_a&b=c')).toBe('commenter')
    expect(await client.getRole('b-abcdefghij', 'usr_gone')).toBeNull()
    expect(seen[0]).toEqual({
      method: 'GET',
      path: '/internal/access?boardId=b-abcdefghij&userId=usr_a%26b%3Dc', // encoded: no parameter injection
      secret: SECRET,
    })
  })

  it('anything but a 200 with { role } is "cannot tell" (throws), never "no access"', async () => {
    const answers: Array<[number, unknown]> = [
      [404, { error: { code: 'NOT_FOUND' } }], // e.g. a wrong DRAFTROOM_API_INTERNAL_URL path
      [401, { error: { code: 'UNAUTHORIZED' } }], // secret mismatch
      [500, { error: { code: 'INTERNAL' } }],
      [200, { role: 'superuser' }],
      [200, { nope: true }],
      [200, 'viewer'],
    ]
    let i = 0
    const base = await api((_req, res) => {
      const [status, body] = answers[i++] ?? [500, {}]
      json(res, status, body)
    })
    const client = createApiAccessClient({ baseUrl: base, internalSecret: SECRET })
    for (const [status, body] of answers)
      await expect(
        client.getRole('b-abcdefghij', 'usr_a'),
        `${status} ${JSON.stringify(body)}`,
      ).rejects.toThrow(AccessUnavailableError)
  })

  it('times out quickly on a hanging API and does not follow redirects (the secret stays put)', async () => {
    let redirected = false
    const base = await api((req, res) => {
      if (req.url?.startsWith('/elsewhere')) {
        redirected = true
        return json(res, 200, { role: 'owner' })
      }
      if (req.url?.includes('userId=redirect')) {
        res.writeHead(302, { location: '/elsewhere' }).end()
        return
      }
      // hang: never answer
    })
    const client = createApiAccessClient({ baseUrl: base, internalSecret: SECRET, timeoutMs: 200 })
    const started = Date.now()
    await expect(client.getRole('b-abcdefghij', 'usr_a')).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(2_000)
    await expect(client.getRole('b-abcdefghij', 'redirect')).rejects.toThrow(AccessUnavailableError)
    expect(redirected).toBe(false)
  })

  it('an unreachable API throws AccessUnavailableError', async () => {
    const client = createApiAccessClient({
      baseUrl: 'http://127.0.0.1:9',
      internalSecret: SECRET,
      timeoutMs: 3_000,
    })
    await expect(client.getRole('b-abcdefghij', 'usr_a')).rejects.toThrow(AccessUnavailableError)
  })
})
