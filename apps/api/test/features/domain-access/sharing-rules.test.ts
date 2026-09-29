// Sharing rules for people who are not creators (docs/DOMAIN-ACCESS-CONTRACTS.md D4, D5, §6.3;
// §11.1 sharing-rules.test.ts): they may lower, remove, revoke and deny, never hand out access; and
// nobody makes a non-creator a board owner.

import { ListInvitationsResponse, ListShareMembersResponse } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from '../history/helpers.ts'
import { type ClerkWorld, clerkError, clerkUser, clerkWorld, fakeClerk, notFound } from './clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)

const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code

async function grantDirect(api: TestApi, boardId: string, userId: string, role: string, by: string) {
  await api.db.query(
    `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [boardId, userId, role, by],
  )
}
const directRole = async (api: TestApi, boardId: string, userId: string) =>
  (
    await api.db.maybeOne<{ role: string }>(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [boardId, userId],
    )
  )?.role ?? null

describe('non-creators and role limits (dev provider)', () => {
  let api: TestApi
  let sync: FakeSync
  let alice: Client // Dev Studio owner, creator
  let bob: Client // creator member
  let carol: Client // creator member
  let pat: Client // pre-existing outsider owner of `board` (decision 4)
  let sam: Client // outsider workspace member
  let board: string

  beforeEach(async () => {
    sync = createFakeSync()
    api = await createTestApi({ deps: { syncInternal: sync } })
    alice = await api.login('alice')
    bob = await api.login('bob')
    carol = await api.login('carol')
    pat = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
    sam = await api.login('sam', 'Sam', { email: 'sam@client.example.test' })
    await api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now()), ($1, $3, 'member', now())`,
      [DEV_STUDIO, pat.userId, sam.userId],
    )
    board = await createBoard(alice, DEV_STUDIO, 'Shared')
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'x')])
    await grantDirect(api, board, pat.userId, 'owner', alice.userId)
  })
  afterEach(() => api.close())

  const put = (c: Client, who: Client, role: string) =>
    c.req('PUT', `/api/boards/${board}/members/${who.userId}`, { role })

  it('a non-creator may lower a grant (a creator’s included) or keep it; raising or adding one is 403', async () => {
    await grantDirect(api, board, bob.userId, 'owner', alice.userId)
    await grantDirect(api, board, carol.userId, 'editor', alice.userId)
    expect((await put(pat, bob, 'editor')).statusCode).toBe(200) // a creator's owner grant, lowered
    expect(await directRole(api, board, bob.userId)).toBe('editor')
    expect((await put(pat, carol, 'viewer')).statusCode).toBe(200)
    expect((await put(pat, carol, 'viewer')).statusCode).toBe(200) // unchanged: a no-op
    const raise = await put(pat, carol, 'commenter')
    expect(raise.statusCode).toBe(403)
    expect(code(raise)).toBe('CREATOR_REQUIRED')
    const add = await put(pat, sam, 'viewer')
    expect(add.statusCode).toBe(403)
    expect(code(add)).toBe('CREATOR_REQUIRED')
    expect(await directRole(api, board, sam.userId)).toBeNull()
    // Removing stays open, a creator's grant included (the last-owner rule is unchanged).
    expect((await pat.req('DELETE', `/api/boards/${board}/members/${bob.userId}`)).statusCode).toBe(200)
  })

  it('owner for a non-creator target is 409, even from a creator; a creator target is fine', async () => {
    const res = await put(alice, sam, 'owner')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toEqual({
      code: 'ROLE_REQUIRES_CREATOR',
      message:
        'Only people at Dark Burn Creative or Trailer Park Group can own boards or be workspace admins in Lobby. Choose a different role for this person.',
    })
    expect(await directRole(api, board, sam.userId)).toBeNull()
    expect((await put(alice, bob, 'owner')).statusCode).toBe(200)
    // A pre-existing outsider owner keeps the role; putting it again is a no-op.
    expect((await put(alice, pat, 'owner')).statusCode).toBe(200)
    expect(await directRole(api, board, pat.userId)).toBe('owner')
  })

  it('transfer: to an outsider 409, to a creator 200; a non-creator owner may not transfer (403)', async () => {
    const toOutsider = await alice.req('POST', `/api/boards/${board}/transfer-ownership`, {
      userId: sam.userId,
    })
    expect(toOutsider.statusCode).toBe(409)
    expect(code(toOutsider)).toBe('ROLE_REQUIRES_CREATOR')
    const byOutsider = await pat.req('POST', `/api/boards/${board}/transfer-ownership`, {
      userId: carol.userId,
    })
    expect(byOutsider.statusCode).toBe(403)
    expect(code(byOutsider)).toBe('CREATOR_REQUIRED')
    expect(await directRole(api, board, carol.userId)).toBeNull()
    const ok = await alice.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: bob.userId })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await directRole(api, board, bob.userId)).toBe('owner')
  })

  it('visibility: a non-creator may lower it, never raise it', async () => {
    expect(
      (await alice.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_edit' })).statusCode,
    ).toBe(200)
    expect(
      (await pat.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    expect((await pat.req('PATCH', `/api/boards/${board}`, { visibility: 'private' })).statusCode).toBe(200)
    expect((await pat.req('PATCH', `/api/boards/${board}`, { visibility: 'private' })).statusCode).toBe(200)
    const raise = await pat.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_view' })
    expect(raise.statusCode).toBe(403)
    expect(code(raise)).toBe('CREATOR_REQUIRED')
    // Renaming is not access: still the owner's.
    expect((await pat.req('PATCH', `/api/boards/${board}`, { title: 'Renamed' })).statusCode).toBe(200)
    expect(
      (await alice.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_edit' })).statusCode,
    ).toBe(200)
  })

  it('links and requests: revoke 204 and remove 200; extend 403; approve 403; deny 200', async () => {
    const single = (
      await alice.req('POST', `/api/boards/${board}/invitations`, { role: 'viewer', email: devEmail('zed') })
    ).json() as { id: string }
    const review = (
      await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' })
    ).json() as {
      id: string
    }
    const other = (
      await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'commenter' })
    ).json() as {
      id: string
    }
    expect((await pat.req('DELETE', `/api/invitations/${single.id}`)).statusCode).toBe(204)
    expect(
      (await pat.req('POST', `/api/boards/${board}/review-links/${review.id}/revoke`, {})).statusCode,
    ).toBe(200)
    const extend = await pat.req('POST', `/api/boards/${board}/review-links/${other.id}/extend`, { hours: 1 })
    expect(extend.statusCode).toBe(403)
    expect(code(extend)).toBe('CREATOR_REQUIRED')
    for (const who of [bob, carol])
      expect(
        (await who.req('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).statusCode,
      ).toBe(202)
    const ids = (await api.db.query<{ id: string }>('SELECT id FROM access_requests ORDER BY created_at, id'))
      .rows
    const approve = await pat.req('POST', `/api/access-requests/${ids[0]?.id}/approve`, {})
    expect(approve.statusCode).toBe(403)
    expect(code(approve)).toBe('CREATOR_REQUIRED')
    expect((await pat.req('POST', `/api/access-requests/${ids[1]?.id}/deny`, {})).statusCode).toBe(200)
    // A creator approves.
    expect((await alice.req('POST', `/api/access-requests/${ids[0]?.id}/approve`, {})).statusCode).toBe(200)
  })

  it('the pending list: a non-creator manager never gets a multi-use URL; a creator does; both see the invited address', async () => {
    await alice.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer' })
    await alice.req('POST', `/api/boards/${board}/invitations`, {
      role: 'viewer',
      email: 'Zed@Client.Example.Test',
    })
    const asPat = ListInvitationsResponse.parse(
      (await pat.req('GET', `/api/boards/${board}/invitations`)).json(),
    )
    const asAlice = ListInvitationsResponse.parse(
      (await alice.req('GET', `/api/boards/${board}/invitations`)).json(),
    )
    expect(asPat.invitations.map((i) => [i.kind, i.url, i.email])).toEqual([
      ['review', null, null],
      ['invite', null, 'zed@client.example.test'],
    ])
    expect(asAlice.invitations.map((i) => [i.kind, typeof i.url, i.email])).toEqual([
      ['review', 'string', null],
      ['invite', 'object', 'zed@client.example.test'],
    ])
  })

  it('duplicate with "keep sharing": a non-creator owner becomes an editor on the copy; creators keep their roles', async () => {
    await grantDirect(api, board, bob.userId, 'owner', alice.userId)
    await grantDirect(api, board, carol.userId, 'commenter', alice.userId)
    await grantDirect(api, board, sam.userId, 'viewer', alice.userId)
    const res = await alice.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    const copy = res.json().board.id as string
    const members = await api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1',
      [copy],
    )
    const roles = Object.fromEntries(members.rows.map((m) => [m.user_id, m.role]))
    expect(roles).toEqual({
      [alice.userId]: 'owner',
      [bob.userId]: 'owner',
      [carol.userId]: 'commenter',
      [pat.userId]: 'editor',
      [sam.userId]: 'viewer',
    })
  })

  it('ShareMember.canOwn: false for a confirmed outsider, true for creators and for never-checked members', async () => {
    await grantDirect(api, board, sam.userId, 'viewer', alice.userId)
    await grantDirect(api, board, carol.userId, 'viewer', alice.userId)
    await api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [carol.userId])
    const list = ListShareMembersResponse.parse(
      (await alice.req('GET', `/api/boards/${board}/sharing/members`)).json(),
    ).members
    const canOwn = Object.fromEntries(list.map((m) => [m.user.id, m.canOwn]))
    expect(canOwn[alice.userId]).toBe(true)
    expect(canOwn[pat.userId]).toBe(false)
    expect(canOwn[sam.userId]).toBe(false)
    expect(canOwn[carol.userId]).toBe(true)
  })
})

