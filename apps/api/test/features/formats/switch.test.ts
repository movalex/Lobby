// Wave W (the foundation; docs/WAVE-W-CONTRACTS.md §1): the kill switches gate every route of their feature. With its
// switch off a route answers exactly like an unknown route (the root 404) for every caller, before its body is parsed
// and before the root guards (a preHandler that would refuse), and its handler never runs. The real feature modules are
// registered here with nothing pending, to show their gate; in the real app every wave W route is still pending.
import {
  ADMIN_ROUTE_KEYS,
  FORMAT_ROUTE_KEYS,
  FORMAT_SWITCHES,
  FORMAT_SWITCHES_OFF,
  type FormatSwitch,
  type FormatSwitches,
} from '@draftroom/contracts'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { toErrorResponse } from '../../../src/errors.ts'
import type { FeatureContext } from '../../../src/features/context.ts'
import { registerFormats } from '../../../src/features/formats/index.ts'
import { formatsOn, formatsRoute, formatsStub, requireFormats } from '../../../src/features/formats/switch.ts'
import { PENDING_ROUTES } from '../../../src/features/pending-routes.ts'
import { registerWorkspaceAdmin } from '../../../src/features/workspace-admin/index.ts'
import { createTestApi, type TestApi } from '../../helpers.ts'

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }
const ALL_OFF: FormatSwitches = { ...FORMAT_SWITCHES_OFF }
const ALL_ON: FormatSwitches = {
  docCards: true,
  removeBackground: true,
  fileSearch: true,
  deckImport: true,
  admin: true,
}

/** Each route and the switches that open it (any one of them). */
const ROUTES: [string, FormatSwitch[]][] = [
  [FORMAT_ROUTE_KEYS.removeBackground, ['removeBackground']],
  [FORMAT_ROUTE_KEYS.renderPages, ['deckImport']],
  [FORMAT_ROUTE_KEYS.opState, ['removeBackground', 'deckImport']],
  [FORMAT_ROUTE_KEYS.opCancel, ['removeBackground', 'deckImport']],
  ...Object.values(ADMIN_ROUTE_KEYS).map((k): [string, FormatSwitch[]] => [k, ['admin']]),
]

const fill = (pattern: string) => pattern.replace(/:\w+/g, 'x1')
const switchesOnly = (formats: FormatSwitches) => ({ config: { formats } }) as unknown as FeatureContext
/** The routes still stubbed (pending in the real app); a landed one is held to its gate here and tested by its owner. */
const STUBBED = ROUTES.filter(([key]) => Object.hasOwn(PENDING_ROUTES, key))

let app: FastifyInstance | null = null
let api: TestApi | null = null
afterEach(async () => {
  await app?.close()
  app = null
  await api?.close()
  api = null
})

/** A bare app shaped like the api: its error handler and 404, a root guard that refuses everything, the features. */
async function bare(formats: FormatSwitches) {
  const a = Fastify()
  const guarded: string[] = []
  a.setErrorHandler((err, _req, reply) => {
    const r = toErrorResponse(err)
    return reply.code(r.status).send(r.body)
  })
  a.setNotFoundHandler((_req, reply) => reply.code(404).send(UNKNOWN))
  a.addHook('preHandler', async (req) => {
    if (req.is404) return
    guarded.push(`${req.method} ${req.routeOptions.url}`)
    throw Object.assign(new Error('refused'), { statusCode: 403 })
  })
  await registerFormats(a, switchesOnly(formats), {})
  await registerWorkspaceAdmin(a, switchesOnly(formats), {})
  await a.ready()
  app = a
  return { a, guarded }
}

