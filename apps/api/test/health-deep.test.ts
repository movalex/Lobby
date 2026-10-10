// Wave M, M5-6 (CAP-ALERTS, S8): GET /healthz/deep means something. 200 'ok' when the database answers, the api
// is not throwing 5xx and the AI provider mostly works; otherwise 503 with the reason codes and nothing else.
// GET /healthz stays a liveness answer (Render's healthCheckPath), and GET / answers 204 (the deploy probe).
import type { Db, Queryable } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createHealth, HEALTH_DEEP_ROUTE } from '../src/health.ts'
import { createTestApi, type TestApi } from './helpers.ts'

/**
 * A database that can go down: every query after `down = true` fails (or hangs, with `hang`). `failing`: only the
 * statements it matches fail (a route that answers 500 while SELECT 1 still works).
 */
function switchableDb(base: Db) {
  const state = { down: false, hang: false, queries: 0, failing: null as RegExp | null }
  const gate = <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    if (state.failing?.test(sql)) return Promise.reject(new Error('statement failed'))
    if (!state.down) return run()
    state.queries++
    if (state.hang) return new Promise<T>(() => {})
    return Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
  }
  const db: Db = {
    ...base,
    query: (sql, params) => gate(sql, () => base.query(sql, params)),
    one: (sql, params) => gate(sql, () => base.one(sql, params)),
    maybeOne: (sql, params) => gate(sql, () => base.maybeOne(sql, params)),
    transaction: (fn) => gate('BEGIN', () => base.transaction(fn)),
  }
  return { db, state }
}

let api: TestApi | null = null
let base: Db | null = null
afterEach(async () => {
  await api?.close()
  api = null
  await base?.close()
  base = null
})

describe('GET /healthz/deep (the api)', () => {
  it('is 200 ok, as plain text, when all is well; /healthz stays a static ok', async () => {
    api = await createTestApi({ deps: { health: { dbCacheMs: 0 } } })
    const res = await api.anon('GET', HEALTH_DEEP_ROUTE)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toBe('ok')
    expect((await api.anon('GET', '/healthz')).body).toBe('ok')
  })

  it('a database that is down gives 503 "db" (and /healthz still answers ok)', async () => {
    base = await openTestDb()
    const sw = switchableDb(base)
    api = await createTestApi({ db: sw.db, deps: { health: { dbCacheMs: 0 } } })
    sw.state.down = true
    const res = await api.anon('GET', HEALTH_DEEP_ROUTE)
    expect(res.statusCode).toBe(503)
    expect(res.body).toBe('db')
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    // liveness does not depend on the database: Render keeps the process
    expect((await api.anon('GET', '/healthz')).statusCode).toBe(200)
    sw.state.down = false
    expect((await api.anon('GET', HEALTH_DEEP_ROUTE)).body).toBe('ok')
  })

  it('a database that hangs gives 503 "db" after the probe timeout, with one query in flight however often it is asked', async () => {
    base = await openTestDb()
    const sw = switchableDb(base)
    api = await createTestApi({ db: sw.db, deps: { health: { dbCacheMs: 0, dbTimeoutMs: 50 } } })
    sw.state.down = true
    sw.state.hang = true
    const started = Date.now()
    const answers = await Promise.all([1, 2, 3].map(() => api?.anon('GET', HEALTH_DEEP_ROUTE)))
    expect(Date.now() - started).toBeLessThan(2_000)
    for (const r of answers) expect([r?.statusCode, r?.body]).toEqual([503, 'db'])
    expect((await api.anon('GET', HEALTH_DEEP_ROUTE)).body).toBe('db')
    expect(sw.state.queries).toBe(1) // single flight: the hung SELECT 1 is the only one
  })

  it('a burst of more than 5 5xx answers in 5 minutes gives 503 "5xx", and it clears after the window', async () => {
    base = await openTestDb()
    const sw = switchableDb(base)
    api = await createTestApi({ db: sw.db, deps: { health: { dbCacheMs: 0 } } })
    const t = api
    const alice = await t.login('alice')
    // the members list fails with a 500 when its role read fails (SELECT 1 still answers)
    sw.state.failing = /^SELECT role FROM workspace_members WHERE workspace_id = \$1 AND user_id = \$2$/
    const failing = () => alice.req('GET', `/api/workspaces/${alice.personalWorkspaceId}/members`)
    expect((await failing()).statusCode).toBe(500)
    for (let i = 0; i < 4; i++) await failing()
    expect((await t.anon('GET', HEALTH_DEEP_ROUTE)).body).toBe('ok') // 5 is not more than 5
    await failing()
    const res = await t.anon('GET', HEALTH_DEEP_ROUTE)
    expect([res.statusCode, res.body]).toEqual([503, '5xx'])
    // the monitor's own 503s are not counted
    for (let i = 0; i < 10; i++) await t.anon('GET', HEALTH_DEEP_ROUTE)
    t.clock.advance(5 * 60_000 + 1)
    expect((await t.anon('GET', HEALTH_DEEP_ROUTE)).body).toBe('ok')
  }, 30_000)

  it('the body names the reasons only, in a fixed order, comma-separated', async () => {
    base = await openTestDb()
    const sw = switchableDb(base)
    api = await createTestApi({ db: sw.db, deps: { health: { dbCacheMs: 0, serverErrorsMax: 0 } } })
    const alice = await api.login('alice')
    sw.state.down = true
    // a 500 (the database is down: any route that reads it fails)
    expect((await alice.req('GET', '/api/me')).statusCode).toBe(500)
    const res = await api.anon('GET', HEALTH_DEEP_ROUTE)
    expect([res.statusCode, res.body]).toEqual([503, 'db,5xx'])
  })
})

