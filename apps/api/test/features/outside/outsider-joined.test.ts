// Wave J (migration 0026): the board's owners get a bell item ('outsider_joined', actor = the outsider)
// the first time an account outside Dark Burn / TPG opens one of their boards (its first connection
// ticket). Once per board and person; never for creators, name-only guests or unconfirmed accounts;
// listed only while the recipient manages access there, with the outsider's email domain, and only to a
// web build that declares LOBBY_CLIENT_REV >= 2 (an older one cannot parse the kind).

import { ListNotificationsResponse, LOBBY_CLIENT_HEADER } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'

let api: TestApi
let alice: Client // Dev Studio owner
let bob: Client // board owner
let carol: Client // creator editor (not an owner)
let pat: Client // outside account
let board: string

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
  await api.db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())",
    [DEV_STUDIO, pat.userId],
  )
  board = await createBoard(bob, DEV_STUDIO, 'Launch')
  for (const [c, role] of [
    [carol, 'editor'],
    [pat, 'commenter'],
  ] as const)
    expect((await bob.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role })).statusCode).toBe(200)
})
afterEach(() => api.close())

const bell = async (c: Client, rev = '2') => {
  const res = await c.req('GET', '/api/me/notifications', undefined, { [LOBBY_CLIENT_HEADER]: rev })
  expect(res.statusCode, res.body).toBe(200)
  return ListNotificationsResponse.parse(res.json())
}
const ticket = async (c: { req: Client['req'] }) => {
  const res = await c.req('POST', `/api/boards/${board}/ticket`)
  expect(res.statusCode, res.body).toBe(200)
}
const joinedRows = async () =>
  (
    await api.db.query<{ user_id: string; actor_id: string }>(
      "SELECT user_id, actor_id FROM notifications WHERE kind = 'outsider_joined' ORDER BY user_id",
    )
  ).rows

describe('outsider_joined', () => {
  it("the board's owners hear once when an outside account first opens the board", async () => {
    await ticket(pat)
    await vi.waitFor(async () => expect(await joinedRows()).toHaveLength(1))
    const [item] = (await bell(bob)).notifications
    expect(item).toMatchObject({
      kind: 'outsider_joined',
      boardId: board,
      boardTitle: 'Launch',
      threadId: null,
      actor: { id: pat.userId, name: 'Pat Client', external: true },
      outsiderJoined: { emailDomain: 'client.example.test' },
    })
    // Not the editor, not the outsider, not the workspace owner (the board has an owner grant).
    for (const c of [carol, pat, alice]) expect((await bell(c)).notifications).toEqual([])
    // A reconnect (another ticket), or another process's cache miss, adds nothing.
    await ticket(pat)
    await api.db.query('SELECT 1')
    expect(await joinedRows()).toEqual([{ user_id: bob.userId, actor_id: pat.userId }])
  })

  it('a web build from before 0026 (revision 1 or none) never sees the kind, in the list or the count', async () => {
    await ticket(pat)
    await vi.waitFor(async () => expect(await joinedRows()).toHaveLength(1))
    expect((await bell(bob, '2')).unreadCount).toBe(1)
    for (const rev of ['1', '0']) {
      const old = await bell(bob, rev)
      expect(old.unreadCount).toBe(0)
      expect(old.notifications).toEqual([])
    }
  })

  it('never for creators, name-only guests or accounts Lobby cannot confirm', async () => {
    await ticket(carol)
    const link = await guestLink(bob, board, { role: 'viewer' })
    const dana = await joinAsGuest(api, link.url, 'Dana')
    await ticket(dana)
    const ursula = await api.login('ursula', 'Ursula', { email: 'ursula@client.example.test' })
    await api.db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())",
      [DEV_STUDIO, ursula.userId],
    )
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${ursula.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    await api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [ursula.userId])
    await ticket(ursula)
    // give any notice time to land, then check none did
    await new Promise((r) => setTimeout(r, 200))
    expect(await joinedRows()).toEqual([])
    // Once Lobby has checked ursula's addresses (none qualifies), her next ticket tells the owner.
    await api.db.query('UPDATE users SET identity_checked_at = now() WHERE id = $1', [ursula.userId])
    await ticket(ursula)
    await vi.waitFor(async () =>
      expect(await joinedRows()).toEqual([{ user_id: bob.userId, actor_id: ursula.userId }]),
    )
  })

  it("is shown only while the recipient manages access there; a board without owners tells the workspace's", async () => {
    await ticket(pat)
    await vi.waitFor(async () => expect(await joinedRows()).toHaveLength(1))
    // bob loses access to manage the board: the item disappears from his bell
    await api.db.query("UPDATE board_members SET role = 'viewer' WHERE board_id = $1 AND user_id = $2", [
      board,
      bob.userId,
    ])
    expect((await bell(bob)).notifications).toEqual([])

    const orphan = await createBoard(bob, DEV_STUDIO, 'No owner left')
    await api.db.query('DELETE FROM board_members WHERE board_id = $1', [orphan])
    await api.db.query(
      "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'viewer', $3, now())",
      [orphan, pat.userId, alice.userId],
    )
    const res = await pat.req('POST', `/api/boards/${orphan}/ticket`)
    expect(res.statusCode, res.body).toBe(200)
    await vi.waitFor(async () => expect(await joinedRows()).toHaveLength(2))
    expect((await bell(alice)).notifications.map((n) => [n.kind, n.boardId])).toEqual([
      ['outsider_joined', orphan],
    ])
  })
})
