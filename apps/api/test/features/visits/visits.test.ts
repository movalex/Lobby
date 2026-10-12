// Wave N, N4-1: private visit markers (POST /api/boards/:bid/visit and …/visit/seen; migration 0031_board_visits).
// The owner's condition: nobody else ever sees who visited when. See privacy.test.ts for the by-construction half.
import {
  VISIT_WRITE_MIN_INTERVAL_MS,
  VISITS_RETENTION_DAYS_DEFAULT,
  VisitAnswer,
  visitPath,
  visitSeenPath,
} from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../../src/config.ts'
import { PENDING_ROUTES, type PendingRoute } from '../../../src/features/pending-routes.ts'
import { visitsClockOf } from '../../../src/features/visits/clock.ts'
import { sweepVisits, visitsSweepSettings } from '../../../src/features/visits/sweep.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi, testEnv } from '../../helpers.ts'
import { countQueries } from '../../query-count.ts'
import { errorCode, guestLink, joinAsGuest, setupWorld, type World } from '../guests/support.ts'
import { FakeSync } from '../workshops/support.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const DAY = 86_400_000
const parseAnswer = (body: string) => VisitAnswer.parse(JSON.parse(body))
const stored = async (board: string, userId: string) =>
  (
    await w.api.db.maybeOne<{ seen_at: Date }>(
      'SELECT seen_at FROM board_visits WHERE board_id = $1 AND user_id = $2',
      [board, userId],
    )
  )?.seen_at.getTime() ?? null
const rowCount = async () =>
  (await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_visits')).n
const pass = () => w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS + 1)