describe('GET / (the deploy probe, S8)', () => {
  it('answers 204 with no body, for anyone', async () => {
    api = await createTestApi()
    const res = await api.anon('GET', '/')
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect((await api.app.inject({ method: 'HEAD', url: '/' })).statusCode).toBe(204)
  })
})

describe('createHealth (the counters)', () => {
  const okDb: Pick<Queryable, 'query'> = { query: async () => ({ rows: [], rowCount: 0 }) }
  const clock = () => {
    let t = 1_000_000
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  it('AI: over half of at least 3 provider calls in 15 minutes failing gives "ai"; refusals are no calls', async () => {
    const c = clock()
    const h = createHealth({ db: okDb, now: c.now, options: { dbCacheMs: 0 } })
    const run = 'POST'
    h.record(run, '/api/boards/:bid/ai/run', 502)
    h.record(run, '/api/boards/:bid/ai/run', 504)
    expect(await h.reasons()).toEqual([]) // 2 calls: too few to judge
    // refusals before the provider: not calls
    for (const s of [403, 429, 503, 400]) h.record(run, '/api/boards/:bid/ai/run', s)
    expect(await h.reasons()).toEqual([])
    h.record(run, '/api/boards/:bid/ai/run', 200)
    expect(await h.reasons()).toEqual(['ai']) // 2 of 3 failed
    h.record(run, '/api/workspaces/:wid/ai/ask', 200)
    expect(await h.reasons()).toEqual([]) // 2 of 4: not over half
    h.record(run, '/api/workspaces/:wid/ai/ask', 502)
    expect(await h.reasons()).toEqual(['ai']) // 3 of 5
    // the AI status read and other routes are not provider calls
    for (let i = 0; i < 5; i++) h.record('GET', '/api/boards/:bid/ai', 200)
    expect(await h.reasons()).toEqual(['ai'])
    c.advance(15 * 60_000 + 1)
    expect(await h.reasons()).toEqual([])
  })

  it('5xx: more than the limit within the window; the deep route itself never counts', async () => {
    const c = clock()
    const h = createHealth({ db: okDb, now: c.now, options: { dbCacheMs: 0 } })
    for (let i = 0; i < 20; i++) h.record('GET', HEALTH_DEEP_ROUTE, 503)
    expect(await h.reasons()).toEqual([])
    for (let i = 0; i < 5; i++) h.record('GET', '/api/me', 500)
    expect(await h.reasons()).toEqual([])
    c.advance(60_000)
    h.record('GET', undefined, 502)
    expect(await h.reasons()).toEqual(['5xx'])
    c.advance(4 * 60_000) // the first five are now 5 minutes old
    expect(await h.reasons()).toEqual([])
  })

  it('the database probe is kept for its cache window (one query per window)', async () => {
    const c = clock()
    let n = 0
    const db: Pick<Queryable, 'query'> = {
      query: async () => {
        n++
        return { rows: [], rowCount: 0 }
      },
    }
    const h = createHealth({ db, now: c.now })
    await h.reasons()
    await h.reasons()
    expect(n).toBe(1)
    c.advance(5_001)
    await h.reasons()
    expect(n).toBe(2)
  })
})
