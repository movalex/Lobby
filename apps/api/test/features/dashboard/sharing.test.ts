import {
  ListMembersResponse,
  ListShareMembersResponse,
  ReviewLinkCreated,
  type ShareMember,
  ShareState,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import { boardRole, setupWorld, tokenOf, type World } from './setup.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

async function state(c: Client, boardId: string) {
  const res = await c.req('GET', `/api/boards/${boardId}/sharing`)
  expect(res.statusCode, res.body).toBe(200)
  return ShareState.parse(res.json())
}
async function people(c: Client, boardId: string) {
  const res = await c.req('GET', `/api/boards/${boardId}/sharing/members`)
  expect(res.statusCode, res.body).toBe(200)
  return ListShareMembersResponse.parse(res.json()).members
}

describe('sharing state (board header badge)', () => {
  it('reports visibility, open review links and (for managers only) pending requests', async () => {
    const { bob, carol, erin, board } = w
    expect(await state(bob, board)).toEqual({
      visibility: 'private',
      links: [],
      directCount: 1,
      pendingRequests: 0,
      sharedOutside: false,
    })
    const link = ReviewLinkCreated.parse(
      (
        await bob.req('POST', `/api/boards/${board}/review-links`, { role: 'viewer', expiresInDays: 3 })
      ).json(),
    )
    await erin.req('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })
    await bob.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_view' })
    const s = await state(bob, board)
    expect(s).toMatchObject({ visibility: 'workspace_view', directCount: 1, pendingRequests: 1 })
    expect(s.links).toEqual([{ role: 'viewer', expiresAt: link.expiresAt }])
    // carol views through the workspace: she sees the state but not the request count.
    expect(await state(carol, board)).toMatchObject({ visibility: 'workspace_view', pendingRequests: null })
    expect((await erin.req('GET', `/api/boards/${board}/sharing`)).statusCode).toBe(404)
  })
})

describe('sharing events for changes made through M1 routes', () => {
  const sharingEvents = () => w.published.filter((e) => e.type === 'sharing.changed').map((e) => e.data)

  it('publishes a hint after a visibility change or a grant change succeeds, and nothing otherwise', async () => {
    const { bob, carol, board } = w
    expect((await bob.req('PATCH', `/api/boards/${board}`, { title: 'Renamed only' })).statusCode).toBe(200)
    expect(sharingEvents()).toEqual([])
    // A refused change (carol cannot see this private board) publishes nothing.
    expect(
      (await carol.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_edit' })).statusCode,
    ).toBe(404)
    expect(sharingEvents()).toEqual([])

    expect(
      (await bob.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_edit' })).statusCode,
    ).toBe(200)
    expect(sharingEvents()).toEqual([{ reason: 'visibility' }])
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    expect((await bob.req('DELETE', `/api/boards/${board}/members/${carol.userId}`)).statusCode).toBeLessThan(
      300,
    )
    expect(sharingEvents()).toEqual([{ reason: 'visibility' }, { reason: 'grant' }, { reason: 'grant' }])
    // The hint carries no identities.
    expect(JSON.stringify(sharingEvents())).not.toContain(carol.userId)
  })
})

describe('who has access and why (Share dialog)', () => {
  it('shows each person’s grant, workspace role, what they keep without the grant, and review-link joins', async () => {
    const { bob, carol, erin, alice, board } = w
    await bob.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_view' })
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    const link = ReviewLinkCreated.parse(
      (await bob.req('POST', `/api/boards/${board}/review-links`, {})).json(),
    )
    await erin.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)

    const byUser: Record<string, ShareMember> = Object.fromEntries(
      (await people(bob, board)).map((m) => [m.user.handle ?? m.user.id, m]),
    )
    expect(byUser.alice).toMatchObject({
      role: 'owner',
      source: 'workspace',
      grant: null,
      workspaceRole: 'owner',
    })
    expect(byUser.bob).toMatchObject({
      role: 'owner',
      source: 'grant',
      grant: 'owner',
      withoutGrant: 'viewer',
    })
    // Removing carol's direct grant would leave her "can view" through the workspace.
    expect(byUser.carol).toMatchObject({
      role: 'editor',
      source: 'grant',
      grant: 'editor',
      workspaceRole: 'member',
      withoutGrant: 'viewer',
      viaReviewLink: false,
      linkEndsAt: null,
    })
    expect(byUser.erin).toMatchObject({
      role: 'commenter',
      grant: 'commenter',
      workspaceRole: 'guest',
      withoutGrant: null,
      viaReviewLink: true,
      linkEndsAt: link.expiresAt,
    })
    // The M1 members list answers the same people (the detailed list only adds fields).
    const m1 = ListMembersResponse.parse(
      (await bob.req('GET', `/api/boards/${board}/members`)).json(),
    ).members
    expect(m1.map((m) => m.user.id).sort()).toEqual(
      Object.values(byUser)
        .map((m) => m.user.id)
        .sort(),
    )
    expect(alice.userId).toBeTruthy()
  })

  it('is for people who can manage access only', async () => {
    const { bob, carol, board } = w
    expect((await carol.req('GET', `/api/boards/${board}/sharing/members`)).statusCode).toBe(404)
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    expect((await carol.req('GET', `/api/boards/${board}/sharing/members`)).statusCode).toBe(403)
  })
})

describe('transfer ownership', () => {
  it('makes the target an owner and steps the caller down to editor in one change', async () => {
    const { bob, carol, board, api } = w
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'viewer' })
    api.notifications.length = 0
    const res = await bob.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: carol.userId })
    expect(res.statusCode, res.body).toBe(200)
    const members = ListMembersResponse.parse(res.json()).members
    expect(members.find((m) => m.user.id === carol.userId)?.role).toBe('owner')
    expect(members.find((m) => m.user.id === bob.userId)?.role).toBe('editor')
    expect(await boardRole(bob, board)).toBe('editor')
    expect(api.notifications).toEqual([
      { boardId: board, userId: carol.userId },
      { boardId: board, userId: bob.userId },
    ])
    // bob no longer manages access; carol does (and cannot "transfer" to herself).
    expect(
      (await bob.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: carol.userId })).statusCode,
    ).toBe(403)
    expect(
      (await carol.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: carol.userId }))
        .statusCode,
    ).toBe(400)
    expect((await carol.req('GET', `/api/boards/${board}/sharing/members`)).statusCode).toBe(200)
  })

  it('refuses outsiders, malformed ids and non-managers; a workspace owner keeps owning through the workspace', async () => {
    const { bob, carol, erin, alice, board } = w
    expect(
      (await bob.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: erin.userId })).statusCode,
    ).toBe(404)
    expect(
      (await bob.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: 'usr_x' })).statusCode,
    ).toBe(400)
    expect(
      (await carol.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: carol.userId }))
        .statusCode,
    ).toBe(404)
    // alice owns Dev Studio: she has no owner grant to step down from and stays owner.
    const res = await alice.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: carol.userId })
    expect(res.statusCode).toBe(200)
    expect(await boardRole(alice, board)).toBe('owner')
    expect(await boardRole(bob, board)).toBe('owner') // bob's own grant was not touched
    expect(await boardRole(carol, board)).toBe('owner')
  })
})
