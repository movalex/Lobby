// authz-006: managing workspace members (PATCH and DELETE /api/workspaces/:wid/members/:uid). Owners and
// admins manage; only an owner changes, removes or makes an owner; the last owner and the person whose
// personal workspace it is stay owners; raising is creator-only and admin/owner go to creators only
// (docs/DOMAIN-ACCESS-CONTRACTS.md D4, D5); removing a member revokes their board grants in the same
// transaction; and every change that moves someone's access is pushed to sync (`accessChanged`) and
// reaches their open board event streams at once.

import { ListMembersResponse, ListWorkspaceMembersResponse, type WorkspaceRole } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../src/events/hub.ts'
import { MAX_ACCESS_NOTIFICATIONS } from '../src/routes/workspaces.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'
import { listen, openSse, type SseStream } from './sse.ts'

const HOUR = 60 * 60 * 1000

let api: TestApi
let alice: Client // Dev Studio owner (first login), a creator
let bob: Client // Dev Studio member, a creator
let carol: Client // Dev Studio member, a creator
let dave: Client // Dev Studio member, a creator
const streams: SseStream[] = []

async function setup(deps: Parameters<typeof createTestApi>[0] = {}) {
  api = await createTestApi(deps)
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  api.notifications.length = 0
}
afterEach(async () => {
  for (const s of streams.splice(0)) await s.close()
  await api?.close()
})

const url = (uid: string, wid = DEV_STUDIO) => `/api/workspaces/${wid}/members/${uid}`
const patch = (c: Client, uid: string, role: string, wid = DEV_STUDIO) =>
  c.req('PATCH', url(uid, wid), { role })
const remove = (c: Client, uid: string, wid = DEV_STUDIO) => c.req('DELETE', url(uid, wid))
const roleOf = async (uid: string, wid = DEV_STUDIO) =>
  (
    await api.db.maybeOne<{ role: WorkspaceRole }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [wid, uid],
    )
  )?.role ?? null
const setRole = (uid: string, role: WorkspaceRole, wid = DEV_STUDIO) =>
  api.db.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [
    wid,
    uid,
    role,
  ])
const codeOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code
const audits = async () =>
  (
    await api.db.query<{ action: string; detail: Record<string, unknown> }>(
      "SELECT action, detail FROM audit_events WHERE action LIKE 'workspace.member.%' ORDER BY id",
    )
  ).rows
