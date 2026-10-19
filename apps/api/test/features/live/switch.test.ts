// Wave V (the foundation; docs/WAVE-V-CONTRACTS.md §1): the kill switches gate every route of their feature. With its
// switch off a route answers exactly like an unknown route (the root 404) for every caller, before its body is parsed
// and before the root guards (a preHandler that would refuse), and its handler never runs. The three real feature
// modules are registered here with nothing pending, to show their gate; every wave V route has landed (none pending).
import {
  ACTIVITY_ROUTE_KEYS,
  BREAKOUT_ROUTE_KEYS,
  JOIN_CODE_ROUTE_KEYS,
  LIVE_SWITCHES,
  type LiveSwitch,
  type LiveSwitches,
} from '@draftroom/contracts'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { toErrorResponse } from '../../../src/errors.ts'
import { registerBreakouts } from '../../../src/features/breakouts/index.ts'
import type { FeatureContext } from '../../../src/features/context.ts'
import { registerJoinCodes } from '../../../src/features/join-codes/index.ts'
import { liveOn, liveRoute, liveStub, requireLive } from '../../../src/features/live/switch.ts'
import { registerLiveActivities } from '../../../src/features/live-activities/index.ts'
import { PENDING_ROUTES, type PendingRoute } from '../../../src/features/pending-routes.ts'
import { createTestApi, type TestApi } from '../../helpers.ts'

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }
const ALL_OFF: LiveSwitches = { activities: false, joinCodes: false, breakouts: false }
const ALL_ON: LiveSwitches = { activities: true, joinCodes: true, breakouts: true }

type Register = (
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>>,
) => Promise<void>
const FEATURES: [LiveSwitch, readonly string[], Register][] = [
  ['activities', ACTIVITY_ROUTE_KEYS, registerLiveActivities],
  ['joinCodes', JOIN_CODE_ROUTE_KEYS, registerJoinCodes],
  ['breakouts', BREAKOUT_ROUTE_KEYS, registerBreakouts],
]

const fill = (pattern: string) => pattern.replace(/:\w+/g, 'x1')
/** A bare app's context: the switches only (a landed feature reads the rest lazily, in its handlers). */
const switchesOnly = (live: LiveSwitches) => ({ config: { live } }) as unknown as FeatureContext

let app: FastifyInstance | null = null
let api: TestApi | null = null
afterEach(async () => {
  await app?.close()
  app = null
  await api?.close()
  api = null
})

/** A bare app shaped like the api: its error handler and 404, a root guard that refuses everything, the three features. */
async function bare(live: LiveSwitches) {
  const a = Fastify()
  const guarded: string[] = []
  a.setErrorHandler((err, _req, reply) => {
    const r = toErrorResponse(err)
    return reply.code(r.status).send(r.body)
  })
  a.setNotFoundHandler((_req, reply) => reply.code(404).send(UNKNOWN))
  // a root guard (as guests/guard.ts and domain-access/guard.ts): it must never be reached while a switch is off
  a.addHook('preHandler', async (req) => {
    if (req.is404) return // the real guards key on route patterns: an unknown route has none
    guarded.push(`${req.method} ${req.routeOptions.url}`)
    throw Object.assign(new Error('refused'), { statusCode: 403 })
  })
  const ctx = switchesOnly(live)
  for (const [, , register] of FEATURES) await register(a, ctx, {})
  await a.ready()
  app = a
  return { a, guarded }
}

