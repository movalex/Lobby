// Who may call /api/worker/* (docs/M3-STORAGE-CONTRACTS.md §4, §7): the Bearer worker token and nobody
// else; no browser sessions; exempt from the Origin check (browser routes keep it); rate-limited per
// token; and nothing secret ever reaches the logs.

import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ORIGIN, WORKER_TOKEN } from '../helpers.ts'
import { claim, pathOf, putBlob, reserve, type WorkerEnv, workerEnv } from './helpers.ts'

let env: WorkerEnv | null = null
afterEach(async () => {
  await env?.close()
  env = null
})

const VER = 'ver_ZZZZZZZZZZZZZZZZZZZZ'
const ROUTES: Array<[string, Record<string, unknown>]> = [
  ['/api/worker/claim', { workerId: 'w' }],
  [`/api/worker/jobs/${VER}/heartbeat`, { workerId: 'w' }],
  [
    `/api/worker/jobs/${VER}/derivatives`,
    { workerId: 'w', role: 'thumb', mimeType: 'image/webp', width: 1, height: 1, bytes: 1 },
  ],
  [`/api/worker/jobs/${VER}/complete`, { workerId: 'w', status: 'ready' }],
  [`/api/worker/jobs/${VER}/retry`, { workerId: 'w' }],
]

describe('worker token', () => {
  it('missing, malformed or wrong tokens are 401 on every protocol route, before the body is looked at', async () => {
    env = await workerEnv()
    await env.upload()
    const bad: Array<Record<string, string | undefined>> = [
      { authorization: undefined },
      { authorization: '' },
      { authorization: WORKER_TOKEN }, // no scheme
      { authorization: `Basic ${WORKER_TOKEN}` },
      { authorization: `Bearer ${WORKER_TOKEN}x` },
      { authorization: `Bearer ${WORKER_TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${'x'.repeat(WORKER_TOKEN.length)}` },
      { authorization: 'Bearer' },
    ]
    for (const [url, body] of ROUTES)
      for (const headers of bad) {
        const res = await env.worker('POST', url, body, headers)
        expect(res.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(401)
        expect(res.json()).toEqual({ error: { code: 'NOT_AUTHENTICATED', message: expect.any(String) } })
        expect(res.headers['www-authenticate']).toBe('Bearer')
      }
    // even a malformed body answers 401 first: nothing is parsed for strangers
    const junk = await env.worker('POST', '/api/worker/claim', '{not json', {
      authorization: undefined,
      'content-type': 'application/json',
    })
    expect(junk.statusCode).toBe(401)
    // and nothing was claimed by any of that
    const job = await env.api.db.one<{ status: string }>('SELECT status FROM preview_jobs')
    expect(job.status).toBe('queued')
  })

  it('the scheme is case-insensitive and the right token works', async () => {
    env = await workerEnv()
    const res = await env.worker(
      'POST',
      '/api/worker/claim',
      { workerId: 'w' },
      { authorization: `bearer ${WORKER_TOKEN}` },
    )
    expect(res.statusCode).toBe(204)
  })

  it('refuses any request that carries a cookie, even with the right token (a browser can never use them)', async () => {
    env = await workerEnv()
    for (const cookie of [env.bob.cookie, 'dr_session=abc', 'theme=dark', `${env.bob.cookie}; other=1`]) {
      for (const [url, body] of ROUTES) {
        const res = await env.worker('POST', url, body, { cookie })
        expect(res.statusCode, `${url} ${cookie}`).toBe(403)
        expect(res.json().error.code).toBe('FORBIDDEN')
      }
    }
  })
})

describe('Origin check', () => {
  it('is not required on worker routes (no Origin, or any Origin), but still is on browser routes', async () => {
    env = await workerEnv()
    const m = await env.upload()
    // worker: no Origin header at all
    const c = await claim(env)
    expect(c?.job.versionId).toBe(m.versionId)
    const withOrigin = await env.worker(
      'POST',
      `/api/worker/jobs/${m.versionId}/heartbeat`,
      { workerId: 'worker-a' },
      { origin: 'https://evil.example' },
    )
    expect(withOrigin.statusCode).toBe(200)
    // browser routes: a mutation without our Origin is refused before anything else
    const noOrigin = await env.api.app.inject({
      method: 'POST',
      url: `/api/boards/${env.board}/assets`,
      headers: { cookie: env.bob.cookie, 'content-type': 'image/png', 'x-file-name': 'a.png' },
      payload: Buffer.from('abc'),
    })
    expect(noOrigin.statusCode).toBe(403)
    const foreign = await env.api.app.inject({
      method: 'POST',
      url: '/api/workspaces/wsp_DevStudio00000000000/boards',
      headers: { cookie: env.bob.cookie, origin: 'https://evil.example' },
      payload: { title: 'x' },
    })
    expect(foreign.statusCode).toBe(403)
    // the exemption follows the MATCHED route, not the URL text
    for (const url of [
      '/api/worker/../boards/x/trash',
      '/api/worker/claim/../../boards/x/trash',
      '/api/workerx/claim',
    ]) {
      const res = await env.api.app.inject({ method: 'POST', url, headers: { cookie: env.bob.cookie } })
      expect([403, 404], url).toContain(res.statusCode)
      expect(
        res.statusCode === 404 || res.json().error.message === 'Cross-origin request refused.',
        url,
      ).toBe(true)
    }
    // and a worker token does not make a browser route skip it either
    const tokenOnBrowserRoute = await env.api.app.inject({
      method: 'POST',
      url: `/api/boards/${env.board}/trash`,
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, cookie: env.bob.cookie },
    })
    expect(tokenOnBrowserRoute.statusCode).toBe(403)
  })

  it('the worker token opens nothing but the worker routes', async () => {
    env = await workerEnv()
    const m = await env.upload()
    const h = { authorization: `Bearer ${WORKER_TOKEN}`, origin: ORIGIN }
    for (const url of [
      '/api/me',
      `/api/boards/${env.board}`,
      `/api/boards/${env.board}/assets/${m.assetId}/${m.versionId}`,
      `/files/${m.assetId}/${m.versionId}/original?board=${env.board}`,
    ]) {
      const res = await env.api.app.inject({ method: 'GET', url, headers: h })
      expect(res.statusCode, url).toBe(401)
    }
  })
})

