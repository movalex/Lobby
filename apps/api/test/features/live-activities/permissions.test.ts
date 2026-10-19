// OWNER: WS1 (wave V). Who may do what with a live activity (docs/WAVE-V-CONTRACTS.md §6.2), checked server-side per
// route, for every kind of caller: owner, account editor, commenter, viewer, a name-only guest on a workshop (editor)
// link, a name-only guest on a review link, a client account on a review link, a member without access, and the same
// on an archived and a trashed board. A refusal changes nothing.

import {
  ACTIVITY_ROUTE_KEYS,
  ACTIVITY_RULES,
  activitiesPath,
  activityActionPath,
  activityPath,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  act,
  answer,
  type Caller,
  errorCode,
  expectStatus,
  idOf,
  POLL,
  setupWorld,
  start,
  tab,
  WORDS,
  type World,
} from './support.ts'

let w: World
afterEach(async () => {
  await w?.close()
})

type Who = 'owner' | 'editor' | 'commenter' | 'viewer' | 'guest' | 'reviewGuest' | 'client' | 'outsider'
const WHO: Who[] = ['owner', 'editor', 'commenter', 'viewer', 'guest', 'reviewGuest', 'client', 'outsider']
const caller = (who: Who): Caller => w[who]

/** Every manage route, called as a client would (the body each needs). */
const MANAGE: [string, 'close' | 'reveal' | 'extend' | 'cancel' | 'hide' | 'placed', unknown][] = [
  ['POST /api/activities/:aid/close', 'close', {}],
  ['POST /api/activities/:aid/reveal', 'reveal', {}],
  ['POST /api/activities/:aid/extend', 'extend', { addMs: 60_000 }],
  ['POST /api/activities/:aid/cancel', 'cancel', {}],
  ['POST /api/activities/:aid/hide', 'hide', { word: 'rude' }],
  ['POST /api/activities/:aid/placed', 'placed', {}],
]

const snapshotOfTables = async () =>
  JSON.stringify(
    (
      await w.api.db.query(
        `SELECT a.id, a.status, a.hidden, a.ends_at, a.placed_at, a.results,
                (SELECT count(*)::int FROM live_answers x WHERE x.activity_id = a.id) AS n
           FROM live_activities a ORDER BY a.id`,
      )
    ).rows,
  )

describe('the rules', () => {
  it('match the contracts: the manage routes are the six above and the named answers', () => {
    const manage = ACTIVITY_ROUTE_KEYS.filter((k) => ACTIVITY_RULES[k] === 'manage')
    expect([...manage].sort()).toEqual([...MANAGE.map(([k]) => k), 'GET /api/activities/:aid/answers'].sort())
  })
})

describe('on an active board', () => {
  it('everyone with access sees the activity and the list; a member without access gets 404', async () => {
    w = await setupWorld()
    await start(w.owner, w.board, POLL)
    for (const who of WHO) {
      const a = await caller(who).req('GET', activityPath(w.board))
      const l = await caller(who).req('GET', activitiesPath(w.board))
      const want = who === 'outsider' ? 404 : 200
      expect([who, a.statusCode, l.statusCode]).toEqual([who, want, want])
    }
  })

  it('everyone with access answers (guests, viewers, a client included); a member without access gets 404', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    for (const who of WHO) {
      const res = await answer(caller(who), aid, { kind: 'poll', choices: [0] })
      expect([who, res.statusCode]).toEqual([who, who === 'outsider' ? 404 : 200])
    }
    const n = await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM live_answers')
    expect(n.n).toBe(WHO.length - 1)
  })

  it('only account editors start one: 403 for commenter, viewer, client; GUEST_ACCOUNT_REQUIRED for guests; 404 without access', async () => {
    w = await setupWorld()
    for (const who of WHO) {
      if (who === 'owner' || who === 'editor') continue
      const res = await caller(who).req('POST', activitiesPath(w.board), POLL)
      const want =
        who === 'outsider'
          ? [404, 'NOT_FOUND']
          : who === 'guest' || who === 'reviewGuest'
            ? [403, 'GUEST_ACCOUNT_REQUIRED']
            : [403, 'FORBIDDEN']
      expect([who, res.statusCode, errorCode(res)]).toEqual([who, ...want])
    }
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM live_activities')).n).toBe(0)
    // a name-only guest on the workshop link is an editor of the board, and still cannot
    const guestRole = await w.api.db.one<{ role: string }>(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [w.board, w.guest.userId],
    )
    expect(guestRole.role).toBe('editor')
    await start(w.editor, w.board, WORDS)
  })

  it('every manage route refuses everyone but its managers, and a refusal changes nothing', async () => {
    w = await setupWorld()
    // the starter has the board open (with no tab of it, they left: activities.test.ts)
    tab(w, w.editor)
    const aid = idOf(await start(w.editor, w.board, { ...WORDS, durationMs: 120_000 }))
    expectStatus(await answer(w.viewer, aid, { kind: 'words', words: ['hello'] }), 200)
    const before = await snapshotOfTables()
    const refusals: Record<Who, [number, string] | null> = {
      owner: null,
      editor: null,
      // the starter is still on the board: another account editor may not (editor2, below)
      commenter: [403, 'FORBIDDEN'],
      viewer: [403, 'FORBIDDEN'],
      client: [403, 'FORBIDDEN'],
      guest: [403, 'GUEST_ACCOUNT_REQUIRED'],
      reviewGuest: [403, 'GUEST_ACCOUNT_REQUIRED'],
      outsider: [404, 'NOT_FOUND'],
    }
    for (const [route, action, body] of MANAGE) {
      for (const who of WHO) {
        const want = refusals[who]
        if (!want) continue
        const res = await act(caller(who), aid, action, body)
        expect([route, who, res.statusCode, errorCode(res)]).toEqual([route, who, ...want])
      }
      const other = await act(w.editor2, aid, action, body)
      expect([route, other.statusCode, errorCode(other)]).toEqual([route, 403, 'ACTIVITY_NOT_YOURS'])
    }
    expect(await snapshotOfTables()).toBe(before)
    // the results while open: managers (the starter, the owner) only; others 404 (not live)
    for (const who of WHO) {
      const res = await caller(who).req('GET', activityActionPath(aid, 'results'))
      expect([who, res.statusCode]).toEqual([who, who === 'owner' || who === 'editor' ? 200 : 404])
    }
  })

  it('an unknown or malformed activity id is a 404 for everyone', async () => {
    w = await setupWorld()
    for (const aid of ['act_0123456789abcdefghij', 'nope', 'vot_0123456789abcdefghij'])
      for (const who of ['owner', 'viewer'] as const) {
        expect((await answer(caller(who), aid, { kind: 'poll', choices: [0] })).statusCode).toBe(404)
        expect((await act(caller(who), aid, 'close')).statusCode).toBe(404)
        expect((await caller(who).req('GET', activityActionPath(aid, 'results'))).statusCode).toBe(404)
      }
  })

  it('anonymous callers get 401', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    expect((await w.api.anon('GET', activityPath(w.board))).statusCode).toBe(401)
    expect(
      (
        await w.api.anon('POST', activityActionPath(aid, 'answer'), {
          answer: { kind: 'poll', choices: [0] },
        })
      ).statusCode,
    ).toBe(401)
  })
})

