import {
  BoardDetail,
  InvitationAccepted,
  InvitationCreated,
  InvitationGoneBody,
  InvitationPreview,
  Me,
  ReviewLinkCreated,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256hex } from '../src/auth/session.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  devEmail,
  ORIGIN,
  type TestApi,
} from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner
let bob: Client // Dev Studio member
let erin: Client // outsider: only her own workspace (removed from Dev Studio below)

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
})
afterEach(() => api.close())

const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
const DAY = 24 * 60 * 60 * 1000

/** A single-use board link, locked (domain access) to `email`: erin's by default (she accepts most). */
async function boardInvite(c: Client, boardId: string, role = 'editor', email = devEmail('erin')) {
  const res = await c.req('POST', `/api/boards/${boardId}/invitations`, { role, email })
  expect(res.statusCode, res.body).toBe(201)
  return InvitationCreated.parse(res.json())
}

describe('board invitations', () => {
  it('link shows once, previews publicly, and accepting makes an outsider a guest with that board role', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO, 'Launch')
    const inv = await boardInvite(bob, boardId, 'editor')
    expect(inv.url.startsWith(`${ORIGIN}/invite/`)).toBe(true)
    const token = tokenOf(inv.url)
    expect(new Date(inv.expiresAt).getTime() - Date.now()).toBeGreaterThan(7 * DAY - 60_000)
    // Only the hash is stored.
    const row = await api.db.one<{ token_hash: string }>('SELECT token_hash FROM invitations WHERE id = $1', [
      inv.id,
    ])
    expect(row.token_hash).toBe(sha256hex(token))

    const preview = await api.anon('GET', `/api/invitations/${token}`)
    expect(preview.statusCode).toBe(200)
    expect(InvitationPreview.parse(preview.json())).toMatchObject({
      workspace: { id: DEV_STUDIO, name: 'Dev Studio' },
      board: { id: boardId, title: 'Launch' },
      role: 'editor',
      invitedBy: { name: 'bob' },
    })

    expect((await api.anon('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(401)
    const accepted = await erin.req('POST', `/api/invitations/${token}/accept`)
    expect(accepted.statusCode).toBe(200)
    expect(InvitationAccepted.parse(accepted.json())).toEqual({ workspaceId: DEV_STUDIO, boardId })
    expect(api.notifications).toContainEqual({ boardId, userId: erin.userId })

    const me = Me.parse((await erin.req('GET', '/api/me')).json())
    expect(me.workspaces.find((w) => w.id === DEV_STUDIO)?.role).toBe('guest')
    expect(BoardDetail.parse((await erin.req('GET', `/api/boards/${boardId}`)).json()).role).toBe('editor')
    const events = await api.db.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'invitation.%' ORDER BY id",
    )
    expect(events.rows.map((e) => e.action)).toEqual(['invitation.create', 'invitation.accept'])
  })

  it('a guest sees only the boards granted to them, even workspace-visible ones', async () => {
    const granted = await createBoard(bob, DEV_STUDIO, 'Granted')
    const open = await createBoard(bob, DEV_STUDIO, 'Open to members')
    await bob.req('PATCH', `/api/boards/${open}`, { visibility: 'workspace_edit' })
    const inv = await boardInvite(bob, granted, 'viewer')
    await erin.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`)
    const list = (await erin.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)).json().boards
    expect(list.map((b: { id: string; role: string }) => [b.id, b.role])).toEqual([[granted, 'viewer']])
    expect((await erin.req('GET', `/api/boards/${open}`)).statusCode).toBe(404)
    expect((await erin.req('POST', `/api/boards/${open}/ticket`)).statusCode).toBe(404)
    expect((await erin.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'x' })).statusCode).toBe(
      403,
    )
  })

  it('accepting twice is idempotent for the same user; anyone else gets 410', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO)
    const token = tokenOf((await boardInvite(bob, boardId, 'commenter')).url)
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    api.notifications.length = 0
    const again = await erin.req('POST', `/api/invitations/${token}/accept`)
    expect(again.statusCode).toBe(200)
    expect(InvitationAccepted.parse(again.json()).boardId).toBe(boardId)
    expect(api.notifications).toEqual([])
    expect(
      (await api.anon('GET', `/api/invitations/${token}`, undefined, { cookie: erin.cookie })).statusCode,
    ).toBe(200)
    const other = await api.login('frank')
    const res = await other.req('POST', `/api/invitations/${token}/accept`)
    expect(res.statusCode).toBe(410)
    expect(res.json().error.code).toBe('GONE')
    expect((await api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(410)
    expect((await other.req('GET', `/api/boards/${boardId}`)).statusCode).toBe(404)
  })

  it('expired links are 410 for preview and accept', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO)
    const token = tokenOf((await boardInvite(bob, boardId)).url)
    api.clock.advance(7 * DAY + 1000)
    expect((await api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(410)
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(410)
    expect((await erin.req('GET', `/api/boards/${boardId}`)).statusCode).toBe(404)
  })

  it('revoked links are 410; revoke is for the creator or a manager, invisible (404) to others', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO)
    const inv = await boardInvite(bob, boardId)
    expect((await erin.req('DELETE', `/api/invitations/${inv.id}`)).statusCode).toBe(404)
    const carol = await api.login('carol') // Dev Studio member without access to the board
    expect((await carol.req('DELETE', `/api/invitations/${inv.id}`)).statusCode).toBe(404)
    expect((await bob.req('DELETE', `/api/invitations/${inv.id}`)).statusCode).toBe(204)
    expect((await bob.req('DELETE', `/api/invitations/${inv.id}`)).statusCode).toBe(204) // idempotent
    const token = tokenOf(inv.url)
    expect((await api.anon('GET', `/api/invitations/${token}`)).statusCode).toBe(410)
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(410)
    // A board manager who did not create the link may revoke it too.
    const second = await boardInvite(bob, boardId)
    expect((await alice.req('DELETE', `/api/invitations/${second.id}`)).statusCode).toBe(204)
    const revokes = await api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'invitation.revoke'",
    )
    expect(revokes.n).toBe(2)
  })

  it('never downgrades an existing grant or membership', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO)
    const carol = await api.login('carol')
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'editor' })
    const token = tokenOf((await boardInvite(bob, boardId, 'viewer', devEmail('carol'))).url)
    expect((await carol.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect(BoardDetail.parse((await carol.req('GET', `/api/boards/${boardId}`)).json()).role).toBe('editor')
    const me = Me.parse((await carol.req('GET', '/api/me')).json())
    expect(me.workspaces.find((w) => w.id === DEV_STUDIO)?.role).toBe('member') // not demoted to guest
  })

  it('only board managers can create board links; owner links are refused', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO)
    const email = devEmail('erin')
    expect(
      (await bob.req('POST', `/api/boards/${boardId}/invitations`, { role: 'owner', email })).statusCode,
    ).toBe(400)
    const carol = await api.login('carol')
    expect(
      (await carol.req('POST', `/api/boards/${boardId}/invitations`, { role: 'viewer', email })).statusCode,
    ).toBe(404)
    expect(
      (await api.anon('POST', `/api/boards/${boardId}/invitations`, { role: 'viewer', email })).statusCode,
    ).toBe(401)
  })

  it('unknown or malformed tokens are 404', async () => {
    expect((await api.anon('GET', `/api/invitations/${'A'.repeat(43)}`)).statusCode).toBe(404)
    expect((await api.anon('GET', '/api/invitations/short')).statusCode).toBe(404)
    expect((await erin.req('POST', `/api/invitations/${'A'.repeat(43)}/accept`)).statusCode).toBe(404)
  })
})

describe('workspace invitations', () => {
  it('admins+ invite with a workspace role; accepting joins the workspace; members cannot invite', async () => {
    const email = devEmail('erin')
    expect(
      (await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role: 'member', email }))
        .statusCode,
    ).toBe(403)
    const res = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email,
    })
    expect(res.statusCode).toBe(201)
    const inv = InvitationCreated.parse(res.json())
    const preview = InvitationPreview.parse(
      (await api.anon('GET', `/api/invitations/${tokenOf(inv.url)}`)).json(),
    )
    expect(preview).toMatchObject({ board: null, role: 'member', workspace: { id: DEV_STUDIO } })
    const accepted = await erin.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`)
    expect(InvitationAccepted.parse(accepted.json())).toEqual({ workspaceId: DEV_STUDIO, boardId: null })
    const me = Me.parse((await erin.req('GET', '/api/me')).json())
    expect(me.workspaces.find((w) => w.id === DEV_STUDIO)?.role).toBe('member')
    expect(
      (await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role: 'owner', email }))
        .statusCode,
    ).toBe(400)
  })

  it('a guest link does not demote the workspace owner who accepts it', async () => {
    // Fixer round 3 (domain access §21): nobody locks an invitation to their own address, so another
    // manager (bob, made admin) sends alice the guest invitation.
    await api.db.query(
      "UPDATE workspace_members SET role = 'admin' WHERE user_id = $1 AND workspace_id = $2",
      [bob.userId, DEV_STUDIO],
    )
    const inv = InvitationCreated.parse(
      (
        await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
          role: 'guest',
          email: devEmail('alice'),
        })
      ).json(),
    )
    expect((await alice.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`)).statusCode).toBe(200)
    const me = Me.parse((await alice.req('GET', '/api/me')).json())
    expect(me.workspaces.find((w) => w.id === DEV_STUDIO)?.role).toBe('owner')
  })
})

describe('a link that is no longer valid (PRI-04)', () => {
  const gone = (res: { statusCode: number; json(): unknown }) => {
    expect(res.statusCode).toBe(410)
    return InvitationGoneBody.parse(res.json())
  }
  const preview = (c: Client | null, token: string) =>
    c ? c.req('GET', `/api/invitations/${token}`) : api.anon('GET', `/api/invitations/${token}`)

  it('answers 410 naming the inviter; the board id only to a signed-in caller who can open the board now', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO, 'Rough cut')
    const inv = await boardInvite(bob, boardId, 'commenter')
    const token = tokenOf(inv.url)
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    // Used up (single-use) — and then revoked, too.
    expect((await bob.req('DELETE', `/api/invitations/${inv.id}`)).statusCode).toBe(204)

    const carol = await api.login('carol') // Dev Studio member, no access to this private board
    for (const [who, c] of [
      ['anonymous', null],
      ['a member without access', carol],
    ] as const) {
      const body = gone(await preview(c, token))
      expect(body.gone, who).toEqual({ invitedBy: { name: 'bob' }, boardId: null })
      expect(body.error.code).toBe('GONE')
    }
    // bob (the owner) can open the board: he is sent there, from the preview and the accept route.
    // (erin, who redeemed it, still gets her own preview: accepting again is a no-op for her.)
    expect(gone(await preview(bob, token)).gone).toEqual({ invitedBy: { name: 'bob' }, boardId })
    expect(gone(await bob.req('POST', `/api/invitations/${token}/accept`)).gone.boardId).toBe(boardId)
    expect((await preview(erin, token)).statusCode).toBe(200)
    expect(gone(await carol.req('POST', `/api/invitations/${token}/accept`)).gone.boardId).toBeNull()
    expect(
      await api.db.one('SELECT count(*)::int AS n FROM board_members WHERE user_id = $1', [carol.userId]),
    ).toEqual({ n: 0 })

    // A trashed board is not "can open now" either.
    const second = await boardInvite(bob, boardId, 'viewer')
    await bob.req('DELETE', `/api/invitations/${second.id}`)
    expect(gone(await preview(bob, tokenOf(second.url))).gone.boardId).toBe(boardId)
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect(gone(await preview(bob, tokenOf(second.url))).gone.boardId).toBeNull()
  })

  it('an expired review link sends someone who kept access to the board (revoked without removal)', async () => {
    const boardId = await createBoard(bob, DEV_STUDIO, 'Client review')
    const res = await bob.req('POST', `/api/boards/${boardId}/review-links`, { role: 'commenter' })
    const link = ReviewLinkCreated.parse(res.json())
    const token = tokenOf(link.url)
    expect((await erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    await bob.req('POST', `/api/boards/${boardId}/review-links/${link.id}/revoke`, { removeAccess: false })
    expect(gone(await preview(erin, token)).gone).toEqual({ invitedBy: { name: 'bob' }, boardId })
    expect(gone(await erin.req('POST', `/api/invitations/${token}/accept`)).gone.boardId).toBe(boardId)
    const vic = await api.login('vic')
    expect(gone(await preview(vic, token)).gone.boardId).toBeNull()
  })
})
