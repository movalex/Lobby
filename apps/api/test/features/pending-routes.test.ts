// Wave M foundation (OWNER: W5 after it): every route wave M adds is pending until its owner implements it
// (src/features/pending-routes.ts): not registered, so it answers exactly as an unknown route does today, for every
// kind of caller. The branch deploys with no behaviour change, and an old web or sync gets the 404 its downgrade
// path expects (the wave M stale pairs (c) and (d)).
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CREATOR_ROUTES } from '../../src/features/domain-access/guard.ts'
import { GUEST_REFUSED_ROUTES } from '../../src/features/guests/guard.ts'
import { isPendingRoute, PENDING_ROUTES, routeUnlessPending } from '../../src/features/pending-routes.ts'
import { DEV_STUDIO, INTERNAL_SECRET } from '../helpers.ts'
import {
  type GuestClient,
  guestLink,
  joinAsGuest,
  type Method,
  setupWorld,
  type World,
} from './guests/support.ts'

/**
 * What the plan's foundation section names that is still pending. A route leaves the list when its owner implements it
 * (W5: GET /healthz/deep with M5-6, POST /api/usage and GET /internal/usage with M5-5, the open-state with M5-1; W7: POST /internal/access-many with M7-1; W8: the ask and the four template routes); the sync's /healthz/deep is W7's.
 */
const WAVE_M_ROUTES: string[] = []
/**
 * Wave N (the foundation, OWNER: WS4 after it): the routes wave N adds, pending until their owners implement them
 * (WS4's visit routes, N4-1, are implemented and left this list; WS5: the three capture routes, N5-1; WS7: board-cards
 * N7-2 and backlinks N7-4). Each owner deletes its keys here and in PENDING_ROUTES in the same change.
 */
const WAVE_N_ROUTES: string[] = [
  'POST /api/boards/:bid/ai/capture/photo',
  'POST /api/boards/:bid/ai/capture/board-image',
  'POST /api/boards/:bid/ai/capture/transcript',
  'GET /api/boards/:bid/board-cards',
  'GET /api/boards/:bid/backlinks',
]
const PENDING_NOW = [...WAVE_M_ROUTES, ...WAVE_N_ROUTES]

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

const fill = (pattern: string, board: string) =>
  pattern.replace(':bid', board).replace(':wid', DEV_STUDIO).replace(/:\w+/g, 'x')

describe('the pending list', () => {
  it('is exactly the wave M and wave N routes still pending, each with its owner and plan item', () => {
    expect(Object.keys(PENDING_ROUTES).sort()).toEqual([...PENDING_NOW].sort())
    for (const [key, r] of Object.entries(PENDING_ROUTES)) {
      expect(['W5', 'W7', 'W8', 'WS4', 'WS5', 'WS7'], key).toContain(r.owner)
      expect(r.item, key).toMatch(/^(M[5-8]|N[1-7])-\d$/)
    }
  })

  it('every wave N guest row is a pending route until its owner implements it (board-cards has no guest row)', () => {
    const rows = Object.keys(GUEST_REFUSED_ROUTES).filter((k) => WAVE_N_ROUTES.includes(k))
    expect(rows.sort()).toEqual(WAVE_N_ROUTES.filter((k) => !k.endsWith('/board-cards')).sort())
    for (const k of rows) expect(isPendingRoute(k), k).toBe(true)
    expect(Object.keys(CREATOR_ROUTES).filter((k) => WAVE_N_ROUTES.includes(k))).toEqual([])
  })

  it('every wave M guard row is a pending route until its owner implements it (the rows are in place before the routes)', () => {
    const rows = [...Object.keys(CREATOR_ROUTES), ...Object.keys(GUEST_REFUSED_ROUTES)].filter(
      (k) => k.includes('/templates') || k.includes('/ai/ask'),
    )
    expect(rows.length).toBe(3 + 5)
    // W8 implemented Ask across boards (M8-2) and the workspace templates (M8-3): the refusal and creation matrices
    // hold every one of them to its guard rows now
    for (const k of rows) expect(isPendingRoute(k), k).toBe(false)
  })

  it('routeUnlessPending registers a route that is not pending, and nothing for one that is', async () => {
    const app = Fastify()
    const pending = { 'GET /p': { owner: 'W5' as const, item: 'M5-1' } }
    expect(routeUnlessPending(app, 'GET', '/p', async () => ({ ok: 1 }), pending)).toBe(false)
    expect(routeUnlessPending(app, 'GET', '/q', async () => ({ ok: 2 }), pending)).toBe(true)
    // the same path with another method is another route
    expect(routeUnlessPending(app, 'POST', '/p', async () => ({ ok: 3 }), pending)).toBe(true)
    await app.ready()
    expect((await app.inject({ method: 'GET', url: '/p' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/q' })).json()).toEqual({ ok: 2 })
    expect((await app.inject({ method: 'POST', url: '/p' })).json()).toEqual({ ok: 3 })
    await app.close()
  })
})

describe('in the real app, a pending route answers like an unknown route', () => {
  let w: World
  let sam: GuestClient
  beforeEach(async () => {
    w = await setupWorld()
    sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'Sam')
  })
  afterEach(() => w.api.close())

  it('is not registered (nor its HEAD)', () => {
    for (const key of PENDING_NOW) {
      const [method = '', url = ''] = key.split(' ')
      expect(w.api.app.hasRoute({ method: method as Method, url }), key).toBe(false)
      if (method === 'GET') expect(w.api.app.hasRoute({ method: 'HEAD', url }), `HEAD ${url}`).toBe(false)
    }
  })

  it('anonymous, a member, an owner, a name-only guest and the internal secret all get the unknown route’s 404', async () => {
    const callers: [string, (m: Method, url: string, body?: unknown) => ReturnType<typeof sam.req>][] = [
      ['anonymous', (m, url, body) => w.api.anon(m, url, body)],
      [
        'internal secret',
        (m, url, body) => w.api.anon(m, url, body, { 'x-draftroom-internal': INTERNAL_SECRET }),
      ],
      ['a member', (m, url, body) => w.alice.req(m, url, body)],
      ['the board owner', (m, url, body) => w.bob.req(m, url, body)],
      ['a guest', (m, url, body) => sam.req(m, url, body)],
    ]
    for (const key of PENDING_NOW) {
      const [method = 'GET', pattern = ''] = key.split(' ') as [Method, string]
      const url = fill(pattern, w.board)
      const body = method === 'GET' || method === 'DELETE' ? undefined : {}
      for (const [who, call] of callers) {
        const res = await call(method, url, body)
        // the same request to a path that never existed
        const unknown = await call(method, `/api/wave-m-never-${method.toLowerCase()}`, body)
        expect({ key, who, status: res.statusCode }).toEqual({ key, who, status: unknown.statusCode })
        expect(res.statusCode, `${key} ${who}`).toBe(404)
        expect(res.json(), `${key} ${who}`).toEqual(UNKNOWN)
        expect(res.json()).toEqual(unknown.json())
      }
    }
    // nothing was written by any of it
    for (const table of [
      'usage_daily',
      'workspace_templates',
      'board_visits',
      'board_links',
      'board_link_scans',
    ]) {
      const n = await w.api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
      expect(n.n, table).toBe(0)
    }
  })
})
