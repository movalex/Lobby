// AUDIT-INTERNAL-SCOPE (A6): every route under /internal is refused without the shared internal secret by
// ONE root hook (app.ts registerInternalSecretGuard), not by a check in each handler:
// - a route that forgets the check is still refused (the guard on a bare Fastify instance);
// - every /internal route the real app registers answers 401 without the secret, with a wrong one, with a
//   ticket secret and with a browser session cookie, and is reached with the right one (the list comes
//   from the app's own route table, so a route added later is covered without editing this test).

import { SYNC_INTERNAL_ERROR_STATUS } from '@draftroom/contracts'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerInternalSecretGuard } from '../src/app.ts'
import { createTestApi, INTERNAL_SECRET, ORIGIN, type TestApi, TICKET_SECRET } from './helpers.ts'

const HEADER = 'x-draftroom-internal'

describe('the internal secret guard (a bare Fastify instance)', () => {
  let app: FastifyInstance
  let reached: string[]
  beforeEach(async () => {
    reached = []
    app = Fastify()
    registerInternalSecretGuard(app, INTERNAL_SECRET)
    // Routes that never look at the secret themselves: the guard alone protects them.
    const handler = (name: string) => async () => {
      reached.push(name)
      return { ok: true }
    }
    app.get('/internal/forgot', handler('GET /internal/forgot'))
    app.post('/internal/forgot-post', handler('POST /internal/forgot-post'))
    app.get('/internal/deep/:id/route', handler('GET deep'))
    app.get('/internalish', async () => ({ ok: true }))
    app.get('/api/public', async () => ({ ok: true }))
    await app.ready()
  })
  afterEach(() => app.close())

  it('refuses an /internal route without the secret before its handler runs: 401 NOT_AUTHENTICATED', async () => {
    for (const [method, url] of [
      ['GET', '/internal/forgot'],
      ['HEAD', '/internal/forgot'],
      ['POST', '/internal/forgot-post'],
      ['GET', '/internal/deep/abc/route'],
    ] as const) {
      for (const headers of [
        {},
        { [HEADER]: 'x'.repeat(INTERNAL_SECRET.length) },
        { [HEADER]: TICKET_SECRET },
        { [HEADER]: '' },
        { cookie: 'dr_session=abc', origin: ORIGIN },
        { authorization: `Bearer ${INTERNAL_SECRET}` },
      ]) {
        const res = await app.inject({ method, url, headers })
        expect({ method, url, headers, status: res.statusCode }).toEqual({
          method,
          url,
          headers,
          status: 401,
        })
        if (method !== 'HEAD')
          expect(res.json()).toEqual({
            error: { code: 'NOT_AUTHENTICATED', message: 'Internal credentials required.' },
          })
      }
    }
    expect(reached).toEqual([])
  })

  it('lets a request with the secret through to the handler', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/internal/forgot', headers: { [HEADER]: INTERNAL_SECRET } }))
        .statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/forgot-post',
          headers: { [HEADER]: INTERNAL_SECRET },
        })
      ).statusCode,
    ).toBe(200)
    expect(reached).toEqual(['GET /internal/forgot', 'POST /internal/forgot-post'])
  })

  it('guards by the matched route pattern: other routes, and names that only start like /internal, are not touched', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/public' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/internalish' })).statusCode).toBe(200)
    // An unknown path under /internal matches no route: the plain 404, never a way to read a handler.
    expect((await app.inject({ method: 'GET', url: '/internal/nope' })).statusCode).toBe(404)
  })
})

/**
 * Every route of the app with its methods, from Fastify's printed route table
 * (`printRoutes({ commonPrefix: false })`: a tree whose children carry only their own segment).
 */
function registeredRoutes(app: FastifyInstance): { path: string; methods: string[] }[] {
  const out: { path: string; methods: string[] }[] = []
  const stack: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+) \(([^)]*)\)\s*$/.exec(line)
    if (!m) continue
    const depth = (m[1] ?? '').length / 4
    stack.length = depth
    stack[depth] = m[2] ?? ''
    out.push({ path: stack.join(''), methods: (m[3] ?? '').split(', ') })
  }
  return out
}

const fill = (path: string) =>
  path.replace(':bid', 'b-0123456789').replace(':runId', 'run_0123456789abcdef').replace(/:\w+/g, 'x')

describe('every /internal route of the app', () => {
  let api: TestApi
  beforeEach(async () => {
    api = await createTestApi()
  })
  afterEach(() => api.close())

  it('is found in the route table (the sync server and cut-over routes), so this test sees a route that is added later', () => {
    const internal = registeredRoutes(api.app)
      .filter((r) => r.path.startsWith('/internal'))
      .map((r) => r.path)
    expect(internal).toEqual(
      expect.arrayContaining([
        '/internal/access',
        '/internal/boards/:bid/touched',
        '/internal/boards/:bid/session-ended',
        '/internal/boards/:bid/file-refs',
        '/internal/boards/:bid/workshop-state',
        '/internal/checkpoints/run-all',
        '/internal/checkpoints/run-all/:runId',
        '/internal/checkpoints/engine-migration',
        '/internal/checkpoints/engine-migration/:runId',
      ]),
    )
  })

  it('answers 401 without the secret, with a wrong one, with a ticket secret and with a session cookie', async () => {
    const alice = await api.login('alice')
    const routes = registeredRoutes(api.app).filter((r) => r.path.startsWith('/internal'))
    expect(routes.length).toBeGreaterThanOrEqual(9)
    let checked = 0
    for (const { path, methods } of routes) {
      for (const method of methods) {
        for (const headers of [
          { origin: ORIGIN },
          { origin: ORIGIN, [HEADER]: 'x'.repeat(INTERNAL_SECRET.length) },
          { origin: ORIGIN, [HEADER]: TICKET_SECRET },
          { origin: ORIGIN, cookie: alice.cookie },
          { [HEADER]: TICKET_SECRET }, // no Origin either: the secret is the first check, not the CSRF one
        ]) {
          const res = await api.app.inject({ method: method as 'GET', url: fill(path), headers })
          expect({ method, path, status: res.statusCode }).toEqual({ method, path, status: 401 })
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(40)
  })

  it('answers the two engine routes in their contract shape (401 bad-secret), the others with NOT_AUTHENTICATED', async () => {
    expect(SYNC_INTERNAL_ERROR_STATUS['bad-secret']).toBe(401)
    const engine = await api.app.inject({
      method: 'GET',
      url: '/internal/boards/b-0123456789/workshop-state',
    })
    expect(engine.statusCode).toBe(401)
    expect(engine.json()).toEqual({
      error: { code: 'bad-secret', message: 'Internal credentials required.' },
    })
    const other = await api.app.inject({ method: 'GET', url: '/internal/access' })
    expect(other.json()).toEqual({
      error: { code: 'NOT_AUTHENTICATED', message: 'Internal credentials required.' },
    })
    // Carrying no cookie authority: a signed-in session that sends no secret still gets nothing.
    expect(other.cookies).toEqual([])
  })

  it('reaches the handler with the right secret (every GET route answers something other than 401)', async () => {
    const routes = registeredRoutes(api.app).filter((r) => r.path.startsWith('/internal'))
    for (const { path, methods } of routes) {
      if (!methods.includes('GET')) continue
      const res = await api.app.inject({
        method: 'GET',
        url: fill(path),
        headers: { [HEADER]: INTERNAL_SECRET },
      })
      expect({ path, status: res.statusCode, unauthorised: res.statusCode === 401 }).toEqual({
        path,
        status: res.statusCode,
        unauthorised: false,
      })
    }
  })
})
