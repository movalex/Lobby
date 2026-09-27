import { ListMembersResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner
let bob: Client
let carol: Client
let dave: Client
let boardId: string

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  boardId = await createBoard(bob, DEV_STUDIO, 'Shared')
  api.notifications.length = 0
})
afterEach(() => api.close())

const members = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${boardId}/members`)
  expect(res.statusCode, res.body).toBe(200)
  return ListMembersResponse.parse(res.json()).members
}
const put = (c: Client, uid: string, role: string) =>
  c.req('PUT', `/api/boards/${boardId}/members/${uid}`, { role })
const del = (c: Client, uid: string) => c.req('DELETE', `/api/boards/${boardId}/members/${uid}`)

describe('board members', () => {
  it('lists explicit grants and workspace-derived access with its source', async () => {
    await put(bob, carol.userId, 'commenter')
    const list = await members(bob)
    expect(list.map((m) => [m.user.id, m.role, m.source])).toEqual([
      [alice.userId, 'owner', 'workspace'], // Dev Studio owner
      [bob.userId, 'owner', 'grant'],
      [carol.userId, 'commenter', 'grant'],
    ])
    // Dave sees nothing yet, so he is not listed; with workspace_view every member is a viewer.
    await bob.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })
    const after = await members(carol)
    expect(after.find((m) => m.user.id === dave.userId)).toMatchObject({
      role: 'viewer',
      source: 'workspace',
    })
    expect(after.find((m) => m.user.id === carol.userId)).toMatchObject({
      role: 'commenter',
      source: 'grant',
    })
  })

  it('grant, change and revoke: each is audited and pushed to sync for that user', async () => {
    expect((await put(bob, carol.userId, 'editor')).statusCode).toBe(200)
    expect((await put(bob, carol.userId, 'viewer')).statusCode).toBe(200)
    expect((await put(bob, carol.userId, 'viewer')).statusCode).toBe(200) // unchanged: no push
    const removed = await del(bob, carol.userId)
    expect(removed.statusCode).toBe(200)
    expect(ListMembersResponse.parse(removed.json()).members.map((m) => m.user.id)).not.toContain(
      carol.userId,
    )
    expect(api.notifications).toEqual([
      { boardId, userId: carol.userId },
      { boardId, userId: carol.userId },
      { boardId, userId: carol.userId },
    ])
    const events = await api.db.query<{ action: string; detail: { userId: string; role?: string } }>(
      "SELECT action, detail FROM audit_events WHERE action LIKE 'board.member.%' ORDER BY id",
    )
    expect(events.rows.map((e) => [e.action, e.detail.userId, e.detail.role])).toEqual([
      ['board.member.put', carol.userId, 'editor'],
      ['board.member.put', carol.userId, 'viewer'],
      ['board.member.remove', carol.userId, undefined],
    ])
    expect((await carol.req('GET', `/api/boards/${boardId}`)).statusCode).toBe(404)
  })

  it('only owners manage access', async () => {
    await put(bob, carol.userId, 'editor')
    expect((await put(carol, dave.userId, 'viewer')).statusCode).toBe(403)
    expect((await del(carol, bob.userId)).statusCode).toBe(403)
    expect((await put(dave, dave.userId, 'owner')).statusCode).toBe(404) // cannot even see it
    // A workspace owner is an owner of every board, so alice can manage bob's private board.
    expect((await put(alice, dave.userId, 'viewer')).statusCode).toBe(200)
    expect(api.notifications.map((n) => n.userId)).toEqual([carol.userId, dave.userId])
  })

  it('refuses users outside the board workspace and unknown ids with 404', async () => {
    const outsider = await api.login('outsider')
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      outsider.userId,
      DEV_STUDIO,
    ])
    expect((await put(bob, outsider.userId, 'viewer')).statusCode).toBe(404)
    expect((await put(bob, 'usr_00000000000000000000', 'viewer')).statusCode).toBe(404)
    expect((await put(bob, 'not-a-user', 'viewer')).statusCode).toBe(404)
    expect((await put(bob, carol.userId, 'superuser')).statusCode).toBe(400)
  })

  it('the last owner can be neither demoted nor removed', async () => {
    const demote = await put(bob, bob.userId, 'editor')
    expect(demote.statusCode).toBe(409)
    expect(demote.json().error.code).toBe('LAST_OWNER')
    expect((await del(bob, bob.userId)).statusCode).toBe(409)
    // A workspace admin/owner is an implicit owner but does not count: the board keeps an explicit owner.
    expect((await del(alice, bob.userId)).statusCode).toBe(409)
    expect(await api.db.one('SELECT role FROM board_members WHERE user_id = $1', [bob.userId])).toEqual({
      role: 'owner',
    })
    // With a second owner, either can step down.
    await put(bob, carol.userId, 'owner')
    expect((await put(bob, bob.userId, 'editor')).statusCode).toBe(200)
    expect((await del(carol, bob.userId)).statusCode).toBe(200)
    expect((await del(carol, carol.userId)).statusCode).toBe(409)
    expect(api.notifications.length).toBeGreaterThan(0)
  })

  it('an owner grant held by someone who left the workspace does not count as another owner', async () => {
    await put(bob, carol.userId, 'owner')
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      carol.userId,
      DEV_STUDIO,
    ])
    expect((await del(bob, bob.userId)).statusCode).toBe(409)
  })
})
