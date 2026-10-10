// Wave M (M7-6, CAP-ALERTS): GET /healthz/deep, for an external uptime monitor. Public (no secret), codes only:
// 200 `ok`, or 503 with `disk`, `backup`, `loop`, `api` (comma-separated, in that order). Render's health check
// stays /healthz, so a deep failure alerts and never restarts the sync.
//  - the router, with fakes for each reason code and the 200 path; the body carries no id;
//  - the rule's edges (deepHealthReasons) and the event-loop window (LoopWatch, a real stall);
//  - the real server: healthy, then `disk` (DRAFTROOM_TEST_DISK_FREE) and `api` (a round the api cannot answer),
//    and healthy again once the api answers.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccessRound } from '../../src/access.ts'
import type { OffsiteBoardStatus } from '../../src/backup/offsite.ts'
import { createLoopWatch, DEEP_HEALTH, type DeepHealthFacts, deepHealthReasons } from '../../src/health.ts'
import { createRequestHandler } from '../../src/http/router.ts'
import { useElementHarness } from '../element-room/support/stack.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { req } from './helpers.ts'

const h = useElementHarness()
const NOW = Date.UTC(2026, 9, 10, 12, 0)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const board = (o: Partial<OffsiteBoardStatus> = {}): OffsiteBoardStatus => ({
  boardId: 'b-health0001',
  lastSuccessAt: new Date(NOW - 60_000).toISOString(),
  lastSuccessFile: '2026-10-10T11-59-00-000Z-c7.sqlite',
  lastSuccessClock: 7,
  offsiteCount: 3,
  pending: 0,
  pendingSince: null,
  failures: 0,
  failuresTotal: 0,
  lastFailureAt: null,
  lastError: null,
  ...o,
})
const round = (o: Partial<AccessRound> = {}): AccessRound => ({
  at: NOW - 5_000,
  pairs: 4,
  failed: 0,
  batched: true,
  ...o,
})
const healthy = (o: Partial<DeepHealthFacts> = {}): DeepHealthFacts => ({
  diskFreeRatio: 0.8,
  backups: { store: 'r2', boards: [board()] },
  loopP99Ms: 12,
  accessRound: round(),
  now: NOW,
  ...o,
})

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

