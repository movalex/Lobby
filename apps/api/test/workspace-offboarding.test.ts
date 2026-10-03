// authz-006 follow-up 6: offboarding. Removing a workspace member also ends what they had in flight in
// that workspace, in the same transaction: their unused single-use invitations are revoked, their pending
// access requests are denied, and their multi-use links are kept (and named in the audit entry). And a
// PATCH never asks the identity provider about someone who is no member of the workspace.
//
// PGlite has one connection, so these check the decisions and the end states; the interleavings (an
// approval or a board grant racing a removal) are in workspace-offboarding.pg.test.ts, which needs a real
// Postgres (DRAFTROOM_TEST_DATABASE_URL).

import {
  InvitationCreated,
  ListInvitationsResponse,
  ListWorkspaceMembersResponse,
  ReviewLinkCreated,
} from '@draftroom/contracts'
import type { WorkspaceRole } from '@draftroom/permissions'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner (first login), a creator
let bob: Client // Dev Studio member, a creator: the leaver
let carol: Client // Dev Studio member
let erin: Client // outsiders (only their own workspaces): the invitees
let frank: Client
let gina: Client

async function setup() {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  erin = await api.login('erin')
  frank = await api.login('frank')
  gina = await api.login('gina')
  // every dev login joins Dev Studio: the invitees are outsiders to it
  for (const c of [erin, frank, gina])
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      c.userId,
      DEV_STUDIO,
    ])
  api.notifications.length = 0
}
beforeEach(setup)
afterEach(async () => {
  vi.restoreAllMocks()
  await api?.close()
})

const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
const codeOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code
const remove = (c: Client, uid: string, wid = DEV_STUDIO) =>
  c.req('DELETE', `/api/workspaces/${wid}/members/${uid}`)
const patch = (c: Client, uid: string, role: string) =>
  c.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${uid}`, { role })
const setRole = (uid: string, role: WorkspaceRole) =>
  api.db.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [
    DEV_STUDIO,
    uid,
    role,
  ])

async function invite(c: Client, path: string, body: Record<string, unknown>) {
  const res = await c.req('POST', path, body)
  expect(res.statusCode, res.body).toBe(201)
  return InvitationCreated.parse(res.json())
}
const boardInvite = (c: Client, bid: string, role: string, to: Client) =>
  invite(c, `/api/boards/${bid}/invitations`, { role, email: devEmail(to.me.user.name) })
const accept = (c: Client, inv: { url: string }) =>
  c.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`)
const revokedAt = async (id: string) =>
  (await api.db.one<{ revoked_at: Date | null }>('SELECT revoked_at FROM invitations WHERE id = $1', [id]))
    .revoked_at
const removeAudit = async () =>
  (
    await api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
  ).detail

