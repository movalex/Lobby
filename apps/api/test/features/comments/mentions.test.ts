// @mentions and in-app notifications: only people who can view the board are mentioned/notified,
// nobody is notified about their own actions, followers get reply/resolve notifications, and the
// notification list re-checks board access on every read.

import { ThreadResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countRows, createThread, type Fixture, mention, notificationsOf, reply, setup } from './fixture.ts'

let f: Fixture
beforeEach(async () => {
  f = await setup()
})
afterEach(() => f.close())

describe('mentions', () => {
  it('keeps mentions of people who can view the board and neutralizes the rest', async () => {
    const fake = '@[Olive Owner](usr_00000000000000000000)' // not a real user
    const body = `${mention(f.viewer, 'Vicky')} and ${mention(f.stranger)} and ${fake} please look`
    const t = await createThread(f.commenter, f.boardId, body)
    const c = t.comments[0]
    expect(c?.mentions).toEqual([f.viewer.userId])
    // The viewer's token carries their real name; the others are plain text (not clickable, no notice).
    expect(c?.body).toBe(`@[Vic Viewer](${f.viewer.userId}) and @Stan Stranger and @Olive Owner please look`)
    const vic = await notificationsOf(f.viewer)
    expect(vic.notifications).toHaveLength(1)
    expect(vic.notifications[0]).toMatchObject({
      kind: 'mention',
      boardId: f.boardId,
      boardTitle: 'Review board',
      threadId: t.id,
      commentId: c?.id,
      actor: { id: f.commenter.userId, name: 'Carol Commenter' },
      snippet: '@Vic Viewer and @Stan Stranger and @Olive Owner please look',
      readAt: null,
    })
    expect(vic.unreadCount).toBe(1)
    expect((await notificationsOf(f.stranger)).notifications).toHaveLength(0)
    expect(await countRows(f.api, 'notifications')).toBe(1)
  })

  it('mentioning yourself is kept but notifies no one', async () => {
    const t = await createThread(f.commenter, f.boardId, `${mention(f.commenter)} reminder: check fonts`)
    expect(t.comments[0]?.mentions).toEqual([f.commenter.userId])
    expect((await notificationsOf(f.commenter)).notifications).toHaveLength(0)
    expect(await countRows(f.api, 'notifications')).toBe(0)
  })

  it('caps the number of people one comment can mention', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `@[P${i}](usr_${String(i).padStart(20, '0')})`).join(
      ' ',
    )
    const res = await f.commenter.req('POST', `/api/boards/${f.boardId}/threads`, {
      anchor: { kind: 'point', x: 0, y: 0 },
      body: many,
    })
    expect(res.statusCode).toBe(400)
  })

  it('an edit notifies only people newly mentioned', async () => {
    const t = await createThread(f.commenter, f.boardId, `hey ${mention(f.viewer)}`)
    const cid = t.comments[0]?.id
    const res = await f.commenter.req('PATCH', `/api/comments/${cid}`, {
      body: `hey ${mention(f.viewer)} and ${mention(f.editor)}`,
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(ThreadResponse.parse(res.json()).thread.comments[0]?.mentions.sort()).toEqual(
      [f.viewer.userId, f.editor.userId].sort(),
    )
    expect((await notificationsOf(f.viewer)).notifications).toHaveLength(1)
    expect((await notificationsOf(f.editor)).notifications.map((n) => n.kind)).toEqual(['mention'])
    // Removing a mention drops it from the comment.
    const res2 = await f.commenter.req('PATCH', `/api/comments/${cid}`, { body: 'hey everyone' })
    expect(ThreadResponse.parse(res2.json()).thread.comments[0]?.mentions).toEqual([])
  })
})