describe('target refreshes (Clerk)', () => {
  let w: ClerkWorld
  let alice: Client
  let board: string
  beforeEach(async () => {
    fakeClerk.reset()
    w = await clerkWorld()
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
    alice = await w.signIn('user_alice')
    board = await createBoard(alice, alice.personalWorkspaceId, 'Owned')
  })
  afterEach(() => w.api.close())

  /** A member of alice's workspace whose stored identity was never checked (from before 0021). */
  async function neverChecked(sub: string, emails: string[]) {
    clerkUser(sub, emails)
    const c = await w.signIn(sub)
    await w.api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())`,
      [alice.personalWorkspaceId, c.userId],
    )
    await w.api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [c.userId])
    await w.api.db.query('DELETE FROM user_emails WHERE user_id = $1', [c.userId])
    fakeClerk.calls = []
    return c
  }
  const live = async (userId: string) =>
    (
      await w.api.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      )
    ).n

  it('PUT owner for a never-checked target refreshes it once, then decides on the fresh data', async () => {
    const t = await neverChecked('user_t', ['lobby-test-t@darkburn.com'])
    const res = await alice.req('PUT', `/api/boards/${board}/members/${t.userId}`, { role: 'owner' })
    expect(res.statusCode, res.body).toBe(200)
    expect(fakeClerk.calls).toEqual(['user_t'])
  })

  it('transfer to a never-checked creator refreshes the target, then transfers', async () => {
    const t = await neverChecked('user_t', ['lobby-test-t@darkburn.com'])
    const res = await alice.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: t.userId })
    expect(res.statusCode, res.body).toBe(200)
    expect(fakeClerk.calls).toEqual(['user_t'])
  })

  it.each([
    ['fails', () => clerkError(503, 'service_unavailable')],
    ['answers 404 resource_not_found', notFound],
  ])(
    'a target refresh that %s neither revokes the target nor signs the caller out: 409 from stored data',
    async (_what, failure) => {
      const t = await neverChecked('user_t', ['lobby-test-t@darkburn.com'])
      fakeClerk.failures.set('user_t', failure)
      const res = await alice.req('PUT', `/api/boards/${board}/members/${t.userId}`, { role: 'owner' })
      expect(res.statusCode).toBe(409)
      expect(code(res)).toBe('ROLE_REQUIRES_CREATOR')
      expect(fakeClerk.calls).toEqual(['user_t'])
      expect(await live(t.userId)).toBe(1)
      expect(await live(alice.userId)).toBe(1)
      expect((await alice.req('GET', '/api/me')).statusCode).toBe(200)
    },
  )
})
