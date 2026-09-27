import {
  AccessRequestDecided,
  AccessRequestSent,
  ListAccessRequestsResponse,
  Me,
  MyAccessRequestResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACCESS_REQUEST_USER_LIMIT } from '../../../src/features/dashboard/access-requests.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { boardRole, DAY, setupWorld, tableExists, type World } from './setup.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const request = (c: Client, boardId: string, body: object = { role: 'editor' }) =>
  c.req('POST', `/api/boards/${boardId}/access-requests`, body)

async function pending(owner: Client, boardId: string) {
  const res = await owner.req('GET', `/api/boards/${boardId}/access-requests`)
  expect(res.statusCode, res.body).toBe(200)
  return ListAccessRequestsResponse.parse(res.json()).requests
}

const requestRows = async (w: World, boardId: string) =>
  (
    await w.api.db.query<{ user_id: string; status: string; role_requested: string }>(
      'SELECT user_id, status, role_requested FROM access_requests WHERE board_id = $1 ORDER BY created_at',
      [boardId],
    )
  ).rows

describe('access requests', () => {
  it('an outsider asks; owners see it; approving creates the grant and pushes access-changed to sync', async () => {
    const { erin, bob, board, api } = w
    const res = await request(erin, board, { role: 'editor', message: '  Client-side reviewer  ' })
    expect(res.statusCode).toBe(202)
    expect(AccessRequestSent.parse(res.json())).toEqual({ status: 'sent' })
    expect(w.published).toContainEqual({
      boardId: board,
      type: 'sharing.changed',
      data: { reason: 'access-request' },
    })

    const [req] = await pending(bob, board)
    expect(req).toMatchObject({
      boardId: board,
      user: { id: erin.userId, name: 'erin' },
      roleRequested: 'editor',
      message: 'Client-side reviewer',
      status: 'pending',
      currentRole: null,
    })
    expect(await boardRole(erin, board)).toBeNull()

    const approved = await bob.req('POST', `/api/access-requests/${req?.id}/approve`)
    expect(approved.statusCode, approved.body).toBe(200)
    expect(AccessRequestDecided.parse(approved.json()).request).toMatchObject({
      status: 'approved',
      roleGranted: 'editor',
      currentRole: 'editor',
    })
    expect(api.notifications).toContainEqual({ boardId: board, userId: erin.userId })
    expect(await boardRole(erin, board)).toBe('editor')
    // The outsider became a guest of the workspace (guests only see boards granted to them).
    const me = Me.parse((await erin.req('GET', '/api/me')).json())
    expect(me.workspaces.find((x) => x.id === DEV_STUDIO)?.role).toBe('guest')
    expect(await pending(bob, board)).toEqual([])
    const again = await bob.req('POST', `/api/access-requests/${req?.id}/approve`)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_DECIDED')
    const audit = await api.db.query<{ detail: { via?: string } }>(
      "SELECT detail FROM audit_events WHERE action = 'board.member.put' AND target = $1",
      [board],
    )
    expect(audit.rows.map((r) => r.detail.via)).toEqual(['access_request'])
  })

  it('the answer is identical for a missing board, a trashed board and a real one (no existence leak)', async () => {
    const { erin, bob, board, api } = w
    const trashed = await createBoard(bob, DEV_STUDIO, 'Old')
    await bob.req('POST', `/api/boards/${trashed}/trash`)
    const real = await request(erin, board)
    const missing = await request(erin, 'b-0000000000')
    const inTrash = await request(erin, trashed)
    for (const r of [missing, inTrash]) {
      expect(r.statusCode).toBe(real.statusCode)
      expect(r.body).toBe(real.body)
    }
    expect(await requestRows(w, trashed)).toEqual([])
    const all = await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM access_requests')
    expect(all.n).toBe(1)
    // Malformed ids are a plain 404 (nothing to hide), signed-out callers 401.
    expect((await request(erin, 'NOT A BOARD')).statusCode).toBe(404)
    expect(
      (await api.anon('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).statusCode,
    ).toBe(401)
    expect((await request(erin, board, { role: 'owner' })).statusCode).toBe(400)
    expect((await request(erin, board, { role: 'editor', message: 'x'.repeat(301) })).statusCode).toBe(400)
  })

  it('people with access may only ask for more than they have (viewer/commenter asking for edit)', async () => {
    const { bob, carol, board } = w
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'viewer' })
    const same = await request(carol, board, { role: 'viewer' })
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('ALREADY_HAS_ACCESS')
    expect((await request(bob, board, { role: 'editor' })).statusCode).toBe(409) // the owner
    expect((await request(carol, board, { role: 'editor' })).statusCode).toBe(202)
    const mine = MyAccessRequestResponse.parse(
      (await carol.req('GET', `/api/boards/${board}/access-requests/mine`)).json(),
    )
    expect(mine.request).toMatchObject({ roleRequested: 'editor', status: 'pending' })
    const [req] = await pending(bob, board)
    expect(req).toMatchObject({ user: { id: carol.userId }, currentRole: 'viewer', roleRequested: 'editor' })
    // The owner may grant less than asked (commenter); never a downgrade of what they have.
    const res = await bob.req('POST', `/api/access-requests/${req?.id}/approve`, { role: 'commenter' })
    expect(AccessRequestDecided.parse(res.json()).request.roleGranted).toBe('commenter')
    expect(await boardRole(carol, board)).toBe('commenter')
    expect((await carol.req('GET', `/api/boards/${board}/access-requests/mine`)).json()).toEqual({
      request: null,
    })
    // Owners never hand out ownership through a request.
    await request(carol, board, { role: 'editor' })
    const [next] = await pending(bob, board)
    expect(
      (await bob.req('POST', `/api/access-requests/${next?.id}/approve`, { role: 'owner' })).statusCode,
    ).toBe(400)
  })

  it('listing and deciding are for people who can manage access; others get 404/403 like the board', async () => {
    const { erin, frank, bob, carol, board, alice } = w
    await request(erin, board)
    const [req] = await pending(bob, board)
    // carol can't see the board at all: 404; as an editor she sees it but may not manage: 403.
    expect((await carol.req('GET', `/api/boards/${board}/access-requests`)).statusCode).toBe(404)
    expect((await carol.req('POST', `/api/access-requests/${req?.id}/approve`)).statusCode).toBe(404)
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    expect((await carol.req('GET', `/api/boards/${board}/access-requests`)).statusCode).toBe(403)
    expect((await carol.req('POST', `/api/access-requests/${req?.id}/approve`)).statusCode).toBe(403)
    expect((await carol.req('POST', `/api/access-requests/${req?.id}/deny`)).statusCode).toBe(403)
    // The requester cannot approve their own request; nor can another outsider.
    expect((await erin.req('POST', `/api/access-requests/${req?.id}/approve`)).statusCode).toBe(404)
    expect((await frank.req('POST', `/api/access-requests/${req?.id}/approve`)).statusCode).toBe(404)
    expect((await bob.req('POST', '/api/access-requests/acr_00000000000000000000/approve')).statusCode).toBe(
      404,
    )
    expect((await bob.req('POST', '/api/access-requests/nope/approve')).statusCode).toBe(404)
    expect(await boardRole(erin, board)).toBeNull()
    // A workspace owner owns every board, so alice can decide too.
    expect((await alice.req('GET', `/api/boards/${board}/access-requests`)).statusCode).toBe(200)
  })

  it('deny: no grant; the same person cannot re-ask for a day (silently); one pending row at a time', async () => {
    const { erin, bob, board, api } = w
    await request(erin, board, { role: 'viewer' })
    await request(erin, board, { role: 'editor' }) // raises the pending request instead of adding one
    expect(await requestRows(w, board)).toEqual([
      { user_id: erin.userId, status: 'pending', role_requested: 'editor' },
    ])
    const [req] = await pending(bob, board)
    const denied = await bob.req('POST', `/api/access-requests/${req?.id}/deny`)
    expect(AccessRequestDecided.parse(denied.json()).request).toMatchObject({
      status: 'denied',
      roleGranted: null,
    })
    expect(await boardRole(erin, board)).toBeNull()
    expect(api.notifications.filter((n) => n.userId === erin.userId)).toEqual([])

    expect((await request(erin, board)).statusCode).toBe(202)
    expect(await pending(bob, board)).toEqual([])
    api.clock.advance(DAY + 60_000)
    expect((await request(erin, board)).statusCode).toBe(202)
    expect((await pending(bob, board)).map((r) => r.user.id)).toEqual([erin.userId])
  })

  it('rate limit: per user across boards, and the 429 does not depend on whether a board exists', async () => {
    const { erin, board, api } = w
    for (let i = 0; i < ACCESS_REQUEST_USER_LIMIT.max; i++)
      expect(
        (await request(erin, i % 2 ? board : `b-00000000${String(i).padStart(2, '0')}`)).statusCode,
      ).toBe(202)
    const real = await request(erin, board)
    const fake = await request(erin, 'b-zzzzzzzzzz')
    expect(real.statusCode).toBe(429)
    expect(fake.statusCode).toBe(429)
    expect(real.body).toBe(fake.body)
    // Someone else is not affected; the window slides.
    expect((await request(w.frank, board)).statusCode).toBe(202)
    api.clock.advance(ACCESS_REQUEST_USER_LIMIT.windowMs + 1000)
    expect((await request(erin, board)).statusCode).toBe(202)
  })

  it('notifies board owners in-app when the notifications table exists (comments feature)', async () => {
    const { erin, bob, board, api, alice } = w
    await request(erin, board)
    if (!(await tableExists(api, 'notifications'))) return // comments feature not merged: request row only
    const rows = await api.db.query<{ user_id: string; kind: string; actor_id: string }>(
      'SELECT user_id, kind, actor_id FROM notifications WHERE board_id = $1',
      [board],
    )
    // bob holds the owner grant; alice (workspace owner) is only notified when a board has no owner grant.
    expect(rows.rows).toEqual([{ user_id: bob.userId, kind: 'access_request', actor_id: erin.userId }])
    // Re-asking within a day does not notify again (unless the role goes up).
    await request(erin, board, { role: 'editor' })
    expect(
      (await api.db.query('SELECT 1 FROM notifications WHERE board_id = $1', [board])).rows,
    ).toHaveLength(1)
    expect(alice.userId).not.toBe(bob.userId)
  })
})