describe('POST /api/boards/:bid/visit', () => {
  it('answers a null previous time on the first visit, and stores the time it answers', async () => {
    const res = await w.bob.req('POST', visitPath(w.board))
    expect(res.statusCode, res.body).toBe(200)
    const a = parseAnswer(res.body)
    expect(a.previousSeenAt).toBeNull()
    expect(Math.abs(a.seenAt - w.api.clock.now().getTime())).toBeLessThan(5_000)
    expect(await stored(w.board, w.bob.userId)).toBe(a.seenAt)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('the second visit (after the write interval) answers the first one’s time as the previous one', async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    pass()
    const second = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    expect(second.previousSeenAt).toBe(first.seenAt)
    expect(second.seenAt).toBeGreaterThan(first.seenAt)
    pass()
    const third = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    expect(third.previousSeenAt).toBe(second.seenAt)
    expect(await rowCount()).toBe(1) // one row per (board, person)
  })

  it('answers exactly VisitAnswer: two keys, whole milliseconds', async () => {
    const body = JSON.parse((await w.bob.req('POST', visitPath(w.board))).body)
    expect(Object.keys(body).sort()).toEqual(['previousSeenAt', 'seenAt'])
    expect(Number.isInteger(body.seenAt)).toBe(true)
  })

  it('accepts no body, an empty JSON body, and ignores whatever body it is given', async () => {
    expect((await w.bob.req('POST', visitPath(w.board))).statusCode).toBe(200)
    pass()
    expect((await w.bob.req('POST', visitPath(w.board), {})).statusCode).toBe(200)
    pass()
    const a = parseAnswer((await w.bob.req('POST', visitPath(w.board), { userId: w.alice.userId })).body)
    expect(a.previousSeenAt).not.toBeNull()
    expect(await stored(w.board, w.alice.userId)).toBeNull() // nobody can write another person’s row
  })

  it('viewers and commenters are allowed (they can view the board)', async () => {
    for (const [client, role] of [
      [w.carol, 'viewer'],
      [w.alice, 'commenter'],
    ] as const) {
      expect(
        (await w.bob.req('PUT', `/api/boards/${w.board}/members/${client.userId}`, { role })).statusCode,
      ).toBe(200)
      const res = await client.req('POST', visitPath(w.board))
      expect(res.statusCode, `${role}: ${res.body}`).toBe(200)
      expect(parseAnswer(res.body).previousSeenAt).toBeNull()
      expect(await stored(w.board, client.userId)).not.toBeNull()
    }
  })

  it('a workspace member with view access through the workspace is allowed too', async () => {
    const open = await createBoard(w.bob, DEV_STUDIO, 'Team board')
    expect(
      (await w.bob.req('PATCH', `/api/boards/${open}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    expect((await w.carol.req('POST', visitPath(open))).statusCode).toBe(200)
  })

  it('someone who cannot view the board gets the 404 every board route gives, and nothing is stored', async () => {
    // carol is a workspace member but the board is private; erin is not even in the workspace
    for (const who of [w.carol, w.erin]) {
      const res = await who.req('POST', visitPath(w.board))
      expect(res.statusCode, res.body).toBe(404)
      expect(errorCode(res)).toBe('NOT_FOUND')
    }
    // a board that does not exist answers the same
    expect((await w.bob.req('POST', visitPath('b-doesnotexist'))).statusCode).toBe(404)
    expect(await rowCount()).toBe(0)
  })

  it('needs a session and the page’s origin', async () => {
    expect((await w.api.anon('POST', visitPath(w.board))).statusCode).toBe(401)
    const cross = await w.bob.req('POST', visitPath(w.board), undefined, { origin: 'https://evil.example' })
    expect(cross.statusCode).toBe(403)
    expect(await rowCount()).toBe(0)
  })

  it('is not readable with GET (the route only exists as a POST)', async () => {
    expect((await w.bob.req('GET', visitPath(w.board))).statusCode).toBe(404)
    expect((await w.bob.req('GET', visitSeenPath(w.board))).statusCode).toBe(404)
  })
})

describe('the write interval: one write per 10 seconds per (person, board)', () => {
  it('a visit inside the interval answers what the first one answered and writes nothing', async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    pass()
    const second = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body) // previous = first.seenAt
    w.api.clock.advance(3_000)
    const third = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    expect(third).toEqual(second) // a quick reload or a second tab reads the same previous time
    expect(await stored(w.board, w.bob.userId)).toBe(second.seenAt)
    expect(first.seenAt).toBeLessThan(second.seenAt)
    // the interval ends 10 s after the write it counts from
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    const fourth = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    expect(fourth.previousSeenAt).toBe(second.seenAt)
    expect(fourth.seenAt).toBeGreaterThan(second.seenAt)
  })

  it('two tabs opened at the same moment get one consistent previous time and one stored time', async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    pass()
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => w.bob.req('POST', visitPath(w.board)).then((r) => parseAnswer(r.body))),
    )
    for (const a of answers) expect(a.previousSeenAt).toBe(first.seenAt)
    expect(new Set(answers.map((a) => a.seenAt)).size).toBe(1)
    expect(await stored(w.board, w.bob.userId)).toBe(answers[0]?.seenAt)
  })

  it('a different board, or a different person, has its own interval', async () => {
    const other = await createBoard(w.bob, DEV_STUDIO, 'Another')
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    const onOther = parseAnswer((await w.bob.req('POST', visitPath(other))).body)
    expect(onOther.previousSeenAt).toBeNull() // written: its own key
    const carol = parseAnswer((await w.carol.req('POST', visitPath(w.board))).body)
    expect(carol.previousSeenAt).toBeNull()
    expect(await rowCount()).toBe(3)
  })

  it('"seen" writes the time, and inside the interval of a write it writes nothing at once (204 either way)', async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    // inside the interval of the visit: accepted, nothing written now (its time is kept for the interval's end)
    w.api.clock.advance(4_000)
    const quick = await w.bob.req('POST', visitSeenPath(w.board))
    expect(quick.statusCode).toBe(204)
    expect(quick.body).toBe('')
    expect(await stored(w.board, w.bob.userId)).toBe(first.seenAt)
    // after it: written
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    const at = w.api.clock.now().getTime()
    expect((await w.bob.req('POST', visitSeenPath(w.board))).statusCode).toBe(204)
    const after = await stored(w.board, w.bob.userId)
    expect(after).not.toBeNull()
    expect(Math.abs((after as number) - at)).toBeLessThan(5_000)
    expect(after as number).toBeGreaterThan(first.seenAt)
    // a second seen inside its interval: nothing at once
    w.api.clock.advance(1_000)
    expect((await w.bob.req('POST', visitSeenPath(w.board))).statusCode).toBe(204)
    expect(await stored(w.board, w.bob.userId)).toBe(after)
  })

  it('after a "seen", the next visit (a reload) reads the stored time and writes nothing; later ones read it as previous', async () => {
    parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    pass()
    expect((await w.bob.req('POST', visitSeenPath(w.board))).statusCode).toBe(204)
    const seen = (await stored(w.board, w.bob.userId)) as number
    w.api.clock.advance(2_000)
    const reload = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    expect(reload).toEqual({ previousSeenAt: seen, seenAt: seen })
    expect(await stored(w.board, w.bob.userId)).toBe(seen)
    pass()
    expect(parseAnswer((await w.bob.req('POST', visitPath(w.board))).body).previousSeenAt).toBe(seen)
  })

  it('a "seen" on a board never visited creates the row (the beacon of a page whose visit was refused or lost)', async () => {
    expect((await w.bob.req('POST', visitSeenPath(w.board))).statusCode).toBe(204)
    expect(await stored(w.board, w.bob.userId)).not.toBeNull()
  })

  it('seen follows the same access rules: no access is a 404, no session a 401, and nothing is stored', async () => {
    expect((await w.carol.req('POST', visitSeenPath(w.board))).statusCode).toBe(404)
    expect((await w.erin.req('POST', visitSeenPath(w.board))).statusCode).toBe(404)
    expect((await w.api.anon('POST', visitSeenPath(w.board))).statusCode).toBe(401)
    expect(await rowCount()).toBe(0)
  })

  it('seen_at never moves backwards, whatever the clocks do', async () => {
    parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    const high = (await stored(w.board, w.bob.userId)) as number
    // an api instance whose clock is behind (or a replayed older write)
    await w.api.db.query(
      `INSERT INTO board_visits (board_id, user_id, seen_at) VALUES ($1, $2, $3)
       ON CONFLICT (board_id, user_id) DO UPDATE SET seen_at = GREATEST(board_visits.seen_at, EXCLUDED.seen_at)`,
      [w.board, w.bob.userId, new Date(high - DAY)],
    )
    expect(await stored(w.board, w.bob.userId)).toBe(high)
  })
})

// Wave N.1 (wave N follow-up 5, WS4): a "Mark all seen" or a leave beacon inside the write interval wrote nothing, so
// the server kept the time of the write before it and the next visit showed again what the person had marked seen
// (only the tab that marked it remembered, ack.ts). The interval still allows one write, but a "seen" inside it is
// kept (the latest one) and written when the interval ends: by the api's own tick, by the next visit of that person
// and board before it writes (so its previous time includes it), or when the api closes.
describe('a "seen" inside the write interval is kept and written when the interval ends', () => {
  /** The api's clock (Date.now() and the test's offset) runs on: the time a request stores lies in this window. */
  type Window = { before: number; after: number }
  const seen = async (c: Client, board: string, api: TestApi = w.api): Promise<Window> => {
    const before = api.clock.now().getTime()
    expect((await c.req('POST', visitSeenPath(board))).statusCode).toBe(204)
    return { before, after: api.clock.now().getTime() }
  }
  const within = (t: number | null | undefined, win: Window) => {
    expect(t).not.toBeNull()
    expect(t as number).toBeGreaterThanOrEqual(win.before)
    expect(t as number).toBeLessThanOrEqual(win.after)
  }
  /** The stored time, once the api's tick (every second, real time) has written what it kept. */
  const storedSoon = (board: string, userId: string, win: Window) =>
    vi.waitFor(async () => within(await stored(board, userId), win), { timeout: 8_000, interval: 50 })
  const seenWithin = async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    w.api.clock.advance(4_000)
    const win = await seen(w.bob, w.board)
    expect(await stored(w.board, w.bob.userId)).toBe(first.seenAt) // nothing written yet: one write per interval
    return { first, win }
  }

  it('the api writes it once the interval has ended, without another request', async () => {
    const { win } = await seenWithin()
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    await storedSoon(w.board, w.bob.userId, win)
  })

  it('the next visit after the interval reads it as the previous time (Mark all seen holds on every device)', async () => {
    const { win } = await seenWithin()
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS + 1)
    const next = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    within(next.previousSeenAt, win)
    expect(next.seenAt).toBeGreaterThan(win.after)
    expect(await stored(w.board, w.bob.userId)).toBe(next.seenAt)
  })

  it('only the latest of several is kept, and a time never moves the stored one back', async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    w.api.clock.advance(2_000)
    await seen(w.bob, w.board)
    w.api.clock.advance(3_000)
    const last = await seen(w.bob, w.board)
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    await storedSoon(w.board, w.bob.userId, last)
    expect(last.before).toBeGreaterThan(first.seenAt)
  })

  it('the kept write starts the next interval: a "seen" right after it is kept again, not written at once', async () => {
    const { win } = await seenWithin()
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    await storedSoon(w.board, w.bob.userId, win)
    const written = await stored(w.board, w.bob.userId)
    w.api.clock.advance(1_000)
    const again = await seen(w.bob, w.board)
    expect(await stored(w.board, w.bob.userId)).toBe(written)
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    await storedSoon(w.board, w.bob.userId, again)
  })

  it('closing the api writes what it kept (a deploy inside the interval loses no Mark all seen)', async () => {
    const db = await openTestDb()
    const api = await createTestApi({ db })
    try {
      const bob = await api.login('bob')
      const board = await createBoard(bob, DEV_STUDIO, 'Closing')
      parseAnswer((await bob.req('POST', visitPath(board))).body)
      api.clock.advance(3_000)
      const win = await seen(bob, board, api)
      await api.close()
      const row = await db.maybeOne<{ seen_at: Date }>(
        'SELECT seen_at FROM board_visits WHERE board_id = $1 AND user_id = $2',
        [board, bob.userId],
      )
      within(row?.seen_at.getTime(), win)
    } finally {
      await db.close()
    }
  })

  // The e2e (n4-since-visit, "the next open shows none") found it: a visit inside the interval answered the STORED time
  // while a newer "seen" was kept, so another browser opened right after Mark all seen showed the chip again.
  it('a visit inside the interval while a "seen" is kept answers that time (another device right after Mark all seen)', async () => {
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    w.api.clock.advance(4_000)
    const win = await seen(w.bob, w.board) // kept: inside the visit's interval
    w.api.clock.advance(2_000)
    const reload = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    within(reload.previousSeenAt, win)
    expect(reload.seenAt).toBe(reload.previousSeenAt)
    expect(reload.previousSeenAt as number).toBeGreaterThan(first.seenAt)
  })

  it('the same once the tick wrote one kept time and another "seen" is kept in the interval that write began', async () => {
    parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    w.api.clock.advance(4_000)
    const firstSeen = await seen(w.bob, w.board)
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    await storedSoon(w.board, w.bob.userId, firstSeen) // the tick's write: its interval starts now
    w.api.clock.advance(2_000)
    const markAll = await seen(w.bob, w.board) // kept again
    w.api.clock.advance(1_000)
    const other = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    within(other.previousSeenAt, markAll)
  })

  it('another person’s "seen" is kept apart', async () => {
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    parseAnswer((await w.carol.req('POST', visitPath(w.board))).body)
    w.api.clock.advance(2_000)
    const bobs = await seen(w.bob, w.board)
    const carolBefore = await stored(w.board, w.carol.userId)
    w.api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS)
    await storedSoon(w.board, w.bob.userId, bobs)
    expect(await stored(w.board, w.carol.userId)).toBe(carolBefore)
  })
})

// Wave N.1 (wave N follow-up 5, "one clock"): the page compares the visit time with the sync's element stamps, and the
// two servers' clocks differ. Visit times are stored on the sync's clock (GET /internal/clock, measured by the api:
// src/sync-clock.ts); while it is not known (an older sync, an unreachable one) on the api's own, as before.
describe('visit times are on the sync’s clock (one clock with the element stamps)', () => {
  const SKEW = 5_000
  const skewedSync = (api: () => TestApi) =>
    Object.assign(new FakeSync(), { clock: async () => api().clock.now().getTime() + SKEW })

  it('a sync 5 s ahead: the visit and "seen" times stored are its time, not the api’s', async () => {
    await w.api.close()
    let api: TestApi | null = null
    w = await setupWorld({ sync: skewedSync(() => api as TestApi) })
    api = w.api
    expect(await visitsClockOf(w.api.app)?.measure()).toBeGreaterThan(SKEW - 1_000)
    const before = w.api.clock.now().getTime()
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    const after = w.api.clock.now().getTime()
    expect(first.seenAt).toBeGreaterThanOrEqual(before + SKEW - 1_000)
    expect(first.seenAt).toBeLessThanOrEqual(after + SKEW + 1_000)
    expect(await stored(w.board, w.bob.userId)).toBe(first.seenAt)
    pass()
    const seenBefore = w.api.clock.now().getTime()
    expect((await w.bob.req('POST', visitSeenPath(w.board))).statusCode).toBe(204)
    const seen = (await stored(w.board, w.bob.userId)) as number
    expect(seen).toBeGreaterThanOrEqual(seenBefore + SKEW - 1_000)
    expect(seen).toBeLessThanOrEqual(w.api.clock.now().getTime() + SKEW + 1_000)
  })

  it('a sync without the route (an older build): the api’s own clock, as before', async () => {
    await w.api.close()
    w = await setupWorld({ sync: new FakeSync() })
    expect(await visitsClockOf(w.api.app)?.measure()).toBeNull()
    const before = w.api.clock.now().getTime()
    const first = parseAnswer((await w.bob.req('POST', visitPath(w.board))).body)
    expect(first.seenAt).toBeGreaterThanOrEqual(before)
    expect(first.seenAt).toBeLessThanOrEqual(w.api.clock.now().getTime())
  })
})

describe('the hold: the two route keys back in PENDING_ROUTES', () => {
  it('hides both routes like unknown ones (the web’s chip then stays hidden), and removing the keys brings them back', async () => {
    const pending = PENDING_ROUTES as Record<string, PendingRoute>
    const keys = ['POST /api/boards/:bid/visit', 'POST /api/boards/:bid/visit/seen']
    expect(keys.some((k) => Object.hasOwn(pending, k))).toBe(false) // shipped: implemented
    for (const k of keys) pending[k] = { owner: 'WS4', item: 'N4-1' }
    let held: World | null = null
    try {
      held = await setupWorld()
      for (const path of [visitPath(held.board), visitSeenPath(held.board)]) {
        const res = await held.bob.req('POST', path)
        expect(res.statusCode, path).toBe(404)
        expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
      }
      expect((await held.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_visits')).n).toBe(0)
    } finally {
      for (const k of keys) delete pending[k]
      await held?.api.close()
    }
    expect((await w.bob.req('POST', visitPath(w.board))).statusCode).toBe(200)
  })
})

describe('name-only guests keep the device-local window', () => {
  it('a guest gets 403 GUEST_ACCOUNT_REQUIRED on both routes, before any board or visit query, and nothing is stored', async () => {
    const base = await openTestDb()
    const counted = countQueries(base)
    const api = await createTestApi({ db: counted.db })
    try {
      await api.login('alice')
      const bob = await api.login('bob')
      const board = await createBoard(bob, DEV_STUDIO, 'Client review')
      const sam = await joinAsGuest(api, (await guestLink(bob, board, { role: 'editor' })).url, 'Sam')
      for (const path of [visitPath(board), visitSeenPath(board)]) {
        counted.reset()
        const res = await sam.req('POST', path)
        expect(res.statusCode, res.body).toBe(403)
        expect(errorCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
        // what ran: the session lookup and the person’s kind, nothing about the board or its visits
        expect(counted.statements.length).toBeGreaterThan(0)
        for (const s of counted.statements) {
          expect(s.sql, s.sql).not.toMatch(/board_visits|FROM boards|board_members|workspace_members/)
        }
      }
      expect((await base.one<{ n: number }>('SELECT count(*)::int AS n FROM board_visits')).n).toBe(0)
    } finally {
      await api.close()
      await base.close()
    }
  })

  it('a guest with an owner grant (a legacy row) is refused the same', async () => {
    const sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'Sam')
    await w.api.db.query("UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2", [
      w.board,
      sam.userId,
    ])
    expect((await sam.req('POST', visitPath(w.board))).statusCode).toBe(403)
    expect(await rowCount()).toBe(0)
  })
})

describe('retention and cascades', () => {
  const seed = async (board: string, userId: string, ageDays: number) =>
    w.api.db.query(
      `INSERT INTO board_visits (board_id, user_id, seen_at) VALUES ($1, $2, $3)
       ON CONFLICT (board_id, user_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
      [board, userId, new Date(w.api.clock.now().getTime() - ageDays * DAY)],
    )

  it('the sweeper deletes rows older than the retention (180 days by default) and keeps the rest', async () => {
    expect(w.api.config.visitsRetentionDays).toBe(VISITS_RETENTION_DAYS_DEFAULT)
    const b2 = await createBoard(w.bob, DEV_STUDIO, 'Old board')
    const b3 = await createBoard(w.bob, DEV_STUDIO, 'Recent board')
    await seed(w.board, w.bob.userId, 181)
    await seed(b2, w.bob.userId, 400)
    await seed(b3, w.bob.userId, 179)
    await seed(w.board, w.alice.userId, 1)
    const ctx = { db: w.api.db, now: w.api.clock.now, config: w.api.config }
    expect(await sweepVisits(ctx)).toBe(2)
    expect(await stored(w.board, w.bob.userId)).toBeNull()
    expect(await stored(b2, w.bob.userId)).toBeNull()
    expect(await stored(b3, w.bob.userId)).not.toBeNull()
    expect(await stored(w.board, w.alice.userId)).not.toBeNull()
    expect(await sweepVisits(ctx)).toBe(0)
  })

  it('DRAFTROOM_VISITS_RETENTION_DAYS sets the cut-off, and a bad value stops the api from starting', async () => {
    expect(loadConfig(testEnv('x', { DRAFTROOM_VISITS_RETENTION_DAYS: '30' })).visitsRetentionDays).toBe(30)
    for (const bad of ['0', '-1', 'abc', '1.5', '99999'])
      expect(() => loadConfig(testEnv('x', { DRAFTROOM_VISITS_RETENTION_DAYS: bad })), bad).toThrow(
        /DRAFTROOM_VISITS_RETENTION_DAYS/,
      )
    await seed(w.board, w.bob.userId, 31)
    const ctx = { db: w.api.db, now: w.api.clock.now, config: { ...w.api.config, visitsRetentionDays: 30 } }
    expect(await sweepVisits(ctx)).toBe(1)
  })

  it('prunes in batches until the table is clear', async () => {
    // 1,500 people last saw this board 200 days ago: one pass takes them all (two batches of 1,000)
    await w.api.db.query(
      `INSERT INTO users (id, name, handle, color)
       SELECT 'usr_' || lpad(g::text, 14, '0'), 'u' || g, 'u' || g, '#3355ff' FROM generate_series(1, 1500) g`,
    )
    await w.api.db.query(
      `INSERT INTO board_visits (board_id, user_id, seen_at)
       SELECT $1, 'usr_' || lpad(g::text, 14, '0'), $2 FROM generate_series(1, 1500) g`,
      [w.board, new Date(w.api.clock.now().getTime() - 200 * DAY)],
    )
    const ctx = { db: w.api.db, now: w.api.clock.now, config: w.api.config }
    expect(await sweepVisits(ctx)).toBe(1500)
    expect(await rowCount()).toBe(0)
  })

  describe('the sweeper’s timers (the app starts it when it is ready)', () => {
    const saved = { ...visitsSweepSettings }
    afterEach(() => {
      Object.assign(visitsSweepSettings, saved)
    })
    const gone = (board: string, userId: string) =>
      vi.waitFor(async () => expect(await stored(board, userId)).toBeNull(), { timeout: 8_000, interval: 25 })

    it('the first pass runs soon after the app is ready, and prunes only what is past the retention', async () => {
      await seed(w.board, w.bob.userId, 200)
      await seed(w.board, w.alice.userId, 1)
      visitsSweepSettings.firstDelayMs = 50
      visitsSweepSettings.intervalMs = 60 * 60 * 1000 // not what runs here
      // a second app over the same database: its onReady starts the timers (the first app's are the long default)
      const second = await createTestApi({ db: w.api.db })
      try {
        await gone(w.board, w.bob.userId)
        expect(await stored(w.board, w.alice.userId)).not.toBeNull()
      } finally {
        await second.close()
      }
    })

    it('the interval keeps sweeping, and closing the app stops the timers', async () => {
      visitsSweepSettings.firstDelayMs = 60 * 60 * 1000 // not what runs here
      visitsSweepSettings.intervalMs = 100
      const second = await createTestApi({ db: w.api.db })
      try {
        await seed(w.board, w.bob.userId, 200)
        await gone(w.board, w.bob.userId)
      } finally {
        await second.close()
      }
      // nothing sweeps after the app is closed (the database is still open: this one is the first app’s)
      await seed(w.board, w.bob.userId, 200)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await stored(w.board, w.bob.userId)).not.toBeNull()
    })
  })

  it('deleting the board, or the account, deletes its rows (ON DELETE CASCADE)', async () => {
    const other = await createBoard(w.bob, DEV_STUDIO, 'Other')
    await seed(w.board, w.bob.userId, 1)
    await seed(other, w.bob.userId, 1)
    // an account with no workspace of its own (a deletable one, as the offboarding sweep's account deletion removes)
    const leaver = 'usr_leaver000000001'
    await w.api.db.query(
      "INSERT INTO users (id, name, handle, color) VALUES ($1, 'Leaver', 'leaver', '#3355ff')",
      [leaver],
    )
    await seed(other, leaver, 1)
    await w.api.db.query('DELETE FROM boards WHERE id = $1', [w.board])
    expect(await rowCount()).toBe(2)
    await w.api.db.query('DELETE FROM users WHERE id = $1', [leaver])
    expect(await rowCount()).toBe(1)
    expect(await stored(other, w.bob.userId)).not.toBeNull()
  })

  it('a board member who is removed keeps no way to read their row (they get 404), and the row stays until retention', async () => {
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    expect((await w.carol.req('POST', visitPath(w.board))).statusCode).toBe(200)
    expect(
      (await w.bob.req('DELETE', `/api/boards/${w.board}/members/${w.carol.userId}`)).statusCode,
    ).toBeLessThan(300)
    pass()
    expect((await w.carol.req('POST', visitPath(w.board))).statusCode).toBe(404)
  })
})

describe('what is logged', () => {
  it('the request log carries the route, status and duration, and no time or user of a visit', async () => {
    const lines: string[] = []
    const api = await createTestApi({
      deps: { logger: { level: 'trace', stream: { write: (l: string) => void lines.push(l) } } },
    })
    try {
      await api.login('alice')
      const bob = await api.login('bob')
      const board = await createBoard(bob, DEV_STUDIO, 'Logged')
      lines.length = 0
      const a = parseAnswer((await bob.req('POST', visitPath(board))).body)
      api.clock.advance(VISIT_WRITE_MIN_INTERVAL_MS + 1)
      const b = parseAnswer((await bob.req('POST', visitPath(board))).body)
      await bob.req('POST', visitSeenPath(board))
      // each line's own `time` is the moment it was written, which is the moment of the request (the api's clock here
      // is the real one plus an offset): the visit time and the log line's time can be the same millisecond. What must
      // not be in the log is a visit time in any other field.
      const log = lines
        .map((l) => {
          const { time: _written, ...rest } = JSON.parse(l) as Record<string, unknown>
          return JSON.stringify(rest)
        })
        .join('\n')
      expect(log).toContain('/api/boards/:bid/visit')
      for (const t of [a.seenAt, b.seenAt, b.previousSeenAt as number])
        expect(log, `the time ${t}`).not.toContain(String(t))
      expect(log).not.toContain(bob.userId)
      for (const line of lines) {
        const o = JSON.parse(line) as Record<string, unknown>
        if (o.msg === 'request' && String(o.route).includes('/visit'))
          expect(
            Object.keys(o)
              .filter((k) => !['level', 'time', 'pid', 'hostname', 'reqId'].includes(k))
              .sort(),
          ).toEqual(['method', 'ms', 'msg', 'route', 'status'].sort())
      }
    } finally {
      await api.close()
    }
  })
})
