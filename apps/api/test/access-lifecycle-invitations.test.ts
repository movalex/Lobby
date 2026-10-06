// J2 item 2 (INV-3): removing someone from the workspace, or from a board, revokes the unused single-use
// invitations addressed to them (board and workspace invitations), in the removal's transaction.

import { InvitationCreated } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { accept, del, removeFromWorkspace, roleOn, useWorld, w } from './access-lifecycle-support.ts'
import { type Client, createBoard, DEV_STUDIO, devEmail } from './helpers.ts'

useWorld()

async function invite(c: Client, path: string, body: Record<string, unknown>) {
  const res = await c.req('POST', path, body)
  expect(res.statusCode, res.body).toBe(201)
  return InvitationCreated.parse(res.json())
}
const boardInvite = (c: Client, boardId: string, role: string, to: Client) =>
  invite(c, `/api/boards/${boardId}/invitations`, { role, email: devEmail(to.me.user.name) })
const revokedAt = async (id: string) =>
  (await w.api.db.one<{ revoked_at: Date | null }>('SELECT revoked_at FROM invitations WHERE id = $1', [id]))
    .revoked_at
const revokeAudits = async () =>
  (
    await w.api.db.query<{ actor_id: string; target: string; detail: Record<string, unknown> }>(
      "SELECT actor_id, target, detail FROM audit_events WHERE action = 'invitation.revoke' ORDER BY id",
    )
  ).rows
const membership = async (userId: string) =>
  (
    await w.api.db.maybeOne<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [DEV_STUDIO, userId],
    )
  )?.role ?? null

describe('J2 item 2 (INV-3): a removal revokes the unused invitations addressed to the person removed', () => {
  it('from the workspace: their board AND workspace invitations here are revoked; used ones, other people’s and other workspaces’ stand', async () => {
    const { alice, bob, erin, frank } = w
    const board2 = await createBoard(bob, DEV_STUDIO, 'Board two')
    const elsewhere = await createBoard(bob, bob.personalWorkspaceId, 'Bob alone')
    const first = await boardInvite(bob, w.board, 'viewer', erin)
    const second = await boardInvite(bob, board2, 'editor', erin)
    const toWorkspace = await invite(alice, `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: devEmail('erin'),
    })
    const outside = await boardInvite(bob, elsewhere, 'viewer', erin)
    const franks = await boardInvite(bob, board2, 'viewer', frank)
    expect((await accept(erin, first.url)).statusCode).toBe(200) // erin is in (a workspace guest)
    expect(await membership(erin.userId)).toBe('guest')

    const res = await removeFromWorkspace(alice, erin.userId)
    expect(res.statusCode, res.body).toBe(200)
    expect(await revokedAt(second.id)).not.toBeNull()
    expect(await revokedAt(toWorkspace.id)).not.toBeNull()
    for (const keep of [first, outside, franks]) expect(await revokedAt(keep.id)).toBeNull()

    // before the fix both answered 200: erin was an editor on board 2 again, or a member of Dev Studio
    expect((await accept(erin, second.url)).statusCode).toBe(410)
    expect((await accept(erin, toWorkspace.url)).statusCode).toBe(410)
    expect(await membership(erin.userId)).toBeNull()
    expect(await roleOn(erin, board2)).toBeNull()
    // what is not this workspace's, or not addressed to erin, still works
    expect((await accept(erin, outside.url)).statusCode).toBe(200)
    expect((await accept(frank, franks.url)).statusCode).toBe(200)

    // audited like any revoke, by the remover, marked as addressed to the person removed; counted
    const audits = await revokeAudits()
    expect(audits.map((a) => [a.actor_id, a.target]).sort()).toEqual(
      [second.id, toWorkspace.id].map((id) => [alice.userId, id]).sort(),
    )
    for (const a of audits)
      expect(a.detail).toMatchObject({ via: 'member_removed', userId: erin.userId, invitee: true })
    const removal = await w.api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
    expect(removal.detail).toMatchObject({
      userId: erin.userId,
      invitationsRevoked: 0,
      invitationsToThemRevoked: 2,
    })
  })

  it('from a board: their other unused invitations to THAT board are revoked; those to other boards stand', async () => {
    const { bob, erin } = w
    const board2 = await createBoard(bob, DEV_STUDIO, 'Board two')
    const used = await boardInvite(bob, w.board, 'viewer', erin)
    const pending = await boardInvite(bob, w.board, 'editor', erin)
    const toBoard2 = await boardInvite(bob, board2, 'commenter', erin)
    expect((await accept(erin, used.url)).statusCode).toBe(200)

    const res = await del(bob, erin.userId)
    expect(res.statusCode, res.body).toBe(200)
    expect(await revokedAt(pending.id)).not.toBeNull()
    expect(await revokedAt(toBoard2.id)).toBeNull()
    // before the fix: 200, and erin was an editor of the board she was just removed from
    expect((await accept(erin, pending.url)).statusCode).toBe(410)
    expect(await roleOn(erin)).toBeNull()
    expect((await accept(erin, toBoard2.url)).statusCode).toBe(200)

    const audits = await revokeAudits()
    expect(audits).toEqual([
      {
        actor_id: bob.userId,
        target: pending.id,
        detail: { boardId: w.board, via: 'member_removed', userId: erin.userId, invitee: true },
      },
    ])
    const removal = await w.api.db.one<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_events WHERE action = 'board.member.remove' ORDER BY id DESC LIMIT 1",
    )
    expect(removal.detail).toEqual({
      userId: erin.userId,
      previousRole: 'viewer',
      invitationsToThemRevoked: 1,
    })
  })

  it('a refused board removal (the person is no member: 404) revokes nothing', async () => {
    const { bob, frank } = w
    const pending = await boardInvite(bob, w.board, 'editor', frank)
    expect((await del(bob, frank.userId)).statusCode).toBe(404)
    expect(await revokedAt(pending.id)).toBeNull()
    expect((await accept(frank, pending.url)).statusCode).toBe(200)
  })
})
