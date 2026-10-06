// Wave J ("Internal only", migration 0025): a workspace or a project can be switched to internal only
// (owners and admins; default off). While it is on, the server refuses everything that hands access out
// to people outside Dark Burn / TPG there: invitations to an outside address (board, workspace, the
// email route's links and its "granted" path), approving an outside account's request, a new or higher
// grant (or workspace role) for an outside account, and review, workshop and guest links (created,
// extended, or opened to guests): 409 INTERNAL_ONLY. Accepting an invitation or a link there, one from
// before the switch included, is refused the same way for anyone who is not a confirmed creator (a
// name-only guest joining a guest link too); nothing is redeemed. Creators are unaffected. Turning it on
// removes nothing: the remaining outside access (pending outside invitations included) is listed for
// the owners, only while a switch is on. Turning it off needs a creator.

import {
  INTERNAL_ONLY_CODE,
  INTERNAL_ONLY_MESSAGES,
  InternalOnlySettings,
  InvitationCreated,
  ReviewLinkCreated,
} from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertHookRoutes } from '../../../src/features/dashboard/outside.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { freshIp, joinRequest, tokenOf } from '../guests/support.ts'

const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code
const message = (res: LightMyRequestResponse) =>
  (res.json() as { error?: { message?: string } }).error?.message

let api: TestApi
let alice: Client // Dev Studio owner (creator)
let bob: Client // creator member, board owner
let carol: Client // creator member
let pat: Client // outside account, Dev Studio guest with a viewer grant on `board`
let quinn: Client // outside account, not in the workspace (asks for access)
let board: string

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
  quinn = await api.login('quinn', 'Quinn', { email: 'quinn@client.example.test' })
  await api.db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())",
    [DEV_STUDIO, pat.userId],
  )
  board = await createBoard(bob, DEV_STUDIO, 'Internal plan')
  expect(
    (await bob.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'viewer' })).statusCode,
  ).toBe(200)
})
afterEach(() => api.close())

const setWorkspace = (c: Client, on: boolean) =>
  c.req('PUT', `/api/workspaces/${DEV_STUDIO}/internal-only`, { internalOnly: on })
const settings = async (c: Client) => {
  const res = await c.req('GET', `/api/workspaces/${DEV_STUDIO}/internal-only`)
  expect(res.statusCode, res.body).toBe(200)
  return InternalOnlySettings.parse(res.json())
}
const refused = (res: LightMyRequestResponse, scope: 'workspace' | 'project' = 'workspace') => {
  expect(res.statusCode, res.body).toBe(409)
  expect(code(res)).toBe(INTERNAL_ONLY_CODE)
  expect(message(res)).toBe(INTERNAL_ONLY_MESSAGES[scope])
}
const reviewLink = (c: Client, body: object = { role: 'commenter' }) =>
  c.req('POST', `/api/boards/${board}/review-links`, body)

describe('the switch', () => {
  it('is off by default; owners and admins turn it on; members read it; turning off needs a creator', async () => {
    const before = await settings(alice)
    expect(before).toMatchObject({ workspace: false, canChange: true, canTurnOff: true })
    // The review list is computed only while a switch is on.
    expect(before.outsideAccess).toBeNull()
    expect((await settings(bob)).canChange).toBe(false)
    expect((await settings(bob)).outsideAccess).toBeNull()
    expect((await setWorkspace(bob, true)).statusCode).toBe(403)
    expect((await pat.req('GET', `/api/workspaces/${DEV_STUDIO}/internal-only`)).statusCode).toBe(403)
    expect(
      (await quinn.req('PUT', `/api/workspaces/${DEV_STUDIO}/internal-only`, { internalOnly: true }))
        .statusCode,
    ).toBe(404)
    const on = await setWorkspace(alice, true)
    expect(on.statusCode, on.body).toBe(200)
    expect(InternalOnlySettings.parse(on.json()).workspace).toBe(true)
    // An outside admin (pre-existing, decision 4) may turn it on, never off (that hands sharing back).
    await api.db.query(
      "UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2",
      [DEV_STUDIO, pat.userId],
    )
    expect((await settings(pat)).canTurnOff).toBe(false)
    const off = await setWorkspace(pat, false)
    expect(off.statusCode).toBe(403)
    expect(code(off)).toBe('CREATOR_REQUIRED')
    expect((await setWorkspace(alice, false)).statusCode).toBe(200)
    expect((await settings(alice)).workspace).toBe(false)
    // Audited, with the actor.
    const audit = await api.db.query<{ action: string; actor_id: string; detail: { internalOnly: boolean } }>(
      "SELECT action, actor_id, detail FROM audit_events WHERE action LIKE '%internal_only' ORDER BY id",
    )
    expect(audit.rows.map((r) => [r.action, r.actor_id, r.detail.internalOnly])).toEqual([
      ['workspace.internal_only', alice.userId, true],
      ['workspace.internal_only', alice.userId, false],
    ])
  })

  it('lists the outside access that remains, and removes nothing', async () => {
    const link = ReviewLinkCreated.parse((await reviewLink(bob)).json())
    expect((await setWorkspace(alice, true)).statusCode).toBe(200)
    const s = await settings(alice)
    expect(s.outsideAccess?.people).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: pat.userId }),
        outside: true,
        emailDomain: 'client.example.test',
        workspaceRole: 'guest',
        boards: [{ id: board, title: 'Internal plan', projectId: null, role: 'viewer' }],
      }),
    ])
    expect(s.outsideAccess?.links.map((l) => l.id)).toEqual([link.id])
    expect(s.outsideAccess?.invitations).toEqual([])
    // pat still has the board; the link still exists (it admits creators only while the switch is on).
    expect((await pat.req('GET', `/api/boards/${board}`)).statusCode).toBe(200)
    expect(await api.db.one('SELECT revoked_at FROM invitations WHERE id = $1', [link.id])).toEqual({
      revoked_at: null,
    })
  })
})