describe('the wave W kill switches', () => {
  it('formatsOn and requireFormats read the config (fixed at boot); a list opens with any one on', () => {
    for (const s of FORMAT_SWITCHES) {
      expect(formatsOn(switchesOnly(ALL_OFF), s)).toBe(false)
      expect(formatsOn(switchesOnly({ ...ALL_OFF, [s]: true }), s)).toBe(true)
      expect(() => requireFormats(switchesOnly(ALL_OFF), s)).toThrow(/Not found/)
      expect(() => requireFormats(switchesOnly(ALL_ON), s)).not.toThrow()
    }
    expect(
      formatsOn(switchesOnly({ ...ALL_OFF, deckImport: true }), ['removeBackground', 'deckImport']),
    ).toBe(true)
    expect(formatsOn(switchesOnly(ALL_OFF), ['removeBackground', 'deckImport'])).toBe(false)
  })

  it('off: every route is an unknown route for every caller, before its body and the guards', async () => {
    const { a, guarded } = await bare(ALL_OFF)
    for (const [key] of ROUTES) {
      const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
      for (const payload of [undefined, '{"not json', '{}']) {
        const res = await a.inject({
          method,
          url: fill(pattern),
          ...(payload === undefined || method === 'GET'
            ? {}
            : { payload, headers: { 'content-type': 'application/json' } }),
        })
        expect({ key, status: res.statusCode }).toEqual({ key, status: 404 })
        expect(res.json(), key).toEqual(UNKNOWN)
      }
    }
    expect(guarded).toEqual([])
  })

  it('each switch opens only its own routes; on, the route reaches the guards (403 here)', async () => {
    for (const on of FORMAT_SWITCHES) {
      const { a, guarded } = await bare({ ...ALL_OFF, [on]: true })
      for (const [key, opens] of ROUTES) {
        const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
        const res = await a.inject({ method, url: fill(pattern) })
        expect(res.statusCode, `${on} on, ${key}`).toBe(opens.includes(on) ? 403 : 404)
      }
      expect(guarded.length, on).toBe(ROUTES.filter(([, opens]) => opens.includes(on)).length)
      await a.close()
      app = null
    }
  })

  it('doc cards gate no route at all (they are canvas elements; the web reads AuthConfig.formats)', () => {
    expect(ROUTES.some(([, opens]) => opens.includes('docCards'))).toBe(false)
    expect(ROUTES.some(([, opens]) => opens.includes('fileSearch'))).toBe(false)
  })

  it('on, with no guard in the way, a stubbed route is 501 NOT_IMPLEMENTED (never a feature that looks finished)', async () => {
    const a = Fastify()
    a.setErrorHandler((err, _req, reply) => {
      const r = toErrorResponse(err)
      return reply.code(r.status).send(r.body)
    })
    await registerFormats(a, switchesOnly(ALL_ON), {})
    await registerWorkspaceAdmin(a, switchesOnly(ALL_ON), {})
    await a.ready()
    app = a
    for (const [key] of STUBBED) {
      const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
      const res = await a.inject({ method, url: fill(pattern) })
      expect(res.statusCode, key).toBe(501)
      expect(res.json().error.code, key).toBe('NOT_IMPLEMENTED')
    }
  })

  it('formatsRoute registers nothing for a pending route', async () => {
    const a = Fastify()
    const pending = { 'GET /p': { owner: 'WS2' as const, item: 'W2-1' } }
    const ctx = switchesOnly(ALL_ON)
    expect(formatsRoute(a, ctx, 'removeBackground', 'GET', '/p', formatsStub, pending)).toBe(false)
    expect(formatsRoute(a, ctx, 'removeBackground', 'GET', '/q', async () => ({ ok: 2 }), pending)).toBe(true)
    await a.ready()
    app = a
    expect((await a.inject({ method: 'GET', url: '/p' })).statusCode).toBe(404)
    expect((await a.inject({ method: 'GET', url: '/q' })).json()).toEqual({ ok: 2 })
  })

  it('in the real app with every switch on, every wave W route still pending is not registered: an unknown route', async () => {
    api = await createTestApi({
      env: {
        DRAFTROOM_DOC_CARDS: 'on',
        DRAFTROOM_REMOVE_BACKGROUND: 'on',
        DRAFTROOM_FILE_SEARCH: 'on',
        DRAFTROOM_DECK_IMPORT: 'on',
        DRAFTROOM_WORKSPACE_ADMIN: 'on',
      },
    })
    expect(api.config.formats).toEqual(ALL_ON)
    const alice = await api.login('alice')
    for (const [key] of STUBBED) {
      const [method = 'GET', pattern = ''] = key.split(' ') as ['GET' | 'POST', string]
      expect(api.app.hasRoute({ method, url: pattern }), key).toBe(false)
      const res = await alice.req(method, fill(pattern), method === 'GET' ? undefined : {})
      expect(res.statusCode, key).toBe(404)
      expect(res.json(), key).toEqual(UNKNOWN)
    }
  })
})
