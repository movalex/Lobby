// DANA-02: a board's owners hear about every new comment thread on it ("Priya Shah (guest) commented on
// Client review"), in-app only. Never the author, only people who can view the board, one notification
// per person (a mention wins), cleared by reading the thread, and capped per author and per board so
// neither a guest nor a crowd of guests from one link can flood the owner's bell.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NEW_COMMENT_BOARD_CAP,
  NEW_COMMENT_CAP_WINDOW_MS,
  NEW_COMMENT_UNREAD_CAP,
} from '../../../src/features/comments/notifications.ts'
import { DEV_STUDIO } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { countRows, createThread, type Fixture, mention, notificationsOf, reply, setup } from './fixture.ts'

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

  it(`guests from one link cannot multiply the per-author cap: a board queues at most ${NEW_COMMENT_BOARD_CAP} unread items per owner`, async () => {
    // A name-only guest costs nothing but a name, so one person with a review link is many authors.
    const link = await guestLink(f.owner, f.boardId, { role: 'commenter' })
    const authors = Math.ceil(NEW_COMMENT_BOARD_CAP / NEW_COMMENT_UNREAD_CAP) + 2
    for (let g = 0; g < authors; g++) {
      const guest = await joinAsGuest(f.api, link.url, `Spammer ${g}`)
      for (let i = 0; i < NEW_COMMENT_UNREAD_CAP; i++) {
        const res = await guest.req('POST', `/api/boards/${f.boardId}/threads`, {
          anchor: { kind: 'point', x: g, y: i },
          body: `spam ${g}.${i}`,
        })
        expect(res.statusCode, res.body).toBe(201)
      }
    }
    // Every thread is on the board; the owner's bell holds only the board's cap.
    expect(await countRows(f.api, 'comment_threads')).toBe(authors * NEW_COMMENT_UNREAD_CAP)
    const inbox = await notificationsOf(f.owner)
    expect(inbox.unreadCount).toBe(NEW_COMMENT_BOARD_CAP)
    // Even an hour later the board as a whole stays capped until the owner reads some.
    f.api.clock.advance(NEW_COMMENT_CAP_WINDOW_MS + 1_000)
    await createThread(f.commenter, f.boardId, 'a real question')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_BOARD_CAP)
    // Reading one frees one slot for the next author.
    const first = inbox.notifications.find((n) => n.kind === 'new_comment')
    await f.owner.req('POST', `/api/threads/${first?.threadId}/read`)
    await createThread(f.commenter2, f.boardId, 'another real question')
    expect((await notificationsOf(f.owner)).unreadCount).toBe(NEW_COMMENT_BOARD_CAP)
    expect((await notificationsOf(f.owner)).notifications[0]).toMatchObject({
      kind: 'new_comment',
      actor: { id: f.commenter2.userId },
    })
    // A mention still gets through.
    await createThread(f.commenter, f.boardId, `${mention(f.owner)} urgent`)
    expect((await notificationsOf(f.owner)).notifications[0]?.kind).toBe('mention')
  })

  it('threads deleted before the owner saw them do not hold the cap (the owner cannot see or read them)', async () => {
    const spam = []
    for (let i = 0; i < NEW_COMMENT_UNREAD_CAP; i++)
      spam.push(await createThread(f.commenter, f.boardId, `oops ${i}`))
    // The owner moderates them away (or the author deletes their typos): nothing is left to read.
    for (const t of spam) {
      const res = await f.owner.req('DELETE', `/api/comments/${t.comments[0]?.id}`)
      expect(res.statusCode, res.body).toBe(204)
    }
    expect((await notificationsOf(f.owner)).unreadCount).toBe(0)
    // The author's next thread is announced again.
    const real = await createThread(f.commenter, f.boardId, 'the real comment')
    const inbox = await notificationsOf(f.owner)
    expect(inbox.unreadCount).toBe(1)
    expect(inbox.notifications[0]).toMatchObject({ kind: 'new_comment', threadId: real.id })
  })

  it('a mention of the owner is never swallowed by the cap', async () => {
    for (let i = 0; i < NEW_COMMENT_UNREAD_CAP; i++) await createThread(f.commenter, f.boardId, `note ${i}`)
    await createThread(f.commenter, f.boardId, `${mention(f.owner)} this one matters`)
    const kinds = await kindsOf(f.owner)
    expect(kinds[0]).toBe('mention')
    expect(kinds.filter((k) => k === 'new_comment')).toHaveLength(NEW_COMMENT_UNREAD_CAP)
  })
})
