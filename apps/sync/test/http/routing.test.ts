import { newId } from '@draftroom/dev-assets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { req, startServer, type TestServer, upload, waitFor } from './helpers.ts'

let t: TestServer
beforeAll(async () => {
  t = await startServer()
})
afterAll(async () => {
  await t.stop()
})

describe('routing', () => {
  it('405 with Allow for wrong methods on every dev route', async () => {
    const ast = newId('ast')
    const ver = newId('ver')
    const cases: Array<[string, string, string]> = [
      ['GET', '/dev-api/boards/board-a/assets', 'POST'],
      ['PUT', '/dev-api/boards/board-a/assets', 'POST'],
      ['POST', `/dev-api/boards/board-a/assets/${ast}/${ver}`, 'GET, HEAD'],
      ['DELETE', `/files/${ast}/${ver}/original?board=board-a`, 'GET, HEAD'],
      ['POST', `/files/${ast}/${ver}/d/${newId('drv')}?board=board-a`, 'GET, HEAD'],
    ]
    for (const [method, path, allow] of cases) {
      const res = await req(t.port, { method, path, body: Buffer.alloc(0) })
      expect(res.status, `${method} ${path}`).toBe(405)
      expect(res.headers.allow).toBe(allow)
      expect(res.json()).toEqual({ error: { code: 'METHOD_NOT_ALLOWED', message: expect.any(String) } })
    }
  })

  it('unknown paths are JSON 404s; /healthz answers ok', async () => {
    const res = await req(t.port, { path: '/nope' })
    expect(res.status).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    const health = await req(t.port, { path: '/healthz' })
    expect(health.status).toBe(200)
    expect(health.body.toString()).toBe('ok')
  })

  it('logs one line per request with method, path without the query string, status and duration', async () => {
    t.logs.length = 0
    const res = await upload(t.port, { user: 'secret-user' })
    expect(res.status).toBe(201)
    await req(t.port, { path: '/files/x/y/original?board=board-a&token=abc' })
    await waitFor(() => t.logs.length >= 2)
    expect(t.logs[0]).toMatch(/^POST \/dev-api\/boards\/board-a\/assets 201 \d+(\.\d+)?ms$/)
    expect(t.logs[1]).toMatch(/^GET \/files\/x\/y\/original 404 \d+(\.\d+)?ms$/)
    for (const line of t.logs) {
      expect(line).not.toContain('?')
      expect(line).not.toContain('secret-user')
      expect(line).not.toContain('token')
    }
  })
})
