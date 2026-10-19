// Wave M, M5-1 (S4, PWR-8, CAP-PG-OPEN): GET /api/boards/:bid/open-state answers the board-open burst's eight panel
// reads together. Each part must be exactly what its own route answers the same caller, or null where that route
// refuses; one session lookup and one access check for all of them, on one READ ONLY transaction.
import {
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  OPEN_STATE_EVENTS_SEQ_PATTERN,
  OPEN_STATE_PARTS,
  OpenStateBody,
  type OpenStatePart,
  openStatePath,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { countQueries, isSessionLookup, type QueryCounter } from '../../query-count.ts'
import { type AiWorld, aiWorld } from '../ai/support.ts'
import { type GuestClient, guestLink, joinAsGuest, tokenOf } from '../guests/support.ts'
import { FakeSync } from '../workshops/support.ts'

/** Each part's own route (what the web asks for when it has no open-state answer). */
const ROUTES: Record<OpenStatePart, (bid: string) => string> = {
  exportPolicy: (b) => `/api/boards/${b}/export-policy`,
  outside: (b) => `/api/boards/${b}/sharing/outside`,
  sharing: (b) => `/api/boards/${b}/sharing`,
  workshop: (b) => `/api/boards/${b}/workshop`,
  presentation: (b) => `/api/boards/${b}/presentation`,
  privateBrainstorm: (b) => `/api/boards/${b}/private-brainstorm`,
  threads: (b) => `/api/boards/${b}/threads?status=all`,
  ai: (b) => `/api/boards/${b}/ai`,
  // wave V (OPEN_STATE_PENDING_PARTS: checked here once their owners move them into OPEN_STATE_PARTS)
  activity: (b) => `/api/boards/${b}/activity`,
  breakouts: (b) => `/api/boards/${b}/breakouts`,
}

const REV = { [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV) }
const TARGET = { frameId: 'shape:frame1', pageId: 'page:page', x: 100, y: 200, w: 1120, h: 720 }

type Caller = Pick<Client, 'req'>

let base: Db
let counter: QueryCounter
let api: TestApi
let hub: EventHub
const t = Date.now()
const clock = { now: () => new Date(t) }
let owner: Client
let editor: Client
let commenter: Client
let viewer: Client
let stranger: Client // a Dev Studio member without access to the board
let outsider: Client // an account in no shared workspace
let revoked: Client
let reviewer: Client // an account that came in through a review link (a workspace guest)
let guest: GuestClient // a name-only guest from a guest link (link caps apply)
let board: string

const ok = (res: { statusCode: number; body: string }, status = 200) => {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`)
  return res
}

beforeAll(async () => {
  base = await openTestDb()
  counter = countQueries(base)
  hub = new EventHub()
  api = await createTestApi({
    db: counter.db,
    deps: { events: hub, syncInternal: new FakeSync(), now: clock.now },
  })
  owner = await api.login('ada', 'Ada Owner')
  editor = await api.login('ed', 'Ed Editor')
  commenter = await api.login('cora', 'Cora Commenter')
  viewer = await api.login('vic', 'Vic Viewer')
  stranger = await api.login('stan', 'Stan Stranger')
  revoked = await api.login('rev', 'Rev Revoked')
  outsider = await api.login('otto', 'Otto Outsider', { email: 'otto@client.example' })
  reviewer = await api.login('rita', 'Rita Reviewer', { email: 'rita@client.example' })
  // Otto and Rita are in no shared workspace with Ada: they leave Dev Studio
  for (const c of [outsider, reviewer])
    await base.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      c.userId,
    ])
  board = await createBoard(owner, DEV_STUDIO, 'Open state')
  for (const [c, role] of [
    [editor, 'editor'],
    [commenter, 'commenter'],
    [viewer, 'viewer'],
    [revoked, 'viewer'],
  ] as const)
    ok(await owner.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role }))
  ok(await owner.req('DELETE', `/api/boards/${board}/members/${revoked.userId}`))
  // what the parts describe: links, a policy, threads (one team only), a timer, a private brainstorm, a presentation
  const review = await guestLink(owner, board, { role: 'commenter', allowGuests: false })
  ok(await reviewer.req('POST', `/api/invitations/${tokenOf(review.url)}/accept`))
  guest = await joinAsGuest(api, (await guestLink(owner, board, { role: 'editor', maxUses: 5 })).url, 'Sam')
  ok(await owner.req('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'editors' }))
  ok(
    await owner.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 1, y: 2 },
      body: 'Hi all',
    }),
    201,
  )
  ok(
    await owner.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 3, y: 4 },
      body: 'Team only',
      visibility: 'team',
    }),
    201,
  )
  ok(await owner.req('POST', `/api/boards/${board}/timer`, { action: 'start', durationMs: 300_000 }))
  ok(
    await owner.req('POST', `/api/boards/${board}/private-brainstorm`, {
      prompt: 'What should we stop doing?',
      anonymous: false,
      target: TARGET,
    }),
    201,
  )
  ok(
    await owner.req('POST', `/api/boards/${board}/presentation`, {
      tab: 'tab-0123456789',
      slideId: null,
      index: 0,
      count: 3,
    }),
  )
})
afterAll(async () => {
  await api.close()
  await base.close()
})

async function openState(c: Caller, bid = board) {
  const res = await c.req('GET', openStatePath(bid), undefined, REV as never)
  return { res, body: res.statusCode === 200 ? OpenStateBody.parse(res.json()) : null }
}

/** A part without its `serverNow` (the time of the answer: equal only on a fixed clock). */
const withoutServerNow = (v: unknown) => {
  if (!v || typeof v !== 'object') return v
  const { serverNow: _, ...rest } = v as Record<string, unknown>
  return rest
}

/** Every part against its own route, for this caller: equal bodies, or null where the route refuses. */
async function expectParity(
  who: string,
  c: Caller,
  bid = board,
  normalise: (part: unknown) => unknown = (v) => v,
) {
  const { res, body } = await openState(c, bid)
  expect(res.statusCode, `${who}: ${res.body}`).toBe(200)
  expect(res.headers['cache-control'], who).toBe('no-store')
  const refused: OpenStatePart[] = []
  for (const part of OPEN_STATE_PARTS) {
    const own = await c.req('GET', ROUTES[part](bid), undefined, REV as never)
    if (own.statusCode === 200)
      expect(normalise(body?.[part]), `${who}: ${part}`).toEqual(normalise(own.json()))
    else {
      expect([403, 404], `${who}: ${part} answered ${own.statusCode}`).toContain(own.statusCode)
      expect(body?.[part], `${who}: ${part} (refused)`).toBeNull()
      refused.push(part)
    }
  }
  return { body, refused }
}

describe('GET /api/boards/:bid/open-state: each part is its own route’s body (parity per role)', () => {
  it('the owner, an editor, a commenter and a viewer: every part, as its route answers them', async () => {
    for (const [who, c] of [
      ['owner', owner],
      ['editor', editor],
      ['commenter', commenter],
      ['viewer', viewer],
    ] as const) {
      const { body, refused } = await expectParity(who, c)
      expect(refused, who).toEqual([])
      expect(body?.eventsSeq, who).toMatch(OPEN_STATE_EVENTS_SEQ_PATTERN)
    }
    // the parts differ by role as their routes do (a sanity check that the comparison compares something)
    const v = (await openState(viewer)).body
    const o = (await openState(owner)).body
    expect(o?.exportPolicy?.canExport).toBe(true)
    expect(v?.exportPolicy?.canExport).toBe(false)
    expect(o?.sharing?.pendingRequests).toBe(0)
    expect(v?.sharing?.pendingRequests).toBeNull()
    expect(o?.threads?.threads).toHaveLength(2)
    expect(o?.workshop?.timer?.status).toBe('running')
    expect(o?.presentation?.presentation).not.toBeNull()
    expect(o?.privateBrainstorm?.session).not.toBeNull()
  })

  it('a name-only guest from a guest link (link caps) and a review-link account: their own parts', async () => {
    const g = await expectParity('guest', guest)
    expect(g.refused).toEqual([])
    const r = await expectParity('reviewer', reviewer)
    expect(r.refused).toEqual([])
    // the team-only thread is the team's only
    expect(r.body?.threads?.threads).toHaveLength(1)
    expect(g.body?.threads?.threads).toHaveLength(1)
  })

  it('an outsider, a workspace member without access and a revoked viewer: every part null, no event position', async () => {
    for (const [who, c] of [
      ['outsider', outsider],
      ['stranger', stranger],
      ['revoked', revoked],
    ] as const) {
      const { body, refused } = await expectParity(who, c)
      expect(refused, who).toEqual([...OPEN_STATE_PARTS])
      expect(body?.eventsSeq, who).toBeUndefined()
    }
  })

  it('an unknown or malformed board id answers exactly like a board the caller may not see', async () => {
    const real = (await openState(stranger)).res.json()
    for (const bid of ['b-zzzzzzzzzzzz', 'not-a-board'])
      expect((await openState(stranger, bid)).res.json(), bid).toEqual(real)
  })

  it('an internal-only workspace: the parts still match (the outside part says so)', async () => {
    ok(await owner.req('PUT', `/api/workspaces/${DEV_STUDIO}/internal-only`, { internalOnly: true }))
    try {
      for (const [who, c] of [
        ['owner', owner],
        ['viewer', viewer],
        ['guest', guest],
      ] as const) {
        const { body } = await expectParity(`internal-only ${who}`, c)
        expect(body?.outside?.internalOnly, who).toBe('workspace')
      }
    } finally {
      ok(await owner.req('PUT', `/api/workspaces/${DEV_STUDIO}/internal-only`, { internalOnly: false }))
    }
  })

  it('needs a session: anonymous is a 401, like every part’s route', async () => {
    expect((await api.anon('GET', openStatePath(board))).statusCode).toBe(401)
  })
})

/** The api's background sweepers (guests, review links: every 5 s on their own timers), not a request's statements. */
const BACKGROUND_SWEEPS = [
  /^SELECT id FROM invitations WHERE multi_use AND swept_at IS NULL /,
  /^SELECT u.id FROM users u WHERE u.kind = 'guest' AND EXISTS /,
]

describe('GET /api/boards/:bid/open-state: what it costs the database', () => {
  it('one session lookup, one access check, one READ ONLY transaction, and no pooled query while it is open (each role)', async () => {
    // the review's nit: not only a viewer (the owner reads every part's manager view, a guest its link's caps)
    for (const [who, c] of [
      ['viewer', viewer],
      ['owner', owner],
      ['editor', editor],
      ['guest', guest],
      ['reviewer', reviewer],
    ] as const) {
      counter.reset()
      const { res } = await openState(c)
      expect(res.statusCode, who).toBe(200)
      const all = counter.statements
      expect(all.filter(isSessionLookup), who).toHaveLength(1)
      const accessChecks = all.filter((s) =>
        /FROM boards b JOIN workspaces w ON w\.id = b\.workspace_id LEFT JOIN workspace_members wm ON wm\.workspace_id = b\.workspace_id AND wm\.user_id = \$2/.test(
          s.sql,
        ),
      )
      expect(accessChecks, who).toHaveLength(1)
      expect(counter.transactions, who).toBe(1)
      const inTx = all.filter((s) => s.inTransaction)
      expect(inTx[0]?.sql, who).toBe('SET TRANSACTION READ ONLY')
      expect(accessChecks[0]?.inTransaction, who).toBe(true)
      // nothing on the pool while the transaction held its client (a capped pool must not wait on itself); the app's
      // own background sweepers run on their own timers, and on a real Postgres can land inside the window
      expect(
        all.filter((s) => s.duringTransaction && !BACKGROUND_SWEEPS.some((r) => r.test(s.sql))),
        who,
      ).toEqual([])
    }
  })

  it('the separate reads it replaces cost a session lookup and an access check each', async () => {
    counter.reset()
    for (const part of OPEN_STATE_PARTS)
      ok(await viewer.req('GET', ROUTES[part](board), undefined, REV as never))
    expect(counter.statements.filter(isSessionLookup)).toHaveLength(OPEN_STATE_PARTS.length)
  })
})

describe('GET /api/boards/:bid/open-state: the event position', () => {
  it('moves with every event published to the board and every access change on it, and with nothing else', async () => {
    const a = (await openState(viewer)).body?.eventsSeq
    expect((await openState(viewer)).body?.eventsSeq).toBe(a)
    // another board's event: no move
    const other = await createBoard(owner, DEV_STUDIO, 'Elsewhere')
    hub.publish(other, { type: 'x.test', data: null })
    expect((await openState(viewer)).body?.eventsSeq).toBe(a)
    hub.publish(board, { type: 'x.test', data: null })
    const b = (await openState(viewer)).body?.eventsSeq
    expect(b).not.toBe(a)
    hub.accessChanged({ boardId: board })
    expect((await openState(viewer)).body?.eventsSeq).not.toBe(b)
    expect(hub.boardPosition(board)).toBe((await openState(viewer)).body?.eventsSeq)
  })
})

describe('GET /api/boards/:bid/open-state with AI on (the ai part’s reads inside the READ ONLY transaction)', () => {
  // the review's nit: the suite above runs with AI off, so the ai part's own path (the person's kind, the switches,
  // may-export, the notice and the owner's budget, which takes its own SAVEPOINT) is exercised here
  let w: AiWorld
  beforeAll(async () => {
    w = await aiWorld()
  })
  afterAll(async () => {
    await w.close()
  })

  it('the workspace owner (a budget), an editor, a commenter, a viewer and a non-member: every part, as its route', async () => {
    for (const [who, c] of [
      ['owner', w.alice],
      ['editor', w.bob],
      ['commenter', w.carol],
      ['viewer', w.dave],
    ] as const) {
      // the AI world runs on the real clock: the answers' own time is all that may differ
      const { body, refused } = await expectParity(`ai on: ${who}`, c, w.board, withoutServerNow)
      expect(refused, who).toEqual([])
      expect(body?.ai?.enabled, who).toBe(true)
    }
    const owner = (await openState(w.alice, w.board)).body
    expect(owner?.ai?.budget).not.toBeNull()
    expect((await openState(w.bob, w.board)).body?.ai?.budget).toBeNull()
    const erin = await expectParity('ai on: non-member', w.erin, w.board, withoutServerNow)
    expect(erin.refused).toEqual([...OPEN_STATE_PARTS])
  })
})