describe('invitations the leaver sent', () => {
  it('unused single-use ones are revoked; used, expired, other people’s and other workspaces’ stand', async () => {
    await setRole(bob.userId, 'admin') // an admin invites to the workspace, too
    const bobBoard = await createBoard(bob, DEV_STUDIO, 'Bob’s board')
    const carolBoard = await createBoard(carol, DEV_STUDIO, 'Carol’s board')
    const bobAlone = await createBoard(bob, bob.personalWorkspaceId, 'Bob alone')

    const toBoard = await boardInvite(bob, bobBoard, 'editor', erin)
    const toWorkspace = await invite(bob, `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: devEmail('frank'),
    })
    const used = await boardInvite(bob, bobBoard, 'viewer', gina)
    expect((await accept(gina, used)).statusCode).toBe(200)
    const expired = await boardInvite(bob, bobBoard, 'viewer', frank)
    await api.db.query(
      `UPDATE invitations SET created_at = created_at - interval '10 days',
                              expires_at = expires_at - interval '10 days' WHERE id = $1`,
      [expired.id],
    )
    const elsewhere = await boardInvite(bob, bobAlone, 'viewer', erin)
    const carols = await boardInvite(carol, carolBoard, 'viewer', erin)

    const res = await remove(alice, bob.userId)
    expect(res.statusCode, res.body).toBe(200)

    expect(await revokedAt(toBoard.id)).not.toBeNull()
    expect(await revokedAt(toWorkspace.id)).not.toBeNull()
    for (const keep of [used, expired, elsewhere, carols]) expect(await revokedAt(keep.id)).toBeNull()
    // what the invitees see: the revoked links are gone, the others still work
    expect((await accept(erin, toBoard)).statusCode).toBe(410)
    expect((await accept(frank, toWorkspace)).statusCode).toBe(410)
    expect((await accept(erin, carols)).statusCode).toBe(200)
    expect((await accept(erin, elsewhere)).statusCode).toBe(200)
    // the invitee who had already used theirs keeps what it gave them
    expect((await gina.req('GET', `/api/boards/${bobBoard}`)).json()).toMatchObject({ role: 'viewer' })

    // audited like any revoke (by the person who removed them), and counted on the removal
    const revokes = await api.db.query<{ actor_id: string; target: string; detail: Record<string, unknown> }>(
      "SELECT actor_id, target, detail FROM audit_events WHERE action = 'invitation.revoke' ORDER BY id",
    )
    expect(revokes.rows.map((r) => [r.actor_id, r.target]).sort()).toEqual(
      [toBoard.id, toWorkspace.id].map((id) => [alice.userId, id]).sort(),
    )
    for (const r of revokes.rows)
      expect(r.detail).toMatchObject({ via: 'member_removed', userId: bob.userId })
    expect(await removeAudit()).toMatchObject({ userId: bob.userId, invitationsRevoked: 2 })
  })

  it('their multi-use links stay open, with their name on them, and the audit entry names them', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Review me')
    const made = await bob.req('POST', `/api/boards/${board}/review-links`, { role: 'commenter' })
    expect(made.statusCode, made.body).toBe(201)
    const link = ReviewLinkCreated.parse(made.json())

    expect((await remove(alice, bob.userId)).statusCode).toBe(200)
    expect(await revokedAt(link.id)).toBeNull()

    // the board's managers see it, and who made it (a workspace owner manages every board)
    const listed = ListInvitationsResponse.parse(
      (await alice.req('GET', `/api/boards/${board}/invitations`)).json(),
    )
    expect(listed.invitations.find((i) => i.id === link.id)).toMatchObject({
      kind: 'review',
      createdBy: { id: bob.userId, name: 'bob' },
    })
    expect(await removeAudit()).toMatchObject({
      userId: bob.userId,
      invitationsRevoked: 0,
      linksKept: 1,
      linkIdsKept: [link.id],
    })
    // and the link still lets people in
    expect((await erin.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)).statusCode).toBe(200)
  })

  it('a removal that is refused revokes and denies nothing (the checks come first)', async () => {
    const board = await createBoard(alice, DEV_STUDIO, 'Alice’s')
    const sent = await boardInvite(alice, board, 'viewer', erin)
    const res = await remove(alice, alice.userId) // the last owner
    expect(res.statusCode).toBe(409)
    expect(codeOf(res)).toBe('LAST_OWNER')
    expect(await revokedAt(sent.id)).toBeNull()
    expect(
      (
        await api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_events WHERE action = 'invitation.revoke'",
        )
      ).n,
    ).toBe(0)
  })
})

describe('access requests the leaver made', () => {
  const ask = async (c: Client, bid: string) => {
    const res = await c.req('POST', `/api/boards/${bid}/access-requests`, { role: 'editor' })
    expect(res.statusCode, res.body).toBe(202)
    return (
      await api.db.one<{ id: string }>(
        "SELECT id FROM access_requests WHERE board_id = $1 AND user_id = $2 AND status = 'pending'",
        [bid, c.userId],
      )
    ).id
  }
  const statusOf = async (id: string) =>
    api.db.one<{
      status: string
      decided_by: string | null
      decided_at: Date | null
      role_granted: string | null
    }>('SELECT status, decided_by, decided_at, role_granted FROM access_requests WHERE id = $1', [id])

  it('pending ones are denied, so approving one later grants nothing; other people’s and other workspaces’ stay pending', async () => {
    const secret = await createBoard(alice, DEV_STUDIO, 'Private')
    const alone = await createBoard(alice, alice.personalWorkspaceId, 'Alice alone') // another workspace
    const bobs = await ask(bob, secret)
    const bobsElsewhere = await ask(bob, alone)
    const carols = await ask(carol, secret)

    expect((await remove(alice, bob.userId)).statusCode).toBe(200)

    const denied = await statusOf(bobs)
    expect(denied).toMatchObject({ status: 'denied', decided_by: alice.userId, role_granted: null })
    expect(denied.decided_at).not.toBeNull()
    expect((await statusOf(bobsElsewhere)).status).toBe('pending')
    expect((await statusOf(carols)).status).toBe('pending')
    expect(await removeAudit()).toMatchObject({ userId: bob.userId, accessRequestsDenied: 1 })

    // Before this was ended, an owner approving bob's request would have given a removed person a fresh
    // guest membership and the board grant.
    const approve = await alice.req('POST', `/api/access-requests/${bobs}/approve`, {})
    expect(approve.statusCode).toBe(409)
    expect(codeOf(approve)).toBe('ALREADY_DECIDED')
    expect((await bob.req('GET', `/api/boards/${secret}`)).statusCode).toBe(404)
    expect((await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/members`)).statusCode).toBe(404)
    const stillThere = await api.db.maybeOne(
      'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [DEV_STUDIO, bob.userId],
    )
    expect(stillThere).toBeNull()
    // carol's request is still answerable
    expect((await alice.req('POST', `/api/access-requests/${carols}/approve`, {})).statusCode).toBe(200)
  })

  it('a request answered before the removal stays answered; its grant goes with the rest of theirs', async () => {
    const board = await createBoard(alice, DEV_STUDIO, 'Private')
    const id = await ask(bob, board)
    expect((await alice.req('POST', `/api/access-requests/${id}/approve`, {})).statusCode).toBe(200)
    expect((await bob.req('GET', `/api/boards/${board}`)).json()).toMatchObject({ role: 'editor' })

    expect((await remove(alice, bob.userId)).statusCode).toBe(200)
    expect(await statusOf(id)).toMatchObject({
      status: 'approved',
      decided_by: alice.userId,
      role_granted: 'editor',
    })
    expect((await bob.req('GET', `/api/boards/${board}`)).statusCode).toBe(404)
    expect(await removeAudit()).toMatchObject({ boardGrantsRemoved: 1, accessRequestsDenied: 0 })
  })
})