describe('the wave V kill switches', () => {
  it('liveOn and requireLive read the config (fixed at boot)', () => {
    for (const s of LIVE_SWITCHES) {
      expect(liveOn({ config: { live: ALL_OFF } }, s)).toBe(false)
      expect(liveOn({ config: { live: { ...ALL_OFF, [s]: true } } }, s)).toBe(true)
      expect(() => requireLive({ config: { live: ALL_OFF } }, s)).toThrow(/Not found/)
      expect(() => requireLive({ config: { live: ALL_ON } }, s)).not.toThrow()
    }
  })

  it('off: every route of the feature is an unknown route for every caller, before its body and the guards', async () => {
    const { a, guarded } = await bare(ALL_OFF)
    for (const [, keys] of FEATURES)
      for (const key of keys) {
        const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
        const url = fill(pattern)
        for (const payload of [undefined, '{"not json', '{}']) {
          const res = await a.inject({
            method,
            url,
            ...(payload === undefined || method === 'GET'
              ? {}
              : { payload, headers: { 'content-type': 'application/json' } }),
          })
          const unknown = await a.inject({ method, url: '/api/wave-v-never' })
          expect({ key, status: res.statusCode }).toEqual({ key, status: 404 })
          expect(res.json(), key).toEqual(UNKNOWN)
          expect(res.json()).toEqual(unknown.json())
        }
      }
    expect(guarded).toEqual([])
  })

  it('each switch gates only its own feature; on, the route reaches the guards (403 here)', async () => {
    for (const [on] of FEATURES) {
      const { a, guarded } = await bare({ ...ALL_OFF, [on]: true })
      for (const [sw, keys] of FEATURES)
        for (const key of keys) {
          const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
          const res = await a.inject({ method, url: fill(pattern) })
          // the bare app's guard refuses everything that gets past the gate (403); the gate itself is the 404
          expect(res.statusCode, `${on} on, ${key}`).toBe(sw === on ? 403 : 404)
        }
      expect(guarded.length).toBe(FEATURES.find(([s]) => s === on)?.[1].length)
      await a.close()
      app = null
    }
  })

  it('on, with no guard in the way, a route still stubbed is 501 NOT_IMPLEMENTED (never a feature that looks finished)', async () => {
    const a = Fastify()
    a.setErrorHandler((err, _req, reply) => {
      const r = toErrorResponse(err)
      return reply.code(r.status).send(r.body)
    })
    // every wave V route has landed (none is pending in the real app), so none reaches the stub; the stub itself
    // stays for a route a later change ships hidden, and is held to its 501 here through liveRoute
    const pendingWaveV = FEATURES.flatMap(([, keys]) => keys.filter((k) => Object.hasOwn(PENDING_ROUTES, k)))
    expect(pendingWaveV).toEqual([])
    for (const [, , register] of FEATURES) await register(a, switchesOnly(ALL_ON), {})
    expect(liveRoute(a, switchesOnly(ALL_ON), 'activities', 'POST', '/api/wave-v-stub', liveStub, {})).toBe(
      true,
    )
    expect(
      liveRoute(a, switchesOnly(ALL_OFF), 'breakouts', 'GET', '/api/wave-v-stub-off', liveStub, {}),
    ).toBe(true)
    await a.ready()
    app = a
    const res = await a.inject({ method: 'POST', url: '/api/wave-v-stub' })
    expect(res.statusCode).toBe(501)
    expect(res.json().error.code).toBe('NOT_IMPLEMENTED')
    // its switch off, a stubbed route is the unknown route like any other
    const off = await a.inject({ method: 'GET', url: '/api/wave-v-stub-off' })
    expect(off.statusCode).toBe(404)
    expect(off.json()).toEqual(UNKNOWN)
  })

  it('liveRoute registers nothing for a pending route', async () => {
    const a = Fastify()
    const pending = { 'GET /p': { owner: 'WS1' as const, item: 'V1-1' } }
    const ctx = { config: { live: ALL_ON } }
    expect(liveRoute(a, ctx, 'activities', 'GET', '/p', async () => ({ ok: 1 }), pending)).toBe(false)
    expect(liveRoute(a, ctx, 'activities', 'GET', '/q', async () => ({ ok: 2 }), pending)).toBe(true)
    await a.ready()
    app = a
    expect((await a.inject({ method: 'GET', url: '/p' })).statusCode).toBe(404)
    expect((await a.inject({ method: 'GET', url: '/q' })).json()).toEqual({ ok: 2 })
  })

  it('in the real app with every switch off (the default), every wave V route, pending or landed, is an unknown route for everyone', async () => {
    api = await createTestApi()
    expect(api.config.live).toEqual(ALL_OFF)
    const alice = await api.login('alice')
    for (const [, keys] of FEATURES)
      for (const key of keys) {
        const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
        for (const [who, res] of [
          ['anonymous', await api.anon(method, fill(pattern), method === 'GET' ? undefined : {})],
          ['owner', await alice.req(method, fill(pattern), method === 'GET' ? undefined : {})],
        ] as const) {
          expect(res.statusCode, `${key} ${who}`).toBe(404)
          expect(res.json(), `${key} ${who}`).toEqual(UNKNOWN)
        }
      }
  })

  it('in the real app with the switches on, every wave V route is registered (none is pending: every owner landed it)', async () => {
    api = await createTestApi({
      env: { DRAFTROOM_LIVE_ACTIVITIES: 'on', DRAFTROOM_JOIN_CODES: 'on', DRAFTROOM_BREAKOUTS: 'on' },
    })
    expect(api.config.live).toEqual(ALL_ON)
    for (const [, keys] of FEATURES)
      for (const key of keys) {
        const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
        expect(Object.hasOwn(PENDING_ROUTES, key), key).toBe(false)
        expect(api.app.hasRoute({ method, url: pattern }), key).toBe(true)
      }
  })
})