describe('reply and resolve notifications', () => {
  it('notifies followers of replies (never the author), one notification per person', async () => {
    const t = await createThread(f.commenter, f.boardId, `first, cc ${mention(f.viewer)}`)
    await reply(f.editor, t.id, 'second')
    // commenter (creator) gets a reply; viewer (mentioned earlier, so following) gets a reply.
    expect((await notificationsOf(f.commenter)).notifications.map((n) => n.kind)).toEqual(['reply'])
    expect((await notificationsOf(f.viewer)).notifications.map((n) => n.kind)).toEqual(['reply', 'mention'])
    expect((await notificationsOf(f.editor)).notifications).toHaveLength(0)
    // A follower who is also mentioned in the new reply gets one 'mention', not two notifications.
    await reply(f.editor, t.id, `${mention(f.commenter)} what do you think?`)
    expect((await notificationsOf(f.commenter)).notifications.map((n) => n.kind)).toEqual([
      'mention',
      'reply',
    ])
    // People who never took part get nothing.
    expect((await notificationsOf(f.commenter2)).notifications).toHaveLength(0)
    expect((await notificationsOf(f.owner)).notifications).toHaveLength(0)
  })

  it('does not notify followers who lost access to the board', async () => {
    const t = await createThread(f.commenter, f.boardId, 'first')
    await f.owner.req('DELETE', `/api/boards/${f.boardId}/members/${f.commenter.userId}`)
    await reply(f.editor, t.id, `second ${mention(f.commenter)}`)
    expect(await countRows(f.api, 'notifications')).toBe(0)
  })

  it('resolving notifies the other followers', async () => {
    const t = await createThread(f.commenter, f.boardId, 'first')
    await reply(f.commenter2, t.id, 'second')
    await f.editor.req('POST', `/api/threads/${t.id}/resolve`)
    const kinds = async (c: Fixture['owner']) => (await notificationsOf(c)).notifications.map((n) => n.kind)
    expect(await kinds(f.commenter)).toEqual(['resolved', 'reply'])
    expect(await kinds(f.commenter2)).toEqual(['resolved'])
    expect(await kinds(f.editor)).toEqual([])
    // Resolving it again changes nothing and notifies nobody.
    await f.commenter.req('POST', `/api/threads/${t.id}/resolve`)
    expect(await kinds(f.commenter2)).toEqual(['resolved'])
  })
})

