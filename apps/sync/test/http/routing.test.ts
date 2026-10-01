import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mintTicket, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { req, startServer, type TestServer, waitFor } from './helpers.ts'

let t: TestServer
beforeAll(async () => {
  t = await startServer()
})
afterAll(async () => {
  await t.stop()
})

const secret = { 'x-draftroom-internal': TEST_INTERNAL_SECRET }

describe('routing', () => {
  it('405 with Allow for wrong methods on every internal route', async () => {
    const cases: Array<[string, string, string]> = [
      ['GET', '/internal/access-changed', 'POST'],
      ['PUT', '/internal/access-changed', 'POST'],
      ['POST', '/internal/boards/board-a/snapshot', 'GET'],
      ['DELETE', '/internal/boards/board-a/snapshot', 'GET'],
      ['GET', '/internal/boards/board-a/seed', 'POST'],
    ]
    for (const [method, path, allow] of cases) {
      const res = await req(t.port, { method, path, headers: secret, body: Buffer.alloc(0) })
      expect(res.status, `${method} ${path}`).toBe(405)
      expect(res.headers.allow).toBe(allow)
      expect(res.json()).toEqual({ error: { code: 'METHOD_NOT_ALLOWED', message: expect.any(String) } })
    }
  })

  it('the internal surface answers 401 to anyone without the secret, before revealing any route', async () => {
    for (const [method, path] of [
      ['POST', '/internal/access-changed'],
      ['GET', '/internal/boards/board-a/snapshot'],
      ['POST', '/internal/boards/board-a/seed'],
      ['GET', '/internal/nope'], // unknown internal path: still 401, not 404
      ['DELETE', '/internal/boards/board-a/seed'], // wrong method: still 401, not 405
      ['GET', '/internal'],
    ] as const) {
      const variants: Record<string, string>[] = [
        {},
        { 'x-draftroom-internal': 'wrong' },
        { 'x-draftroom-internal': '' },
      ]
      for (const headers of variants) {
        const res = await req(t.port, { method, path, headers, body: Buffer.alloc(0) })
        expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401)
        expect(res.json().error.code).toBe('UNAUTHORIZED')
      }
    }
  })

  it('unknown paths are JSON 404s; the M0 dev file routes are gone; /healthz answers ok', async () => {
    for (const [method, path] of [
      ['GET', '/nope'],
      ['POST', '/dev-api/boards/board-a/assets?devUser=alice'],
      ['GET', '/dev-api/boards/board-a/assets/ast_0123456789/ver_0123456789'],
      ['GET', '/files/ast_0123456789/ver_0123456789/original?board=board-a'],
      ['GET', '/internal/nope'],
    ] as const) {
      const res = await req(t.port, { method, path, headers: secret, body: Buffer.alloc(0) })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.json().error.code).toBe('NOT_FOUND')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    }
    const health = await req(t.port, { path: '/healthz' })
    expect(health.status).toBe(200)
    expect(health.body.toString()).toBe('ok')
  })

  it('logs one line per request (method, path without the query string, status, duration) and never a ticket', async () => {
    t.logs.length = 0
    const ticket = mintTicket('board-other', 'secret-user')
    await req(t.port, {
      path: `/internal/boards/board-a/snapshot?ticket=${ticket}&token=abc`,
      headers: secret,
    })
    await req(t.port, { path: `/files/x/y/original?board=board-a&token=abc` })
    // a refused connection (ticket for another board) is logged by reason, without the ticket
    const ws = new WebSocket(`${t.wsUrl}/connect/board-a?sessionId=tab1&ticket=${ticket}`)
    await new Promise((resolve) => {
      ws.onclose = resolve
    })
    await waitFor(() => t.logs.length >= 3)
    expect(t.logs[0]).toMatch(/^GET \/internal\/boards\/board-a\/snapshot 404 \d+(\.\d+)?ms$/) // no such board
    expect(t.logs[1]).toMatch(/^GET \/files\/x\/y\/original 404 \d+(\.\d+)?ms$/)
    expect(t.logs).toContainEqual(expect.stringMatching(/refused on board board-a: wrong_board/))
    for (const line of t.logs) {
      expect(line).not.toContain('?')
      expect(line).not.toContain(ticket)
      expect(line).not.toContain(ticket.split('.')[2] ?? '(none)') // not even the signature
      expect(line).not.toContain('secret-user')
      expect(line).not.toContain('token')
      expect(line).not.toContain(TEST_INTERNAL_SECRET)
    }
  })
})
