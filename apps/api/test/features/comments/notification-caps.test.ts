// NC-V4: mention notifications are capped per author per board per hour (a comment may mention up to
// 50 people and the write budget allows 120 comments a minute). NC-V3: the caps are "count, then
// insert" under a per-board advisory lock, so they hold when requests run at once. PGlite has one
// connection, so the real race only shows on Postgres (notification-caps.pg.test.ts); here we check
// the lock is really taken and released, and that simultaneous requests still respect every cap.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  lockBoardNotifications,
  MENTION_CAP_WINDOW_MS,
  MENTION_NOTIFY_CAP,
  NEW_COMMENT_UNREAD_CAP,
  NOTIFY_LOCK_NS,
} from '../../../src/features/comments/notifications.ts'
import { createThread, type Fixture, mention, notificationsOf, reply, setup } from './fixture.ts'

let f: Fixture
beforeEach(async () => {
  f = await setup()
})
afterEach(() => f.close())

const rowsBy = async (actorId: string) =>
  (
    await f.api.db.query<{ user_id: string; kind: string }>(
      'SELECT user_id, kind FROM notifications WHERE actor_id = $1 ORDER BY seq',
      [actorId],
    )
  ).rows

const count = (rows: { kind: string }[], kind: string) => rows.filter((r) => r.kind === kind).length

describe('mention cap (NC-V4)', () => {
  it(`one author sends at most ${MENTION_NOTIFY_CAP} mention items per board per hour; past it a mention is the plain item or nothing`, async () => {
    const everyone = [f.owner, f.editor, f.commenter2, f.viewer]
    const all = everyone.map((c) => mention(c)).join(' ')
    const thread = await createThread(f.editor, f.boardId, 'Editor asks')
    // Fill the author's hour exactly: every reply mentions four people.
    const replies = Math.ceil(MENTION_NOTIFY_CAP / everyone.length)
    for (let i = 0; i < replies; i++) await reply(f.commenter, thread.id, `${all} ping ${i}`)
    let rows = await rowsBy(f.commenter.userId)
    expect(count(rows, 'mention')).toBe(MENTION_NOTIFY_CAP)

    // Past the cap, the followers still hear about the reply (as a plain 'reply'), not as a mention.
    await reply(f.commenter, thread.id, `${all} one more`)
    rows = await rowsBy(f.commenter.userId)
    expect(count(rows, 'mention')).toBe(MENTION_NOTIFY_CAP)
    expect(rows.slice(-everyone.length).map((r) => r.kind)).toEqual(everyone.map(() => 'reply'))

    // A new thread: the board's owner gets the 'new_comment' they would have had anyway; the mentioned
    // viewer (no other reason to hear about it) gets nothing.
    const t2 = await createThread(f.commenter, f.boardId, `${mention(f.owner)} ${mention(f.viewer)} look`)
    const onT2 = await f.api.db.query<{ user_id: string; kind: string }>(
      'SELECT user_id, kind FROM notifications WHERE thread_id = $1',
      [t2.id],
    )
    expect(onT2.rows).toEqual([{ user_id: f.owner.userId, kind: 'new_comment' }])
    // The comment itself keeps its mentions (the cap only limits bell items).
    expect(t2.comments[0]?.body).toContain(`(${f.viewer.userId})`)

    // Another author is not held back by the first one's cap.
    await createThread(f.commenter2, f.boardId, `${mention(f.viewer)} hello`)
    expect((await notificationsOf(f.viewer)).notifications[0]).toMatchObject({
      kind: 'mention',
      actor: { id: f.commenter2.userId },
    })

    // An hour later the author may mention again.
    f.api.clock.advance(MENTION_CAP_WINDOW_MS + 1_000)
    await createThread(f.commenter, f.boardId, `${mention(f.viewer)} an hour later`)
    expect((await notificationsOf(f.viewer)).notifications[0]).toMatchObject({
      kind: 'mention',
      actor: { id: f.commenter.userId },
    })
  })

  it('an edit that adds mentions past the cap notifies nobody new', async () => {
    const thread = await createThread(f.editor, f.boardId, 'Editor asks')
    const all = [f.owner, f.editor, f.commenter2, f.viewer].map((c) => mention(c)).join(' ')
    for (let i = 0; i < Math.ceil(MENTION_NOTIFY_CAP / 4); i++)
      await reply(f.commenter, thread.id, `${all} ping ${i}`)
    const own = await reply(f.commenter, thread.id, 'no mention yet')
    const comment = own.comments.at(-1)
    const before = (await rowsBy(f.commenter.userId)).length
    const res = await f.commenter.req('PATCH', `/api/comments/${comment?.id}`, {
      body: `now with ${mention(f.viewer)}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    // An edit notifies only the people it newly mentions (never followers), and past the cap not them.
    expect((await rowsBy(f.commenter.userId)).length).toBe(before)
  })
})

describe('caps under simultaneous requests (NC-V3)', () => {
  it('the per-board lock is transaction-scoped: held inside the transaction, gone after it', async () => {
    const held = await f.api.db.transaction(async (tx) => {
      await lockBoardNotifications(tx, f.boardId)
      return (
        await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1::int::oid AND objid = hashtext($2)::oid
              AND objsubid = 2 AND granted`,
          [NOTIFY_LOCK_NS, f.boardId],
        )
      ).n
    })
    expect(held).toBe(1)
    const after = await f.api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
    )
    expect(after.n).toBe(0)
  })

  it('threads posted at once still queue at most the per-author cap', async () => {
    const results = await Promise.all(
      Array.from({ length: NEW_COMMENT_UNREAD_CAP * 3 }, (_, i) =>
        f.commenter.req('POST', `/api/boards/${f.boardId}/threads`, {
          anchor: { kind: 'point', x: i, y: i },
          body: `burst ${i}`,
        }),
      ),
    )
    for (const r of results) expect(r.statusCode, r.body).toBe(201)
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_UNREAD_CAP)
  })
})
