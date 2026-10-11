// Wave N, N4-1 on a real Postgres (set DRAFTROOM_TEST_DATABASE_URL to a database these tests may create and drop a schema
// in; skipped otherwise: PGlite has one connection and runs two statements one after the other, so it cannot show a race).
//  - two tabs UPSERT at the same moment: each gets a consistent previous value (each reads what was there when its
//    statement began; the two never read each other's write), and the stored time is the later of the two;
//  - a first visit raced the same way: both see "no previous visit" and exactly one row is stored;
//  - 20 people open the same board at once, and one person opens it from 8 tabs at once: no error, no deadlock, one row
//    per (board, person), and the one person’s 8 tabs share one write and one answer.
import { VisitAnswer, visitPath } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordVisit } from '../../../src/features/visits/store.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''

describe.skipIf(!PG_URL)('visit markers on a real Postgres', () => {
  let db: Db
  let api: TestApi
  let owner: Client
  const people: Client[] = []
  let board: string

  beforeAll(async () => {
    db = await openTestDb()
    api = await createTestApi({ db })
    owner = await api.login('ada', 'Ada Owner')
    board = await createBoard(owner, DEV_STUDIO, 'Busy board')
    for (let i = 0; i < 20; i++) {
      const c = await api.login(`p${i}`, `Person ${i}`)
      expect(
        (await owner.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role: 'viewer' })).statusCode,
      ).toBe(200)
      people.push(c)
    }
  }, 120_000)

  afterAll(async () => {
    await api?.close()
    await db?.close()
  })

  const stored = async (userId: string) =>
    (
      await db.maybeOne<{ seen_at: Date }>(
        'SELECT seen_at FROM board_visits WHERE board_id = $1 AND user_id = $2',
        [board, userId],
      )
    )?.seen_at.getTime() ?? null

  it('two tabs UPSERT at once: both read the same previous time, and the later time is stored', async () => {
    const who = (people[0] as Client).userId
    const t0 = new Date(Date.now() - 60_000)
    const first = await recordVisit(db, board, who, t0)
    expect(first.previousSeenAt).toBeNull()
    for (let round = 0; round < 25; round++) {
      const before = (await stored(who)) as number
      const a = new Date(before + 1_000 + round)
      const b = new Date(before + 2_000 + round)
      const [ra, rb] = await Promise.all([recordVisit(db, board, who, a), recordVisit(db, board, who, b)])
      VisitAnswer.parse(ra)
      VisitAnswer.parse(rb)
      // each read what was stored when its statement began: the time before both, or (when the other had already
      // committed) the other's; never both the other's (that would be a cycle), never null, never a time from nowhere
      expect([before, b.getTime()], `round ${round}`).toContain(ra.previousSeenAt)
      expect([before, a.getTime()], `round ${round}`).toContain(rb.previousSeenAt)
      expect(ra.previousSeenAt === b.getTime() && rb.previousSeenAt === a.getTime(), `round ${round}`).toBe(
        false,
      )
      expect(await stored(who)).toBe(b.getTime())
    }
  })

  it('two first visits at once: one row, and the stored time is the later one', async () => {
    const who = (people[1] as Client).userId
    const a = new Date(Date.now() - 5_000)
    const b = new Date(Date.now() - 1_000)
    const [ra, rb] = await Promise.all([recordVisit(db, board, who, a), recordVisit(db, board, who, b)])
    for (const r of [ra, rb]) expect(r.previousSeenAt === null || r.previousSeenAt === a.getTime()).toBe(true)
    expect(
      (await db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_visits WHERE user_id = $1', [who]))
        .n,
    ).toBe(1)
    expect(await stored(who)).toBe(b.getTime())
  })

  it('20 people open the board at once, and one person opens it from 8 tabs at once', async () => {
    const results = await Promise.all(people.map((c) => c.req('POST', visitPath(board))))
    for (const res of results) expect(res.statusCode, res.body).toBe(200)
    const eight = await Promise.all(
      Array.from({ length: 8 }, () => (people[2] as Client).req('POST', visitPath(board))),
    )
    const answers = eight.map((r) => VisitAnswer.parse(r.json()))
    for (const a of answers) expect(a).toEqual(answers[0])
    const rows = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM board_visits WHERE board_id = $1 AND user_id = ANY($2::text[])',
      [board, people.map((c) => c.userId)],
    )
    expect(rows.n).toBe(20)
  })
})
