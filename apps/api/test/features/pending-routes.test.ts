// Wave M foundation (OWNER: W5 after it): every route wave M adds is pending until its owner implements it
// (src/features/pending-routes.ts): not registered, so it answers exactly as an unknown route does today, for every
// kind of caller. The branch deploys with no behaviour change, and an old web or sync gets the 404 its downgrade
// path expects (the wave M stale pairs (c) and (d)).
import {
  ASSET_VERSION_ROUTE_KEYS,
  BACKUP_CREATOR_ROUTE_KEYS,
  BACKUP_GUESTS_MESSAGE,
  BACKUP_ROUTE_KEYS,
  CHAT_HOOK_CREATOR_ROUTE_KEYS,
  CHAT_HOOK_GUESTS_MESSAGE,
  CHAT_HOOK_ROUTE_KEYS,
  IMPORT_CREATOR_ROUTE_KEYS,
  IMPORT_GUESTS_MESSAGE,
  IMPORT_ROUTE_KEYS,
  LIBRARY_CREATOR_IN_ROUTE_KEYS,
  LIBRARY_GUEST_ROUTE_KEYS,
  LIBRARY_GUESTS_MESSAGE,
  LIBRARY_ROUTE_KEYS,
  MIRO_IMPORT_CREATOR_ROUTE_KEYS,
  MIRO_IMPORT_ROUTE_KEYS,
  REVIEW_GUESTS_MESSAGE,
  REVIEW_MANAGE_ROUTE_KEYS,
  REVIEW_ROUTE_KEYS,
} from '@draftroom/contracts'
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
 * (none left). Each owner deletes its keys here and in PENDING_ROUTES in the same change: WS4 implemented the visit
 * routes (N4-1), WS5 the three capture routes (N5-1), WS7 board-cards (N7-2) and backlinks (N7-4).
 */
const WAVE_N_ROUTES: string[] = []
/**
 * Wave Q (the foundation, OWNER: WS2 after it): the element library's routes, pending until WS2 implemented them
 * (features/library, all 15: none left). To ship one hidden, add its key back here and in PENDING_ROUTES.
 */
const WAVE_Q_ROUTES: string[] = []
/**
 * Wave R (the foundation; docs/WAVE-R-CONTRACTS.md §1): every route of the wave, pending until its owner implements it
 * (none left): WS1 implemented the job and Miro routes, WS2 the chat hooks, WS4 the three backup routes. To ship one
 * hidden, add its key back here and in PENDING_ROUTES.
 */
const WAVE_R_ROUTES: string[] = []
/** Every route of wave R but the chat hooks (their own test below), pending or live (the guard rows hold for all). */
const WAVE_R_ALL: string[] = [...IMPORT_ROUTE_KEYS, ...MIRO_IMPORT_ROUTE_KEYS, ...BACKUP_ROUTE_KEYS]
const WAVE_R_OWNERS: Record<string, string> = {
  ...Object.fromEntries([...IMPORT_ROUTE_KEYS, ...MIRO_IMPORT_ROUTE_KEYS].map((k) => [k, 'WS1'])),
  ...Object.fromEntries(CHAT_HOOK_ROUTE_KEYS.map((k) => [k, 'WS2'])),
  ...Object.fromEntries(BACKUP_ROUTE_KEYS.map((k) => [k, 'WS4'])),
}
/**
 * Wave S (the foundation; docs/WAVE-S-CONTRACTS.md §1): every route of the wave, pending until its owner implements it:
 * the review routes (WS1). Each owner deletes its keys here and in PENDING_ROUTES in the change that implements them;
 * WS2 implemented the version list (S2-1, files/versions.ts).
 */
const WAVE_S_ROUTES: string[] = [...REVIEW_ROUTE_KEYS]
const WAVE_S_OWNERS: Record<string, string> = {
  ...Object.fromEntries(REVIEW_ROUTE_KEYS.map((k) => [k, 'WS1'])),
  ...Object.fromEntries(ASSET_VERSION_ROUTE_KEYS.map((k) => [k, 'WS2'])),
}
const PENDING_NOW = [...WAVE_M_ROUTES, ...WAVE_N_ROUTES, ...WAVE_Q_ROUTES, ...WAVE_R_ROUTES, ...WAVE_S_ROUTES]

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