describe('rate limit', () => {
  it('per token across all worker routes, and separately (lower) per address without a valid token', async () => {
    env = await workerEnv({ deps: { workerRateLimit: { max: 5, anonMax: 2, timeWindow: 60_000 } } })
    const statuses: number[] = []
    for (let i = 0; i < 4; i++)
      statuses.push((await env.worker('POST', '/api/worker/claim', { workerId: 'w' })).statusCode)
    for (let i = 0; i < 2; i++)
      statuses.push(
        (await env.worker('POST', `/api/worker/jobs/${VER}/heartbeat`, { workerId: 'w' })).statusCode,
      )
    expect(statuses).toEqual([204, 204, 204, 204, 409, 429])
    const limited = await env.worker('POST', '/api/worker/claim', { workerId: 'w' })
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('RATE_LIMITED')
    // strangers have their own, smaller bucket (and never touch the token's)
    const anon = []
    for (let i = 0; i < 3; i++)
      anon.push(
        (await env.worker('POST', '/api/worker/claim', { workerId: 'w' }, { authorization: 'Bearer nope' }))
          .statusCode,
      )
    expect(anon).toEqual([401, 401, 429])
  })
})

describe('logs', () => {
  it('never contain the worker token, blob URLs, session cookies or request bodies', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk))
        done()
      },
    })
    env = await workerEnv({ deps: { logger: { level: 'trace', stream } } })
    const m = await env.upload('Secret plan.png')
    const c = await claim(env)
    if (!c) throw new Error('no job')
    await env.api.app.inject({ method: 'GET', url: pathOf(c.original.url) })
    const r = await reserve(env, m.versionId, { bytes: 16 })
    await putBlob(env, r, Buffer.alloc(16))
    await env.worker('POST', `/api/worker/jobs/${m.versionId}/heartbeat`, { workerId: 'worker-a' })
    await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'ready',
      derivatives: [r.derivativeId],
      probe: { width: 1, height: 1 },
    })
    // failures are logged too, and must be just as clean
    await env.worker('POST', `/api/worker/jobs/${m.versionId}/retry`, {
      workerId: 'worker-a',
      error: 'detail with /tmp/secret path',
    })
    await env.worker(
      'POST',
      '/api/worker/claim',
      { workerId: 'w' },
      { authorization: 'Bearer wrong-token-0123456789-0123456789-xx' },
    )
    const all = lines.join('')
    expect(lines.length).toBeGreaterThan(5) // request lines were logged at all
    const sessionValue = env.bob.cookie.split('=')[1] ?? ''
    const opaque = (url: string) => pathOf(url).split('/').pop() ?? ''
    for (const secret of [
      WORKER_TOKEN,
      'wrong-token-0123456789-0123456789-xx',
      sessionValue,
      opaque(c.original.url),
      opaque(r.upload.url),
      '/api/worker/blobs/o.',
      '/api/worker/blobs/d.',
      'Secret plan',
      '/tmp/secret',
    ])
      expect(all.includes(secret), secret).toBe(false)
    // what IS logged: route patterns
    expect(all).toContain('/api/worker/blobs/:opaque')
    expect(all).toContain('/api/worker/jobs/:ver/complete')
  })

  it('idle polls (claim 204) are debug, so an idle worker does not flood info logs; a claim with a job is info', async () => {
    const lines: { level: number; route?: string; status?: number; msg?: string }[] = []
    const stream = new Writable({
      write(chunk, _enc, done) {
        for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l))
        done()
      },
    })
    env = await workerEnv({ deps: { logger: { level: 'debug', stream } } })
    const claims = (level: number) =>
      lines.filter((l) => l.msg === 'request' && l.route === '/api/worker/claim' && l.level === level)
    for (let i = 0; i < 3; i++) expect(await claim(env)).toBeNull()
    expect(claims(20).map((l) => l.status)).toEqual([204, 204, 204]) // pino debug = 20
    expect(claims(30)).toEqual([]) // pino info = 30
    await env.upload()
    expect(await claim(env)).not.toBeNull()
    expect(claims(30).map((l) => l.status)).toEqual([200])
  })
})