/** The router alone, its deep check answering from `facts`. */
async function router(facts: () => DeepHealthFacts): Promise<number> {
  const handle = createRequestHandler({
    internalSecret: TEST_INTERNAL_SECRET,
    monitor: {} as never,
    isClosing: () => false,
    log: () => {},
    deepHealth: () => deepHealthReasons(facts()),
  })
  server = createServer((q, s) => void handle(q, s))
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

describe('M7-6: GET /healthz/deep (the router, with fakes)', () => {
  it('200 ok when everything is fine; public (no secret), not cached', async () => {
    const port = await router(() => healthy())
    const res = await req(port, { path: '/healthz/deep' })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('ok')
    expect(res.headers['content-type']).toBe('text/plain')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  const cases: [string, Partial<DeepHealthFacts>, string][] = [
    ['disk under 20 % free', { diskFreeRatio: 0.15 }, 'disk'],
    [
      'an offsite copy failing',
      { backups: { store: 'r2', boards: [board(), board({ failures: 2 })] } },
      'backup',
    ],
    [
      'a local backup waiting over an hour',
      {
        backups: {
          store: 'r2',
          boards: [board({ pending: 1, pendingSince: new Date(NOW - 61 * 60_000).toISOString() })],
        },
      },
      'backup',
    ],
    ['an event-loop p99 over 200 ms', { loopP99Ms: 340 }, 'loop'],
    ['the last access round could not reach the api', { accessRound: round({ failed: 1 }) }, 'api'],
    [
      'all of them, in a fixed order',
      {
        diskFreeRatio: 0.05,
        backups: { store: 'fs', boards: [board({ failures: 1 })] },
        loopP99Ms: 900,
        accessRound: round({ failed: 3 }),
      },
      'disk,backup,loop,api',
    ],
  ]
  for (const [what, facts, body] of cases)
    it(`503 ${body}: ${what}; the body is the codes only`, async () => {
      const port = await router(() => healthy(facts))
      const res = await req(port, { path: '/healthz/deep' })
      expect(res.status).toBe(503)
      const text = res.body.toString()
      expect(text).toBe(body)
      expect(text).toMatch(/^(disk|backup|loop|api)(,(disk|backup|loop|api))*$/)
      expect(text).not.toContain('b-health')
    })
})

describe('M7-6: the rule’s edges', () => {
  it('thresholds: 20 % disk, 200 ms loop, an hour of waiting; offsite off and unknowns are never reasons', () => {
    expect(deepHealthReasons(healthy())).toEqual([])
    expect(deepHealthReasons(healthy({ diskFreeRatio: 0.2 }))).toEqual([])
    expect(deepHealthReasons(healthy({ diskFreeRatio: 0.199 }))).toEqual(['disk'])
    expect(deepHealthReasons(healthy({ diskFreeRatio: null }))).toEqual([]) // statfs unavailable
    expect(deepHealthReasons(healthy({ loopP99Ms: DEEP_HEALTH.loopP99Ms }))).toEqual([])
    expect(deepHealthReasons(healthy({ loopP99Ms: 200.5 }))).toEqual(['loop'])
    expect(deepHealthReasons(healthy({ loopP99Ms: null }))).toEqual([]) // the first window has not ended
    const waiting = (ms: number) =>
      healthy({
        backups: {
          store: 'r2',
          boards: [board({ pending: 2, pendingSince: new Date(NOW - ms).toISOString() })],
        },
      })
    expect(deepHealthReasons(waiting(59 * 60_000))).toEqual([])
    expect(deepHealthReasons(waiting(61 * 60_000))).toEqual(['backup'])
    // offsite backups off: nothing to check (failures or not)
    expect(
      deepHealthReasons(healthy({ backups: { store: 'off', boards: [board({ failures: 5 })] } })),
    ).toEqual([])
    expect(deepHealthReasons(healthy({ accessRound: null }))).toEqual([]) // no round yet
    expect(deepHealthReasons(healthy({ accessRound: round({ pairs: 0, failed: 0 }) }))).toEqual([])
  })

  it('LoopWatch: a window with a 300 ms stall reads a p99 over 200 ms; the next quiet window does not', async () => {
    const w = createLoopWatch({ windowMs: 600, resolutionMs: 10 })
    try {
      expect(w.p99()).toBeNull()
      await sleep(50)
      const until = Date.now() + 300
      while (Date.now() < until) {
        // a stalled event loop
      }
      await sleep(700)
      expect(w.p99()).toBeGreaterThan(200)
      await sleep(700)
      expect(w.p99()).toBeLessThan(200)
    } finally {
      w.stop()
    }
  })
})

describe('M7-6 in the real server', () => {
  it('healthy, then `disk` with the disk under 20 % (the test hook), and never with the secret needed', async () => {
    const ok = await h.stack({ env: { DRAFTROOM_TEST_DISK_FREE: '0.9' } })
    const res = await fetch(`${ok.server.url}/healthz/deep`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    const low = await h.stack({ env: { DRAFTROOM_TEST_DISK_FREE: '0.15' } })
    const bad = await fetch(`${low.server.url}/healthz/deep`)
    expect(bad.status).toBe(503)
    expect(await bad.text()).toBe('disk')
    // /healthz itself stays 200 (Render's health check: a deep failure never restarts the sync)
    expect((await fetch(`${low.server.url}/healthz`)).status).toBe(200)
  })

  it('`api` while the access round cannot reach the api, and healthy again once it answers', async () => {
    const st = await h.stack({ env: { DRAFTROOM_TEST_DISK_FREE: '0.9', ACCESS_RECHECK_MS: '150' } })
    const b = 'b-health-api01'
    // no role set: the fake answers 404 per pair ("cannot tell"), a failed round
    await st.client({ boardId: b, user: 'alice' })
    let text = ''
    for (let i = 0; i < 50 && text !== 'api'; i++) {
      await sleep(100)
      text = await (await fetch(`${st.server.url}/healthz/deep`)).text()
    }
    expect(text).toBe('api')
    st.api.setRole(b, 'alice', 'editor')
    for (let i = 0; i < 50 && text !== 'ok'; i++) {
      await sleep(100)
      text = await (await fetch(`${st.server.url}/healthz/deep`)).text()
    }
    expect(text).toBe('ok')
  })
})