/** Someone signed in with an outside address (not a creator), added to Dev Studio with `role`. */
async function outsider(handle: string, role: WorkspaceRole): Promise<Client> {
  const c = await api.login(handle, handle, { email: `${handle}@client.example.test` })
  await api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, now())`,
    [DEV_STUDIO, c.userId, role],
  )
  return c
}

describe('changing a workspace role', () => {
  beforeEach(() => setup())

  it('an owner or an admin changes a member’s role; the answer is the updated list; it is audited', async () => {
    const res = await patch(alice, bob.userId, 'admin')
    expect(res.statusCode, res.body).toBe(200)
    const list = ListWorkspaceMembersResponse.parse(res.json()).members
    expect(list.map((m) => [m.user.id, m.role])).toEqual([
      [alice.userId, 'owner'],
      [bob.userId, 'admin'],
      [carol.userId, 'member'],
      [dave.userId, 'member'],
    ])
    // the admin manages too: down to guest and back up (a creator raising a creator)
    expect((await patch(bob, carol.userId, 'guest')).statusCode).toBe(200)
    expect(await roleOf(carol.userId)).toBe('guest')
    expect((await patch(bob, carol.userId, 'member')).statusCode).toBe(200)
    // the same role again changes nothing and writes nothing
    expect((await patch(bob, carol.userId, 'member')).statusCode).toBe(200)
    expect((await audits()).map((a) => [a.action, a.detail])).toEqual([
      ['workspace.member.role', { userId: bob.userId, role: 'admin', previousRole: 'member' }],
      ['workspace.member.role', { userId: carol.userId, role: 'guest', previousRole: 'member' }],
      ['workspace.member.role', { userId: carol.userId, role: 'member', previousRole: 'guest' }],
    ])
  })

  it('members and guests cannot manage (403); people outside the workspace get 404; bad input is 400', async () => {
    expect((await patch(bob, carol.userId, 'guest')).statusCode).toBe(403)
    expect((await remove(bob, carol.userId)).statusCode).toBe(403)
    await setRole(dave.userId, 'guest')
    expect((await patch(dave, carol.userId, 'guest')).statusCode).toBe(403)
    expect((await remove(dave, carol.userId)).statusCode).toBe(403)
    // bob's personal workspace: alice is not in it
    expect((await patch(alice, bob.userId, 'member', bob.personalWorkspaceId)).statusCode).toBe(404)
    expect((await remove(alice, bob.userId, bob.personalWorkspaceId)).statusCode).toBe(404)
    expect((await patch(alice, bob.userId, 'member', 'wsp_Nonexistent0000000000')).statusCode).toBe(404)
    // a user who is not a member of Dev Studio, and an id that is not one
    const erin = await api.login('erin', 'Erin', { email: 'erin@client.example.test' })
    expect((await patch(alice, erin.userId, 'member')).statusCode).toBe(404)
    expect((await remove(alice, erin.userId)).statusCode).toBe(404)
    expect((await patch(alice, 'not-a-user', 'member')).statusCode).toBe(404)
    expect((await patch(alice, bob.userId, 'superuser')).statusCode).toBe(400)
    expect((await alice.req('PATCH', url(bob.userId), {})).statusCode).toBe(400)
    expect(await audits()).toEqual([])
    expect(api.notifications).toEqual([])
  })

  it('a name-only guest is not managed here (404, as the list leaves them out)', async () => {
    const guest = await api.db.one<{ id: string }>(
      `INSERT INTO users (id, name, color, kind, guest_name, created_at)
       VALUES ('usr_Guest0000000000000001', 'Visitor (guest)', '#123456', 'guest', 'Visitor', now()) RETURNING id`,
    )
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())`,
      [DEV_STUDIO, guest.id],
    )
    expect((await patch(alice, guest.id, 'member')).statusCode).toBe(404)
    expect((await remove(alice, guest.id)).statusCode).toBe(404)
    expect(await roleOf(guest.id)).toBe('guest')
  })
})

