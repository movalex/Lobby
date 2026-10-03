// PRI-09b (migration 0024): a person whose access request is approved gets an 'access_granted' item in
// their bell (actor = the approver, with the role the approval gave). Listed only while they can view
// the board, and only to a web build that declares LOBBY_CLIENT_REV >= 1: a build from before 0024 (no
// x-lobby-client header) would fail to parse the whole list, so it gets neither the item nor its count.
import {
  ListAccessRequestsResponse,
  ListNotificationsResponse,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Client } from '../../helpers.ts'
import { boardRole, setupWorld, type World } from './setup.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const REV = { [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV) }

/** The bell as the current web build reads it. */
async function bell(c: Client) {
  const res = await c.req('GET', '/api/me/notifications', undefined, REV)
  expect(res.statusCode, res.body).toBe(200)
  return ListNotificationsResponse.parse(res.json())
}

/** The bell as a web build from before 0024 reads it: its own enum (a new kind fails the whole list). */
const OldBell = z.object({
  notifications: z.array(
    z.object({ kind: z.enum(['mention', 'reply', 'resolved', 'access_request', 'new_comment']) }),
  ),
  unreadCount: z.number().int().min(0),
})
async function oldBell(c: Client) {
  const res = await c.req('GET', '/api/me/notifications')
  expect(res.statusCode, res.body).toBe(200)
  return OldBell.parse(res.json())
}

async function requestAndDecide(c: Client, decision: 'approve' | 'deny', role = 'editor') {
  const sent = await c.req('POST', `/api/boards/${w.board}/access-requests`, { role })
  expect(sent.statusCode, sent.body).toBe(202)
  const list = await w.bob.req('GET', `/api/boards/${w.board}/access-requests`)
  const req = ListAccessRequestsResponse.parse(list.json()).requests.find((r) => r.user.id === c.userId)
  const res = await w.bob.req('POST', `/api/access-requests/${req?.id}/${decision}`)
  expect(res.statusCode, res.body).toBe(200)
}

describe('PRI-09b: access granted in the requester’s bell', () => {
  it('approving puts one unread item in the requester’s bell: who approved, which board, what role', async () => {
    const { erin, bob, board } = w
    expect((await bell(erin)).unreadCount).toBe(0)
    await requestAndDecide(erin, 'approve', 'commenter')
    expect(await boardRole(erin, board)).toBe('commenter')
    const inbox = await bell(erin)
    expect(inbox.unreadCount).toBe(1)
    expect(inbox.notifications).toEqual([
      expect.objectContaining({
        kind: 'access_granted',
        boardId: board,
        boardTitle: 'Campaign review',
        threadId: null,
        commentId: null,
        actor: expect.objectContaining({ id: bob.userId, name: 'bob' }),
        accessGranted: { role: 'commenter' },
        accessRequest: null,
        snippet: null,
        readAt: null,
      }),
    ])
    // The approver gets nothing for it (bob's bell holds only erin's request).
    expect((await bell(bob)).notifications.map((n) => n.kind)).toEqual(['access_request'])
    // Read from the bell like any other item.
    const read = await erin.req(
      'POST',
      '/api/me/notifications/read',
      { ids: [inbox.notifications[0]?.id] },
      REV,
    )
    expect(read.statusCode).toBe(204)
    expect((await bell(erin)).unreadCount).toBe(0)
  })

  it('a denial puts nothing in the bell', async () => {
    await requestAndDecide(w.erin, 'deny')
    expect(await bell(w.erin)).toEqual({ notifications: [], unreadCount: 0 })
  })

  it('a web build from before 0024 gets neither the item nor its count (its list still parses)', async () => {
    const { erin, bob, carol, board } = w
    await requestAndDecide(erin, 'approve')
    expect(await oldBell(erin)).toEqual({ notifications: [], unreadCount: 0 })
    // Every other kind is answered to it as before: bob's bell still holds erin's request.
    expect(await oldBell(bob)).toEqual({ notifications: [{ kind: 'access_request' }], unreadCount: 1 })
    // A revision header it cannot read counts as revision 0.
    await requestAndDecide(carol, 'approve')
    expect((await bell(carol)).notifications.map((n) => n.kind)).toEqual(['access_granted'])
    const bogus = await carol.req('GET', '/api/me/notifications', undefined, { [LOBBY_CLIENT_HEADER]: 'new' })
    expect(OldBell.parse(bogus.json())).toEqual({ notifications: [], unreadCount: 0 })
    expect(await boardRole(carol, board)).toBe('editor')
  })

  it('the item goes when the access goes (listing re-checks it)', async () => {
    const { erin, bob, board } = w
    await requestAndDecide(erin, 'approve')
    expect((await bell(erin)).unreadCount).toBe(1)
    const removed = await bob.req('DELETE', `/api/boards/${board}/members/${erin.userId}`)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await bell(erin)).toEqual({ notifications: [], unreadCount: 0 })
  })
})