describe('the notification list', () => {
  it('hides notifications about boards the person can no longer view', async () => {
    await createThread(f.commenter, f.boardId, `look ${mention(f.viewer)}`)
    expect((await notificationsOf(f.viewer)).unreadCount).toBe(1)
    await f.owner.req('DELETE', `/api/boards/${f.boardId}/members/${f.viewer.userId}`)
    const after = await notificationsOf(f.viewer)
    expect(after.notifications).toHaveLength(0)
    expect(after.unreadCount).toBe(0)
    // Access restored: the notification is back.
    await f.owner.req('PUT', `/api/boards/${f.boardId}/members/${f.viewer.userId}`, { role: 'viewer' })
    expect((await notificationsOf(f.viewer)).unreadCount).toBe(1)
  })

  it('hides notifications whose comment was deleted', async () => {
    const t = await createThread(f.commenter, f.boardId, `look ${mention(f.viewer)}`)
    await f.commenter.req('DELETE', `/api/comments/${t.comments[0]?.id}`)
    expect((await notificationsOf(f.viewer)).notifications).toHaveLength(0)
  })

  it('marks notifications read by id (own only), by thread, or all at once', async () => {
    const t1 = await createThread(f.commenter, f.boardId, `one ${mention(f.viewer)}`)
    await createThread(f.commenter, f.boardId, `two ${mention(f.viewer)}`)
    await createThread(f.commenter, f.boardId, `three ${mention(f.viewer)} ${mention(f.editor)}`)
    let vic = await notificationsOf(f.viewer)
    expect(vic.unreadCount).toBe(3)
    const editorsId = (await notificationsOf(f.editor)).notifications[0]?.id ?? ''

    // Someone else's id is ignored.
    const newest = vic.notifications[0]?.id ?? ''
    const res = await f.viewer.req('POST', '/api/me/notifications/read', { ids: [newest, editorsId] })
    expect(res.statusCode).toBe(204)
    vic = await notificationsOf(f.viewer)
    expect(vic.unreadCount).toBe(2)
    expect(vic.notifications.find((n) => n.id === newest)?.readAt).not.toBeNull()
    expect((await notificationsOf(f.editor)).unreadCount).toBe(1)

    // Opening (reading) a thread clears that thread's notifications.
    await f.viewer.req('POST', `/api/threads/${t1.id}/read`)
    expect((await notificationsOf(f.viewer)).unreadCount).toBe(1)
    const unreadOnly = await f.viewer.req('GET', '/api/me/notifications?unread=1')
    expect(unreadOnly.json().notifications).toHaveLength(1)

    await f.viewer.req('POST', '/api/me/notifications/read', { all: true })
    expect((await notificationsOf(f.viewer)).unreadCount).toBe(0)
    expect((await f.viewer.req('POST', '/api/me/notifications/read', {})).statusCode).toBe(400)
    expect((await f.viewer.req('POST', '/api/me/notifications/read', { ids: ['usr_x'] })).statusCode).toBe(
      400,
    )
  })

  it('lists access-request notifications (inserted by other features) only to people who can manage access', async () => {
    const insert = (userId: string) =>
      f.api.db.query(
        `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id)
         SELECT workspace_id, $1, 'access_request', id, $2 FROM boards WHERE id = $3`,
        [userId, f.stranger.userId, f.boardId],
      )
    await insert(f.owner.userId)
    await insert(f.editor.userId) // an editor cannot approve requests: not shown
    const owner = await notificationsOf(f.owner)
    expect(owner.notifications).toHaveLength(1)
    expect(owner.notifications[0]).toMatchObject({
      kind: 'access_request',
      threadId: null,
      commentId: null,
      snippet: null,
      actor: { id: f.stranger.userId },
    })
    expect(owner.notifications[0]?.id).toMatch(/^ntf_[0-9a-f]{32}$/)
    // No request row behind it: nothing to show beyond "asked for access".
    expect(owner.notifications[0]?.accessRequest).toBeNull()
    expect((await notificationsOf(f.editor)).notifications).toHaveLength(0)
  })

  it('an access-request notification carries the requested role and message, and the board hears about it live', async () => {
    const res = await f.stranger.req('POST', `/api/boards/${f.boardId}/access-requests`, {
      role: 'editor',
      message: 'I need to add the storyboard notes',
    })
    expect(res.statusCode).toBe(202)
    const owner = await notificationsOf(f.owner)
    const item = owner.notifications.find((n) => n.kind === 'access_request')
    expect(item).toMatchObject({
      actor: { id: f.stranger.userId },
      accessRequest: { role: 'editor', message: 'I need to add the storyboard notes', status: 'pending' },
    })
    // The board's clients get a hint to refresh the bell (the comments web store listens for it).
    expect(
      f.events.some(
        (e) =>
          e.boardId === f.boardId &&
          e.type === 'sharing.changed' &&
          String((e.data as { reason?: unknown }).reason).startsWith('access-request'),
      ),
    ).toBe(true)
    // Comment notifications never carry request details.
    await createThread(f.commenter, f.boardId, `${mention(f.owner)} hi`)
    const mentionItem = (await notificationsOf(f.owner)).notifications.find((n) => n.kind === 'mention')
    expect(mentionItem?.accessRequest).toBeNull()
  })
})

describe('write budget', () => {
  it('limits one person to a burst of comment writes per minute', async () => {
    const t = await createThread(f.commenter, f.boardId, 'x')
    let limited = 0
    for (let i = 0; i < 125; i++) {
      const res = await f.commenter.req('POST', `/api/threads/${t.id}/${i % 2 ? 'reopen' : 'resolve'}`)
      if (res.statusCode === 429) limited++
      else expect(res.statusCode).toBe(200)
    }
    expect(limited).toBe(6) // 120 writes per minute, the create counted as one
    // Other people are unaffected, and the budget refills.
    expect((await f.commenter2.req('POST', `/api/threads/${t.id}/resolve`)).statusCode).toBe(200)
    f.api.clock.advance(61_000)
    expect((await f.commenter.req('POST', `/api/threads/${t.id}/reopen`)).statusCode).toBe(200)
  })
})