describe('owners', () => {
  beforeEach(() => setup())

  it('the last owner can be neither demoted nor removed, not even by themselves (409 LAST_OWNER)', async () => {
    for (const role of ['admin', 'member', 'guest']) {
      const res = await patch(alice, alice.userId, role)
      expect(res.statusCode, role).toBe(409)
      expect(codeOf(res)).toBe('LAST_OWNER')
    }
    const res = await remove(alice, alice.userId)
    expect(res.statusCode).toBe(409)
    expect(codeOf(res)).toBe('LAST_OWNER')
    expect(await roleOf(alice.userId)).toBe('owner')
    // with a second owner, either one can step down or leave
    expect((await patch(alice, bob.userId, 'owner')).statusCode).toBe(200)
    expect((await patch(alice, alice.userId, 'admin')).statusCode).toBe(200)
    // bob is the last owner now
    expect(codeOf(await remove(bob, bob.userId))).toBe('LAST_OWNER')
    expect(codeOf(await patch(bob, bob.userId, 'member'))).toBe('LAST_OWNER')
    expect(await roleOf(bob.userId)).toBe('owner')
  })

  it('an admin cannot demote or remove an owner, nor make one (403 OWNER_ONLY); an owner can', async () => {
    await setRole(bob.userId, 'admin')
    await setRole(carol.userId, 'owner')
    for (const res of [
      await patch(bob, alice.userId, 'member'),
      await remove(bob, carol.userId),
      await patch(bob, dave.userId, 'owner'),
      await patch(bob, bob.userId, 'owner'),
    ]) {
      expect(res.statusCode).toBe(403)
      expect(codeOf(res)).toBe('OWNER_ONLY')
    }
    expect([await roleOf(alice.userId), await roleOf(carol.userId), await roleOf(dave.userId)]).toEqual([
      'owner',
      'owner',
      'member',
    ])
    // an admin still manages admins and members (bob demotes himself, too)
    expect((await patch(alice, dave.userId, 'admin')).statusCode).toBe(200)
    expect((await patch(bob, dave.userId, 'member')).statusCode).toBe(200)
    expect((await patch(bob, bob.userId, 'member')).statusCode).toBe(200)
    // an owner demotes and removes another owner
    expect((await patch(alice, carol.userId, 'admin')).statusCode).toBe(200)
    expect((await patch(alice, carol.userId, 'owner')).statusCode).toBe(200)
    expect((await remove(alice, carol.userId)).statusCode).toBe(200)
    expect(await roleOf(carol.userId)).toBeNull()
  })

  it('the person whose personal workspace it is stays its owner (409 PERSONAL_WORKSPACE_OWNER)', async () => {
    const wid = bob.personalWorkspaceId
    expect(wid).not.toBe('')
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', now())`,
      [wid, carol.userId],
    )
    for (const res of [
      await patch(carol, bob.userId, 'admin', wid),
      await remove(carol, bob.userId, wid),
      await patch(bob, bob.userId, 'member', wid),
    ]) {
      expect(res.statusCode).toBe(409)
      expect(codeOf(res)).toBe('PERSONAL_WORKSPACE_OWNER')
    }
    expect(await roleOf(bob.userId, wid)).toBe('owner')
    // the other owner can still be managed there
    expect((await remove(bob, carol.userId, wid)).statusCode).toBe(200)
  })

  // PGlite has one connection, so this checks the decision inside the transaction (the second request is
  // refused: its caller is no longer an owner); the row lock that serializes them on a real Postgres pool
  // is the workspace row's FOR NO KEY UPDATE (not run here without DRAFTROOM_TEST_DATABASE_URL).
  it('two owners demoting each other at once leave one owner', async () => {
    await setRole(bob.userId, 'owner')
    const [a, b] = await Promise.all([patch(alice, bob.userId, 'member'), patch(bob, alice.userId, 'member')])
    const codes = [a.statusCode, b.statusCode]
    expect(codes.filter((c) => c === 200)).toHaveLength(1)
    expect(codes.find((c) => c !== 200)).toBe(403)
    const owners = await api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
      [DEV_STUDIO],
    )
    expect(owners.n).toBe(1)
  })
})

describe('domain access', () => {
  beforeEach(() => setup())

  it('raising needs a creator caller (403 CREATOR_REQUIRED); lowering and removing stay open to an outside admin', async () => {
    const pat = await outsider('pat', 'admin') // a pre-existing outside admin (decision 4)
    for (const role of ['admin', 'member']) {
      if (role === 'member') await setRole(carol.userId, 'guest')
      const res = await patch(pat, role === 'admin' ? bob.userId : carol.userId, role)
      expect(res.statusCode, role).toBe(403)
      expect(codeOf(res)).toBe('CREATOR_REQUIRED')
    }
    expect([await roleOf(bob.userId), await roleOf(carol.userId)]).toEqual(['member', 'guest'])
    expect((await patch(pat, bob.userId, 'guest')).statusCode).toBe(200)
    expect((await remove(pat, dave.userId)).statusCode).toBe(200)
    expect((await patch(pat, pat.userId, 'member')).statusCode).toBe(200)
  })

  it('admin and owner go to creators only (409 ROLE_REQUIRES_CREATOR); member and guest go to anyone', async () => {
    const sam = await outsider('sam', 'guest')
    for (const role of ['admin', 'owner']) {
      const res = await patch(alice, sam.userId, role)
      expect(res.statusCode, role).toBe(409)
      expect(codeOf(res)).toBe('ROLE_REQUIRES_CREATOR')
    }
    expect((await patch(alice, sam.userId, 'member')).statusCode).toBe(200)
    expect(await roleOf(sam.userId)).toBe('member')
    // a creator gets either
    expect((await patch(alice, bob.userId, 'admin')).statusCode).toBe(200)
    expect((await patch(alice, carol.userId, 'owner')).statusCode).toBe(200)
  })
})

