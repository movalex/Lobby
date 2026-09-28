// DANA-02: a board's owners hear about every new comment thread on it ("Priya Shah (guest) commented on
// Client review"), in-app only. Never the author, only people who can view the board, one notification
// per person (a mention wins), cleared by reading the thread, and capped per author so a guest cannot
// flood the owner's bell.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NEW_COMMENT_CAP_WINDOW_MS,
  NEW_COMMENT_UNREAD_CAP,
} from '../../../src/features/comments/notifications.ts'
import { DEV_STUDIO } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { createThread, type Fixture, mention, notificationsOf, reply, setup } from './fixture.ts'

let f: Fixture
beforeEach(async () => {
  f = await setup()
})
afterEach(() => f.close())

const kindsOf = async (c: Fixture['owner']) => (await notificationsOf(c)).notifications.map((n) => n.kind)

describe('new threads notify the board owner', () => {
  it('a commenter starting a thread notifies the owner only, with who, where and what', async () => {
    const t = await createThread(f.commenter, f.boardId, 'Can we see a darker variant of the key art?')
    const inbox = await notificationsOf(f.owner)
    expect(inbox.unreadCount).toBe(1)
    expect(inbox.notifications).toHaveLength(1)
    expect(inbox.notifications[0]).toMatchObject({
      kind: 'new_comment',
      boardId: f.boardId,
      boardTitle: 'Review board',
      threadId: t.id,
      commentId: t.comments[0]?.id,
      actor: { id: f.commenter.userId, name: 'Carol Commenter' },
      snippet: 'Can we see a darker variant of the key art?',
      readAt: null,
    })
    // Editors, viewers and the author are not told (editors only through mentions and threads they follow).
    for (const c of [f.editor, f.viewer, f.commenter, f.commenter2, f.stranger])
      expect(await kindsOf(c)).toEqual([])
  })

  it('never notifies the author: the owner starting a thread notifies nobody', async () => {
    await createThread(f.owner, f.boardId, 'Note to self')
    expect((await f.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications')).n).toBe(0)
  })

  it('an owner who is also mentioned gets one "mention", not two items', async () => {
    await createThread(f.editor, f.boardId, `${mention(f.owner)} please check the palette`)
    expect(await kindsOf(f.owner)).toEqual(['mention'])
  })

  it('replies notify only the thread followers, not every owner', async () => {
    const t = await createThread(f.owner, f.boardId, 'Owner asks')
    await reply(f.commenter, t.id, 'Client answers') // the owner follows their own thread: a reply
    const other = await createThread(f.editor, f.boardId, 'Editor asks')
    await f.owner.req('POST', `/api/threads/${other.id}/read`)
    await reply(f.commenter, other.id, 'Client answers the editor') // the owner does not follow this one
    expect(await kindsOf(f.owner)).toEqual(['new_comment', 'reply'])
    expect((await notificationsOf(f.owner)).unreadCount).toBe(1)
  })

  it('a name-only guest starting a thread notifies the owner as "Name (guest)"', async () => {
    const link = await guestLink(f.owner, f.boardId, { role: 'commenter' })
    const priya = await joinAsGuest(f.api, link.url, 'Priya Shah')
    const res = await priya.req('POST', `/api/boards/${f.boardId}/threads`, {
      anchor: { kind: 'point', x: 1, y: 2 },
      body: 'Love the palette',
    })
    expect(res.statusCode, res.body).toBe(201)
    const [item] = (await notificationsOf(f.owner)).notifications
    expect(item).toMatchObject({
      kind: 'new_comment',
      actor: { id: priya.userId, name: 'Priya Shah (guest)' },
    })
  })

  it('only owners who can view the board are notified', async () => {
    // A second, direct owner grant for someone who has since left the workspace: no access, no item.
    await f.api.db.query(
      `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $3, now())`,
      [f.boardId, f.stranger.userId, f.owner.userId],
    )
    await f.api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      f.stranger.userId,
    ])
    await createThread(f.commenter, f.boardId, 'Hello')
    const rows = await f.api.db.query<{ user_id: string }>('SELECT user_id FROM notifications')
    expect(rows.rows.map((r) => r.user_id)).toEqual([f.owner.userId])
  })

  it('reading the thread clears the owner’s notification', async () => {
    const t = await createThread(f.commenter, f.boardId, 'Please review')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(1)
    const res = await f.owner.req('POST', `/api/threads/${t.id}/read`)
    expect(res.statusCode, res.body).toBe(200)
    const inbox = await notificationsOf(f.owner)
    expect(inbox.unreadCount).toBe(0)
    expect(inbox.notifications[0]?.readAt).not.toBeNull()
  })
})

describe('flood cap', () => {
  it(`one author queues at most ${NEW_COMMENT_UNREAD_CAP} unread items per owner and board; reading or time frees room`, async () => {
    const threads = []
    for (let i = 0; i < NEW_COMMENT_UNREAD_CAP + 3; i++)
      threads.push(await createThread(f.commenter, f.boardId, `spam ${i}`))
    // Every thread exists on the board; the owner's bell holds only the cap.
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_UNREAD_CAP)
    // Another author is not held back by the first one's cap.
    await createThread(f.commenter2, f.boardId, 'a different person')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_UNREAD_CAP + 1)
    // Reading one of the first author's threads frees one slot.
    await f.owner.req('POST', `/api/threads/${threads[0]?.id}/read`)
    await createThread(f.commenter, f.boardId, 'after a read')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_UNREAD_CAP + 1)
    await createThread(f.commenter, f.boardId, 'capped again')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_UNREAD_CAP + 1)
    // Past the window the author may notify again.
    f.api.clock.advance(NEW_COMMENT_CAP_WINDOW_MS + 1_000)
    await createThread(f.commenter, f.boardId, 'an hour later')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_UNREAD_CAP + 2)
  })

  it('a mention of the owner is never swallowed by the cap', async () => {
    for (let i = 0; i < NEW_COMMENT_UNREAD_CAP; i++) await createThread(f.commenter, f.boardId, `note ${i}`)
    await createThread(f.commenter, f.boardId, `${mention(f.owner)} this one matters`)
    const kinds = await kindsOf(f.owner)
    expect(kinds[0]).toBe('mention')
    expect(kinds.filter((k) => k === 'new_comment')).toHaveLength(NEW_COMMENT_UNREAD_CAP)
  })
})
