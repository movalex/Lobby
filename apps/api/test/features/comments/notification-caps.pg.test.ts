// NC-V3 on a real Postgres: the notification caps are "count, then insert", and requests run on
// separate pool connections at once, so without the per-board advisory lock (lockBoardNotifications)
// simultaneous posts all count below the cap before any of them commits. Opt-in like
// apps/api/test/concurrency.pg.test.ts: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may
// create and drop schemas in) to run it; skipped otherwise. DRAFTROOM_PG_STRESS_ITER sets the rounds.

import { afterEach, describe, expect, it } from 'vitest'
import {
  MENTION_NOTIFY_CAP,
  NEW_COMMENT_BOARD_CAP,
  NEW_COMMENT_UNREAD_CAP,
} from '../../../src/features/comments/notifications.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { createThread, type Fixture, mention, setup } from './fixture.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 5)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Starts every job after its own random delay in [0, jitterMs] and waits for all. */
const race = <T>(jobs: (() => Promise<T>)[], jitterMs: number) =>
  Promise.all(
    jobs.map(async (j) => {
      await sleep(Math.random() * jitterMs)
      return j()
    }),
  )

let f: Fixture | null = null
afterEach(async () => {
  await f?.close()
  f = null
})

const unreadNewComments = async (fx: Fixture) =>
  (
    await fx.api.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE user_id = $1 AND kind = 'new_comment' AND read_at IS NULL`,
      [fx.owner.userId],
    )
  ).n

describe.skipIf(!PG_URL)('notification caps on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('one author posting threads at once never passes the per-author cap', async () => {
    for (let i = 0; i < ITER; i++) {
      const fx = await setup()
      f = fx
      const res = await race(
        Array.from(
          { length: NEW_COMMENT_UNREAD_CAP * 3 },
          (_, k) => () =>
            fx.commenter.req('POST', `/api/boards/${fx.boardId}/threads`, {
              anchor: { kind: 'point', x: k, y: i },
              body: `burst ${i}.${k}`,
            }),
        ),
        10,
      )
      for (const r of res) expect(r.statusCode, r.body).toBe(201)
      expect(await unreadNewComments(fx)).toBe(NEW_COMMENT_UNREAD_CAP)
      await fx.close()
      f = null
    }
  })

  it('many guests posting at once never pass the board cap', async () => {
    const fx = await setup()
    f = fx
    const link = await guestLink(fx.owner, fx.boardId, { role: 'commenter' })
    const guests = []
    for (let g = 0; g < Math.ceil(NEW_COMMENT_BOARD_CAP / NEW_COMMENT_UNREAD_CAP) + 3; g++)
      guests.push(await joinAsGuest(fx.api, link.url, `Crowd ${g}`))
    const res = await race(
      guests.flatMap((g, gi) =>
        Array.from(
          { length: NEW_COMMENT_UNREAD_CAP },
          (_, k) => () =>
            g.req('POST', `/api/boards/${fx.boardId}/threads`, {
              anchor: { kind: 'point', x: gi, y: k },
              body: `crowd ${gi}.${k}`,
            }),
        ),
      ),
      10,
    )
    for (const r of res) expect(r.statusCode, r.body).toBe(201)
    expect(await unreadNewComments(fx)).toBe(NEW_COMMENT_BOARD_CAP)
  })

  it('mentions posted at once never pass the per-author mention cap', async () => {
    const fx = await setup()
    f = fx
    const everyone = [fx.owner, fx.editor, fx.commenter2, fx.viewer]
    const all = everyone.map((c) => mention(c)).join(' ')
    const thread = await createThread(fx.editor, fx.boardId, 'Editor asks')
    const replies = Math.ceil(MENTION_NOTIFY_CAP / everyone.length) + 10
    const res = await race(
      Array.from(
        { length: replies },
        (_, k) => () =>
          fx.commenter.req('POST', `/api/threads/${thread.id}/comments`, { body: `${all} ${k}` }),
      ),
      10,
    )
    for (const r of res) expect(r.statusCode, r.body).toBe(201)
    const sent = await fx.api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE actor_id = $1 AND kind = 'mention'",
      [fx.commenter.userId],
    )
    expect(sent.n).toBe(MENTION_NOTIFY_CAP)
  })
})