describe('board access follows', () => {
  beforeEach(() => setup())

  it('removing a member revokes every board grant they hold in the workspace, in the same change, and tells sync for each board', async () => {
    const own = await createBoard(bob, DEV_STUDIO, 'Bob’s board') // bob: owner grant
    const shared = await createBoard(alice, DEV_STUDIO, 'Shared with bob')
    const open = await createBoard(alice, DEV_STUDIO, 'Workspace can view')
    const untouched = await createBoard(alice, DEV_STUDIO, 'Not bob’s')
    const elsewhere = await createBoard(alice, alice.personalWorkspaceId, 'Another workspace')
    const grant = async (c: Client, bid: string, uid: string, role: string) =>
      expect((await c.req('PUT', `/api/boards/${bid}/members/${uid}`, { role })).statusCode).toBe(200)
    await grant(alice, shared, bob.userId, 'editor')
    await grant(alice, own, carol.userId, 'viewer')
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())`,
      [alice.personalWorkspaceId, bob.userId],
    )
    await grant(alice, elsewhere, bob.userId, 'commenter')
    expect(
      (await alice.req('PATCH', `/api/boards/${open}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    api.notifications.length = 0

    const res = await remove(alice, bob.userId)
    expect(res.statusCode, res.body).toBe(200)
    expect(ListWorkspaceMembersResponse.parse(res.json()).members.map((m) => m.user.id)).not.toContain(
      bob.userId,
    )
    const left = await api.db.query<{ board_id: string }>(
      'SELECT board_id FROM board_members WHERE user_id = $1 ORDER BY board_id',
      [bob.userId],
    )
    expect(left.rows.map((r) => r.board_id)).toEqual([elsewhere]) // another workspace's grant stays
    expect(api.notifications.map((n) => n.boardId).sort()).toEqual([open, own, shared].sort())
    expect(api.notifications.every((n) => n.userId === bob.userId)).toBe(true)
    expect(untouched).not.toBe('')
    for (const bid of [own, shared, open])
      expect((await bob.req('GET', `/api/boards/${bid}`)).statusCode).toBe(404)
    expect((await bob.req('POST', `/api/boards/${shared}/ticket`)).statusCode).toBe(404)
    expect((await bob.req('GET', `/api/boards/${elsewhere}`)).statusCode).toBe(200)
    // bob's board keeps an owner through the workspace (alice), and carol's grant on it
    const members = ListMembersResponse.parse((await alice.req('GET', `/api/boards/${own}/members`)).json())
    expect(members.members.map((m) => [m.user.id, m.role])).toEqual([
      [alice.userId, 'owner'],
      [carol.userId, 'viewer'],
    ])
    const [entry] = await audits()
    expect(entry).toEqual({
      action: 'workspace.member.remove',
      detail: { userId: bob.userId, previousRole: 'member', boardGrantsRemoved: 2 },
    })
    // gone: a second removal is a 404, and the workspace list no longer has them
    expect((await remove(alice, bob.userId)).statusCode).toBe(404)
    expect((await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/members`)).statusCode).toBe(404)
  })

  it('a demotion keeps board grants and tells sync about every board where the role moved', async () => {
    await setRole(bob.userId, 'admin')
    const mine = await createBoard(bob, DEV_STUDIO, 'Bob’s') // admin, and an owner grant
    const privateOne = await createBoard(alice, DEV_STUDIO, 'Private')
    const viewable = await createBoard(alice, DEV_STUDIO, 'Viewable')
    const editable = await createBoard(alice, DEV_STUDIO, 'Editable')
    const withGrant = await createBoard(alice, DEV_STUDIO, 'Granted')
    await alice.req('PATCH', `/api/boards/${viewable}`, { visibility: 'workspace_view' })
    await alice.req('PATCH', `/api/boards/${editable}`, { visibility: 'workspace_edit' })
    await alice.req('PUT', `/api/boards/${withGrant}/members/${bob.userId}`, { role: 'editor' })
    const trashed = await createBoard(alice, DEV_STUDIO, 'Trashed')
    expect((await alice.req('POST', `/api/boards/${trashed}/trash`)).statusCode).toBe(200)
    api.notifications.length = 0

    // admin → member: owner everywhere becomes the grant or the board's workspace access
    expect((await patch(alice, bob.userId, 'member')).statusCode).toBe(200)
    expect(api.notifications.map((n) => n.boardId).sort()).toEqual(
      [privateOne, viewable, editable, withGrant].sort(),
    )
    expect((await bob.req('GET', `/api/boards/${mine}`)).json()).toMatchObject({ role: 'owner' })
    expect((await bob.req('GET', `/api/boards/${withGrant}`)).json()).toMatchObject({ role: 'editor' })
    expect((await bob.req('GET', `/api/boards/${viewable}`)).json()).toMatchObject({ role: 'viewer' })
    expect((await bob.req('GET', `/api/boards/${privateOne}`)).statusCode).toBe(404)

    // member → guest: only the boards the workspace's access gave
    api.notifications.length = 0
    expect((await patch(alice, bob.userId, 'guest')).statusCode).toBe(200)
    expect(api.notifications.map((n) => n.boardId).sort()).toEqual([viewable, editable].sort())
    expect((await bob.req('GET', `/api/boards/${mine}`)).json()).toMatchObject({ role: 'owner' })

    // a raise tells sync as well (bob gains the workspace-visible boards again)
    api.notifications.length = 0
    expect((await patch(alice, bob.userId, 'member')).statusCode).toBe(200)
    expect(api.notifications.map((n) => n.boardId).sort()).toEqual([viewable, editable].sort())
    // nothing moves, nothing is told
    api.notifications.length = 0
    expect((await patch(alice, bob.userId, 'member')).statusCode).toBe(200)
    expect(api.notifications).toEqual([])
  })

  it('tells sync about at most MAX_ACCESS_NOTIFICATIONS boards, the most recently opened first', async () => {
    expect(MAX_ACCESS_NOTIFICATIONS).toBe(500)
    const board = await createBoard(alice, DEV_STUDIO, 'Recent')
    await api.db.query(
      `INSERT INTO boards (id, workspace_id, title, visibility, created_by, created_at, updated_at, last_opened_at)
       SELECT 'b-bulk' || lpad(g::text, 4, '0'), $1, 'Bulk', 'workspace_view', $2, now(), now(), now() - interval '1 day'
         FROM generate_series(1, 520) g`,
      [DEV_STUDIO, alice.userId],
    )
    await api.db.query(
      "UPDATE boards SET visibility = 'workspace_view', last_opened_at = now() WHERE id = $1",
      [board],
    )
    api.notifications.length = 0
    expect((await remove(alice, carol.userId)).statusCode).toBe(200)
    expect(api.notifications).toHaveLength(MAX_ACCESS_NOTIFICATIONS)
    expect(api.notifications[0]).toEqual({ boardId: board, userId: carol.userId })
  })
})

describe('open tabs', () => {
  it('a removed member’s open board event stream ends at once (access-lost), without waiting for the periodic check', async () => {
    const hub = new EventHub()
    await setup({ deps: { events: hub, limits: { streamRecheckMs: HOUR } } })
    const board = await createBoard(alice, DEV_STUDIO, 'Live board')
    await alice.req('PUT', `/api/boards/${board}/members/${bob.userId}`, { role: 'editor' })
    const base = await listen(api)
    const s = await openSse(base, board, bob.cookie)
    streams.push(s)
    await s.waitFor('hello')
    expect((await remove(alice, bob.userId)).statusCode).toBe(200)
    await s.waitFor('access-lost', 2_000)
    await s.waitEnded()
  })

  it('a demoted admin’s stream on a board they only owned through the workspace ends at once', async () => {
    const hub = new EventHub()
    await setup({ deps: { events: hub, limits: { streamRecheckMs: HOUR } } })
    await setRole(bob.userId, 'admin')
    const board = await createBoard(alice, DEV_STUDIO, 'Private board')
    const base = await listen(api)
    const s = await openSse(base, board, bob.cookie)
    streams.push(s)
    await s.waitFor('hello')
    expect((await patch(alice, bob.userId, 'member')).statusCode).toBe(200)
    await s.waitFor('access-lost', 2_000)
  })
})