describe('on an archived board', () => {
  it('reads go on (the state, the list, revealed results, named answers); answers are 409, starting and managing 403', async () => {
    w = await setupWorld()
    const named = idOf(await start(w.owner, w.board, { ...POLL, anonymous: false }))
    expectStatus(await answer(w.viewer, named, { kind: 'poll', choices: [1] }), 200)
    expectStatus(await act(w.owner, named, 'reveal'), 200)
    w.clock.advance(10)
    const open = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/archive`, {}), 200)
    const before = await snapshotOfTables()
    for (const who of WHO) {
      const want = who === 'outsider' ? 404 : 200
      expect([who, (await caller(who).req('GET', activityPath(w.board))).statusCode]).toEqual([who, want])
      expect([who, (await caller(who).req('GET', activitiesPath(w.board))).statusCode]).toEqual([who, want])
      expect([who, (await caller(who).req('GET', activityActionPath(named, 'results'))).statusCode]).toEqual([
        who,
        want,
      ])
      const a = await answer(caller(who), open, { kind: 'poll', choices: [0] })
      expect([who, a.statusCode, errorCode(a)]).toEqual(
        who === 'outsider' ? [who, 404, 'NOT_FOUND'] : [who, 409, 'BOARD_READ_ONLY'],
      )
    }
    for (const who of ['owner', 'editor'] as const) {
      expect((await caller(who).req('POST', activitiesPath(w.board), WORDS)).statusCode).toBe(403)
      for (const [, action, body] of MANAGE)
        expect([who, action, (await act(caller(who), open, action, body)).statusCode]).toEqual([
          who,
          action,
          403,
        ])
    }
    expect(await snapshotOfTables()).toBe(before)
    // the named answers are a read: the starter may still read them
    expectStatus(await w.owner.req('GET', activityActionPath(named, 'answers')), 200)
  })
})

describe('on a trashed board', () => {
  it('every route is a 404 for everyone, its owner included (a guest is refused the facilitator routes first)', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/trash`, {}), 200)
    for (const who of WHO) {
      const c = caller(who)
      const guest = who === 'guest' || who === 'reviewGuest'
      // the guard rows refuse a name-only guest before any board check (contracts §6.2)
      for (const [res, facilitator] of [
        [await c.req('GET', activityPath(w.board)), false],
        [await c.req('GET', activitiesPath(w.board)), false],
        [await c.req('POST', activitiesPath(w.board), POLL), true],
        [await answer(c, aid, { kind: 'poll', choices: [0] }), false],
        [await act(c, aid, 'close'), true],
        [await c.req('GET', activityActionPath(aid, 'results')), false],
      ] as const)
        expect([who, res.statusCode]).toEqual([who, guest && facilitator ? 403 : 404])
    }
  })
})