const fill = (pattern: string, board: string) =>
  pattern.replace(':bid', board).replace(':wid', DEV_STUDIO).replace(/:\w+/g, 'x')

describe('the pending list', () => {
  it('is exactly the wave M, N, Q, R and S routes still pending, each with its owner and plan item', () => {
    expect(Object.keys(PENDING_ROUTES).sort()).toEqual([...PENDING_NOW].sort())
    for (const [key, r] of Object.entries(PENDING_ROUTES)) {
      expect(['W5', 'W7', 'W8', 'WS1', 'WS2', 'WS4', 'WS5', 'WS7'], key).toContain(r.owner)
      expect(r.item, key).toMatch(/^(M[5-8]|N[1-7]|Q[1-4]|R[1-4]|S[1-4])-\d$/)
    }
    for (const key of WAVE_Q_ROUTES) expect(PENDING_ROUTES[key]?.owner, key).toBe('WS2')
    for (const key of WAVE_R_ROUTES) {
      expect(PENDING_ROUTES[key]?.owner, key).toBe(WAVE_R_OWNERS[key])
      expect(PENDING_ROUTES[key]?.item.slice(0, 2), key).toBe(`R${WAVE_R_OWNERS[key]?.slice(2)}`)
    }
    for (const key of WAVE_S_ROUTES) {
      expect(PENDING_ROUTES[key]?.owner, key).toBe(WAVE_S_OWNERS[key])
      expect(PENDING_ROUTES[key]?.item.slice(0, 2), key).toBe(`S${WAVE_S_OWNERS[key]?.slice(2)}`)
    }
  })

  it('wave S: a guest is refused exactly the five manage routes; no route has a creator row; pending until implemented', () => {
    const all = [...REVIEW_ROUTE_KEYS, ...ASSET_VERSION_ROUTE_KEYS] as string[]
    const guestRows = Object.entries(GUEST_REFUSED_ROUTES).filter(([k]) => all.includes(k))
    expect(guestRows.map(([k]) => k).sort()).toEqual([...REVIEW_MANAGE_ROUTE_KEYS].sort())
    for (const [k, m] of guestRows) expect(m, k).toBe(REVIEW_GUESTS_MESSAGE)
    // seeing the review, its history and the versions, and setting a status, stay open to a guest's link role
    for (const k of [
      'GET /api/boards/:bid/review',
      'GET /api/boards/:bid/review/items/:rvi/events',
      'POST /api/boards/:bid/review/items/:rvi/status',
      'GET /api/boards/:bid/asset-versions/:ast',
    ])
      expect(Object.hasOwn(GUEST_REFUSED_ROUTES, k), k).toBe(false)
    expect(Object.keys(CREATOR_ROUTES).filter((k) => all.includes(k))).toEqual([])
    for (const k of all) expect(isPendingRoute(k), k).toBe(WAVE_S_ROUTES.includes(k))
  })

  it('wave R: the guard lists hold exactly the contracts’ keys, every row pending until its route is', () => {
    const guestRows = Object.entries(GUEST_REFUSED_ROUTES).filter(([k]) => WAVE_R_ALL.includes(k))
    // every wave R route refuses a name-only guest, except the ticket-authorised backup download
    expect(guestRows.map(([k]) => k).sort()).toEqual(
      WAVE_R_ALL.filter((k) => k !== 'GET /api/boards/:bid/backup').sort(),
    )
    const message = (k: string) =>
      (BACKUP_ROUTE_KEYS as readonly string[]).includes(k) ? BACKUP_GUESTS_MESSAGE : IMPORT_GUESTS_MESSAGE
    for (const [k, m] of guestRows) expect(m, k).toBe(message(k))
    const creatorRows = Object.entries(CREATOR_ROUTES).filter(([k]) => WAVE_R_ALL.includes(k))
    const creates = [
      ...MIRO_IMPORT_CREATOR_ROUTE_KEYS,
      ...IMPORT_CREATOR_ROUTE_KEYS,
      ...BACKUP_CREATOR_ROUTE_KEYS,
    ]
    expect(creatorRows.map(([k]) => k).sort()).toEqual([...creates].sort())
    for (const [k, rule] of creatorRows)
      expect(rule, k).toEqual({
        purpose: (creates as readonly string[]).includes(k) ? 'create' : 'share',
        refuse: 'always',
      })
    for (const k of [...guestRows.map(([key]) => key), ...creatorRows.map(([key]) => key)])
      expect(isPendingRoute(k), k).toBe(WAVE_R_ROUTES.includes(k))
  })

  it('every chat hook route (wave R, WS2) has its guard rows and is live', () => {
    const guestRows = Object.entries(GUEST_REFUSED_ROUTES).filter(
      ([k]) => k.includes('/chat-hooks') || k.includes('/chat-prefs'),
    )
    expect(guestRows.map(([k]) => k).sort()).toEqual([...CHAT_HOOK_ROUTE_KEYS].sort())
    for (const [k, m] of guestRows) expect(m, k).toBe(CHAT_HOOK_GUESTS_MESSAGE)
    const creatorRows = Object.entries(CREATOR_ROUTES).filter(
      ([k]) => k.includes('/chat-hooks') || k.includes('/chat-prefs'),
    )
    expect(creatorRows.map(([k]) => k).sort()).toEqual([...CHAT_HOOK_CREATOR_ROUTE_KEYS].sort())
    for (const [k, rule] of creatorRows) expect(rule, k).toEqual({ purpose: 'share', refuse: 'always' })
    expect(CHAT_HOOK_ROUTE_KEYS.filter((k) => isPendingRoute(k))).toEqual([])
  })

  it('wave R backups (WS4): the ticket and the restore refuse guests, the restore needs a creator, all three live', () => {
    const backups = BACKUP_ROUTE_KEYS as readonly string[]
    const guestRows = Object.entries(GUEST_REFUSED_ROUTES).filter(([k]) => backups.includes(k))
    // the download itself is ticket-authorised: no guest row (its ticket route has one)
    const ticketed = backups.filter((k) => k !== 'GET /api/boards/:bid/backup')
    expect(guestRows.map(([k]) => k).sort()).toEqual(ticketed.sort())
    for (const [k, m] of guestRows) expect(m, k).toBe(BACKUP_GUESTS_MESSAGE)
    const creatorRows = Object.entries(CREATOR_ROUTES).filter(([k]) => backups.includes(k))
    expect(creatorRows.map(([k]) => k)).toEqual([...BACKUP_CREATOR_ROUTE_KEYS])
    for (const [k, rule] of creatorRows) expect(rule, k).toEqual({ purpose: 'create', refuse: 'always' })
    expect(backups.filter((k) => isPendingRoute(k))).toEqual([])
  })

  it('every wave Q route has its guest row (all of them) and the eight writes their in-route creator rows, all live', () => {
    // the api's guard lists hold exactly the contract's keys
    const guestRows = Object.keys(GUEST_REFUSED_ROUTES).filter((k) => k.includes('/library'))
    expect(guestRows.sort()).toEqual([...LIBRARY_GUEST_ROUTE_KEYS].sort())
    for (const k of guestRows) expect(GUEST_REFUSED_ROUTES[k], k).toBe(LIBRARY_GUESTS_MESSAGE)
    const creatorRows = Object.entries(CREATOR_ROUTES).filter(([k]) => k.includes('/library'))
    expect(creatorRows.map(([k]) => k).sort()).toEqual([...LIBRARY_CREATOR_IN_ROUTE_KEYS].sort())
    for (const [k, rule] of creatorRows) expect(rule, k).toEqual({ purpose: 'create', refuse: 'in-route' })
    // WS2 implemented every one of them: the refusal and creation matrices hold each to its guard rows
    for (const k of [...guestRows, ...creatorRows.map(([key]) => key)])
      expect(isPendingRoute(k), k).toBe(false)
    expect(LIBRARY_ROUTE_KEYS.filter((k) => isPendingRoute(k))).toEqual([])
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
      'library_folders',
      'library_items',
      'library_item_files',
      'library_marks',
      'board_imports',
      'board_import_files',
      'chat_hooks',
      'chat_hook_prefs',
      'chat_deliveries',
      'review_rounds',
      'review_items',
      'review_events',
    ]) {
      const n = await w.api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
      expect(n.n, table).toBe(0)
    }
  })
})