describe('changing a role asks the identity provider only about a member', () => {
  it('a manager naming someone who is no member (or a guest account, or a change that is refused) makes no call; a raise to admin does', async () => {
    const refresh = vi.spyOn(api.identity, 'refreshTarget')
    const guest = await api.db.one<{ id: string }>(
      `INSERT INTO users (id, name, color, kind, guest_name, created_at)
       VALUES ('usr_Guest0000000000000001', 'Visitor (guest)', '#123456', 'guest', 'Visitor', now()) RETURNING id`,
    )
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())`,
      [DEV_STUDIO, guest.id],
    )
    // no member of Dev Studio: erin is an existing account of ours, so the provider could be asked about her
    expect((await patch(alice, erin.userId, 'admin')).statusCode).toBe(404)
    expect((await patch(alice, 'usr_Nobody0000000000000000', 'owner')).statusCode).toBe(404)
    // a name-only guest account is not managed here
    expect((await patch(alice, guest.id, 'admin')).statusCode).toBe(404)
    // refused anyway: an admin cannot make an owner, nor touch one
    await setRole(bob.userId, 'admin')
    expect((await patch(bob, carol.userId, 'owner')).statusCode).toBe(403)
    expect((await patch(bob, alice.userId, 'admin')).statusCode).toBe(403)
    // not a raise: a demotion, and the same role again
    expect((await patch(alice, bob.userId, 'member')).statusCode).toBe(200)
    expect((await patch(alice, bob.userId, 'member')).statusCode).toBe(200)
    expect(refresh).not.toHaveBeenCalled()

    // a raise to admin, by a creator, of a member: the target's addresses are confirmed first
    expect((await patch(alice, bob.userId, 'admin')).statusCode).toBe(200)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(bob.userId)
  })

  it('a caller who is no creator never makes Lobby call the provider', async () => {
    const refresh = vi.spyOn(api.identity, 'refreshTarget')
    const pat = await api.login('pat', 'pat', { email: 'pat@client.example.test' })
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'admin', now())`,
      [DEV_STUDIO, pat.userId],
    )
    const res = await patch(pat, carol.userId, 'admin')
    expect(res.statusCode).toBe(403)
    expect(codeOf(res)).toBe('CREATOR_REQUIRED')
    expect(refresh).not.toHaveBeenCalled()
    expect(
      ListWorkspaceMembersResponse.parse(
        (await alice.req('GET', `/api/workspaces/${DEV_STUDIO}/members`)).json(),
      ).members.find((m) => m.user.id === carol.userId)?.role,
    ).toBe('member')
  })
})