describe('invitations and links from before the switch', () => {
  const invite = async (email: string) => {
    const res = await bob.req('POST', `/api/boards/${board}/invitations`, { role: 'commenter', email })
    expect(res.statusCode, res.body).toBe(201)
    return InvitationCreated.parse(res.json())
  }
  const accept = (c: Client, url: string) => c.req('POST', `/api/invitations/${tokenOf(url)}/accept`)
  const grantOf = async (userId: string) =>
    (
      await api.db.maybeOne<{ role: string }>(
        'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
        [board, userId],
      )
    )?.role ?? null

  it('an outside account cannot accept one while it is on; it is listed, revocable, and works once off', async () => {
    const forQuinn = await invite('quinn@client.example.test')
    const forStranger = await invite('stranger@client.example.test')
    // A creator address is not outside: never listed.
    await invite('lobby-test-b@darkburn.com')
    expect((await setWorkspace(alice, true)).statusCode).toBe(200)

    refused(await accept(quinn, forQuinn.url))
    expect(await grantOf(quinn.userId)).toBeNull()
    expect(await api.db.one('SELECT redeemed_by FROM invitations WHERE id = $1', [forQuinn.id])).toEqual({
      redeemed_by: null,
    })
    expect(
      await api.db.maybeOne(
        'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [DEV_STUDIO, quinn.userId],
      ),
    ).toBeNull()

    const listed = (await settings(alice)).outsideAccess?.invitations ?? []
    expect(listed.map((i) => i.id).sort()).toEqual([forQuinn.id, forStranger.id].sort())
    expect(listed.find((i) => i.id === forQuinn.id)).toEqual({
      id: forQuinn.id,
      boardId: board,
      boardTitle: 'Internal plan',
      projectId: null,
      role: 'commenter',
      expiresAt: forQuinn.expiresAt,
      emailDomain: 'client.example.test',
      emailHint: 'q•••@client.example.test',
    })
    expect(JSON.stringify(listed)).not.toContain('quinn@client.example.test')
    // The owner revokes one from the list (the workspace's owner manages every board here).
    expect((await alice.req('DELETE', `/api/invitations/${forStranger.id}`)).statusCode).toBe(204)
    expect((await settings(alice)).outsideAccess?.invitations.map((i) => i.id)).toEqual([forQuinn.id])

    // Off again: the invitation was never used up, so it works.
    expect((await setWorkspace(alice, false)).statusCode).toBe(200)
    expect((await accept(quinn, forQuinn.url)).statusCode).toBe(200)
    expect(await grantOf(quinn.userId)).toBe('commenter')
  })

  it('a workspace invitation, and a project that is internal only, refuse the same way', async () => {
    const res = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: 'quinn@client.example.test',
    })
    expect(res.statusCode, res.body).toBe(201)
    const wsInvite = InvitationCreated.parse(res.json())
    const project = (
      await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Secret' })
    ).json() as { id: string }
    expect((await bob.req('PATCH', `/api/boards/${board}`, { projectId: project.id })).statusCode).toBe(200)
    const boardInvite = await invite('quinn@client.example.test')
    expect(
      (await alice.req('PUT', `/api/projects/${project.id}/internal-only`, { internalOnly: true }))
        .statusCode,
    ).toBe(200)
    // The project covers the board, not the workspace invitation.
    refused(await accept(quinn, boardInvite.url), 'project')
    const listed = (await settings(alice)).outsideAccess?.invitations ?? []
    expect(listed.map((i) => [i.id, i.boardId])).toEqual(
      expect.arrayContaining([
        [wsInvite.id, null],
        [boardInvite.id, board],
      ]),
    )
    expect((await accept(quinn, wsInvite.url)).statusCode).toBe(200)
    // The whole workspace: a workspace invitation is refused too.
    const olga = await api.login('olga', 'Olga', { email: 'olga@client.example.test' })
    const forOlga = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: 'olga@client.example.test',
    })
    expect(forOlga.statusCode, forOlga.body).toBe(201)
    expect((await setWorkspace(alice, true)).statusCode).toBe(200)
    refused(await accept(olga, InvitationCreated.parse(forOlga.json()).url))
  })

  it('links: outside accounts and name-only guests are refused; a creator (stale too) still joins', async () => {
    const link = ReviewLinkCreated.parse(
      (await reviewLink(bob, { role: 'commenter', allowGuests: true })).json(),
    )
    expect((await setWorkspace(alice, true)).statusCode).toBe(200)
    refused(await accept(quinn, link.url))
    refused(await joinRequest(api, tokenOf(link.url), { name: 'Gail' }, { ip: freshIp() }))
    // Nothing was created for the guest who was turned away.
    expect(await api.db.maybeOne("SELECT 1 AS ok FROM users WHERE kind = 'guest'")).toBeNull()
    // A creator who is not in the workspace accepts; one whose addresses are a day old is confirmed first.
    const ana = await api.login('ana', 'Ana', { email: 'lobby-test-ana@darkburn.com' })
    await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      ana.userId,
    ])
    await api.db.query("UPDATE users SET identity_checked_at = now() - interval '25 hours' WHERE id = $1", [
      ana.userId,
    ])
    const ok = await accept(ana, link.url)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await grantOf(ana.userId)).toBe('commenter')
  })
})

describe('while the workspace is internal only', () => {
  beforeEach(async () => {
    expect((await setWorkspace(alice, true)).statusCode).toBe(200)
  })

  it('invitations: outside addresses are refused, creator addresses are not', async () => {
    refused(
      await bob.req('POST', `/api/boards/${board}/invitations`, {
        role: 'viewer',
        email: 'x@client.example.test',
      }),
    )
    refused(
      await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
        role: 'member',
        email: 'x@client.example.test',
      }),
    )
    refused(
      await bob.req('POST', `/api/boards/${board}/invitations/email`, {
        role: 'viewer',
        email: 'x@client.example.test',
      }),
    )
    // An address with an account (quinn): refused before the route picks a path, so with Clerk its
    // "granted" path (the role at once) never runs either (this dev api has no Clerk: a link otherwise).
    refused(
      await bob.req('POST', `/api/boards/${board}/invitations/email`, {
        role: 'viewer',
        email: 'quinn@client.example.test',
      }),
    )
    for (const res of [
      await bob.req('POST', `/api/boards/${board}/invitations`, {
        role: 'viewer',
        email: 'lobby-test-a@darkburn.com',
      }),
      await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, {
        role: 'member',
        email: devEmail('dora'),
      }),
    ])
      expect(res.statusCode, res.body).toBe(201)
    // Nothing outside was created.
    const rows = await api.db.query<{ invited_email: string }>('SELECT invited_email FROM invitations')
    expect(rows.rows.map((r) => r.invited_email).sort()).toEqual([
      devEmail('dora'),
      'lobby-test-a@darkburn.com',
    ])
  })

  it('links: no review, workshop or guest link; no extension and no opening an old one to guests', async () => {
    expect((await setWorkspace(alice, false)).statusCode).toBe(200)
    const old = ReviewLinkCreated.parse((await reviewLink(bob, { role: 'editor' })).json())
    expect((await setWorkspace(alice, true)).statusCode).toBe(200)
    refused(await reviewLink(bob))
    refused(await reviewLink(bob, { role: 'editor' }))
    refused(await reviewLink(bob, { role: 'viewer', allowGuests: true }))
    refused(await bob.req('POST', `/api/boards/${board}/review-links/${old.id}/extend`, { hours: 1 }))
    refused(await bob.req('PATCH', `/api/boards/${board}/review-links/${old.id}`, { allowGuests: true }))
    // Taking guests off, and revoking, stay open.
    expect(
      (await bob.req('PATCH', `/api/boards/${board}/review-links/${old.id}`, { allowGuests: false }))
        .statusCode,
    ).toBe(200)
    expect((await bob.req('POST', `/api/boards/${board}/review-links/${old.id}/revoke`, {})).statusCode).toBe(
      200,
    )
  })

  it('access requests: an outside account’s is refused on approve (deny stays open); a creator’s passes', async () => {
    const dave = await api.login('dave')
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1', [dave.userId])
    for (const c of [quinn, dave])
      expect(
        (await c.req('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })).statusCode,
      ).toBe(202)
    const ids = Object.fromEntries(
      (
        await api.db.query<{ id: string; user_id: string }>('SELECT id, user_id FROM access_requests')
      ).rows.map((r) => [r.user_id, r.id]),
    )
    refused(await bob.req('POST', `/api/access-requests/${ids[quinn.userId]}/approve`, {}))
    expect(await api.db.one('SELECT status FROM access_requests WHERE id = $1', [ids[quinn.userId]])).toEqual(
      {
        status: 'pending',
      },
    )
    expect((await bob.req('POST', `/api/access-requests/${ids[dave.userId]}/approve`, {})).statusCode).toBe(
      200,
    )
    expect((await bob.req('POST', `/api/access-requests/${ids[quinn.userId]}/deny`, {})).statusCode).toBe(200)
  })

  it('grants and roles: an outside account is never raised; lowering and creators stay open', async () => {
    refused(await bob.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'editor' }))
    expect(
      await api.db.one('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [
        board,
        pat.userId,
      ]),
    ).toEqual({ role: 'viewer' })
    refused(
      await alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${pat.userId}`, { role: 'member' }),
      'workspace',
    )
    // A creator target: fine. Lowering or removing the outsider: fine.
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })).statusCode,
    ).toBe(200)
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    expect((await bob.req('DELETE', `/api/boards/${board}/members/${pat.userId}`)).statusCode).toBe(200)
    // Someone who cannot manage the board gets the route's own answer, never INTERNAL_ONLY.
    const res = await carol.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'editor' })
    expect(code(res)).not.toBe(INTERNAL_ONLY_CODE)
  })

  it('a stale creator target is confirmed first, then allowed', async () => {
    await api.db.query("UPDATE users SET identity_checked_at = now() - interval '25 hours' WHERE id = $1", [
      carol.userId,
    ])
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })).statusCode,
    ).toBe(200)
  })
})

describe('the guards on other workstreams’ routes', () => {
  it('the api refuses to start when a route a hook keys on is not registered (a rename cannot turn one off)', () => {
    // This api started, so every real key matched (assertHookRoutes runs at ready time).
    expect(() =>
      assertHookRoutes(api.app, [
        'PUT /api/boards/:bid/members/:uid',
        'PATCH /api/workspaces/:wid/members/:uid',
        'POST /api/boards/:bid/invitations/email',
        'POST /api/boards/:bid/review-links/:id/extend',
        'PATCH /api/boards/:bid/review-links/:id',
        'POST /api/boards/:bid/ticket',
      ]),
    ).not.toThrow()
    expect(() =>
      assertHookRoutes(api.app, ['PUT /api/boards/:bid/members/:uid', 'PUT /api/boards/:bid/people/:uid']),
    ).toThrow('hooked routes are not registered: PUT /api/boards/:bid/people/:uid')
  })
})

describe('a project that is internal only', () => {
  it('covers the boards in that project only; members cannot switch it; guests get 404', async () => {
    const project = (
      await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Secret' })
    ).json() as {
      id: string
    }
    const inside = await createBoard(bob, DEV_STUDIO, 'In the project')
    expect((await bob.req('PATCH', `/api/boards/${inside}`, { projectId: project.id })).statusCode).toBe(200)
    expect(
      (await bob.req('PUT', `/api/projects/${project.id}/internal-only`, { internalOnly: true })).statusCode,
    ).toBe(403)
    expect(
      (await pat.req('PUT', `/api/projects/${project.id}/internal-only`, { internalOnly: true })).statusCode,
    ).toBe(404)
    const on = await alice.req('PUT', `/api/projects/${project.id}/internal-only`, { internalOnly: true })
    expect(on.statusCode, on.body).toBe(200)
    expect(InternalOnlySettings.parse(on.json()).projects).toEqual([
      { projectId: project.id, internalOnly: true },
    ])
    refused(
      await bob.req('POST', `/api/boards/${inside}/invitations`, {
        role: 'viewer',
        email: 'x@client.example.test',
      }),
      'project',
    )
    refused(await bob.req('POST', `/api/boards/${inside}/review-links`, { role: 'commenter' }), 'project')
    // A board outside the project is unaffected.
    expect((await reviewLink(bob)).statusCode).toBe(201)
    expect(
      (
        await bob.req('POST', `/api/boards/${board}/invitations`, {
          role: 'viewer',
          email: 'x@client.example.test',
        })
      ).statusCode,
    ).toBe(201)
    // The board reports it (Share dialog), and the address check says the invite would be refused.
    const outside = (await bob.req('GET', `/api/boards/${inside}/sharing/outside`)).json() as {
      internalOnly: string
    }
    expect(outside.internalOnly).toBe('project')
    const check = (
      await bob.req('POST', `/api/boards/${inside}/sharing/address-check`, {
        email: 'x@client.example.test',
      })
    ).json() as { internalOnly: string | null }
    expect(check.internalOnly).toBe('project')
  })
})
