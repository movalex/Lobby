// Search across boards: who finds what (docs/WAVE4-CONTRACTS.md "search"; permission leaks are the main
// risk). Every board holds the same word; each person must find exactly the boards they can open.
//
// Dev Studio (alice owns it; bob, carol and dave are members):
//   P  private, bob owns it, dave has a viewer grant, a name-only guest joined through a review link
//   W  shared with the workspace to view          E  shared with the workspace to edit
//   T  private, trashed                            A  shared to view, archived
// erin is not a member of Dev Studio; her own workspace has board X.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import type { FeatureContext } from '../../../src/features/context.ts'
import { sweepExpiredReviewLinks } from '../../../src/features/dashboard/review-links.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest, tokenOf } from '../guests/support.ts'
import { boardsOf, note, type SearchWorld, search, searchRaw, searchWorld } from './support.ts'

let w: SearchWorld
let alice: Client
let bob: Client
let carol: Client
let dave: Client
let erin: Client
let guest: GuestClient
const b = { P: '', W: '', E: '', T: '', A: '', X: '' }

beforeAll(async () => {
  w = await searchWorld()
  const { api } = w
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  b.P = await createBoard(bob, DEV_STUDIO, 'Plan P')
  b.W = await createBoard(bob, DEV_STUDIO, 'Shared W')
  b.E = await createBoard(bob, DEV_STUDIO, 'Shared E')
  b.T = await createBoard(bob, DEV_STUDIO, 'Trashed T')
  b.A = await createBoard(bob, DEV_STUDIO, 'Archived A')
  b.X = await createBoard(erin, erin.personalWorkspaceId, 'Foreign X')
  const patch = async (id: string, body: object) => {
    const res = await bob.req('PATCH', `/api/boards/${id}`, body)
    expect(res.statusCode, res.body).toBe(200)
  }
  await patch(b.W, { visibility: 'workspace_view' })
  await patch(b.E, { visibility: 'workspace_edit' })
  await patch(b.A, { visibility: 'workspace_view' })
  expect((await bob.req('POST', `/api/boards/${b.A}/archive`)).statusCode).toBe(200)
  expect((await bob.req('POST', `/api/boards/${b.T}/trash`)).statusCode).toBe(200)
  const grant = await bob.req('PUT', `/api/boards/${b.P}/members/${dave.userId}`, { role: 'viewer' })
  expect(grant.statusCode, grant.body).toBe(200)
  guest = await joinAsGuest(api, (await guestLink(bob, b.P, { role: 'viewer' })).url, 'Sam')
  for (const [k, id] of Object.entries(b))
    w.sync.setText(id, [note(`${k}-note`, `zebra notes of board ${k}`)])
})

afterAll(async () => {
  await w.close()
})

describe('search: the permission filter', () => {
  it('finds, for each person, exactly the boards they can open', async () => {
    expect(boardsOf(await search(alice, DEV_STUDIO, 'zebra'))).toEqual([b.P, b.W, b.E].sort())
    expect(boardsOf(await search(bob, DEV_STUDIO, 'zebra'))).toEqual([b.P, b.W, b.E].sort())
    expect(boardsOf(await search(dave, DEV_STUDIO, 'zebra'))).toEqual([b.P, b.W, b.E].sort())
    // carol is a member without a grant on the private board
    const carolRes = await searchRaw(carol, DEV_STUDIO, 'zebra')
    expect(boardsOf(carolRes.json())).toEqual([b.W, b.E].sort())
    expect(carolRes.body).not.toContain(b.P)
    expect(carolRes.body).not.toContain('board P')
    // a name-only guest: only the board of their link, even though W and E are shared with members
    const guestRes = await guest.req('GET', `/api/workspaces/${DEV_STUDIO}/search?q=zebra`)
    expect(guestRes.statusCode, guestRes.body).toBe(200)
    expect(boardsOf(guestRes.json())).toEqual([b.P])
  })

  it('never searches trashed boards, nor another workspace', async () => {
    for (const c of [alice, bob, carol, dave]) {
      const res = await searchRaw(c, DEV_STUDIO, 'zebra')
      expect(res.body).not.toContain(b.T)
      expect(res.body).not.toContain(b.X)
    }
    // erin is not a member of Dev Studio: the workspace does not exist for her
    const outsider = await searchRaw(erin, DEV_STUDIO, 'zebra')
    expect(outsider.statusCode).toBe(404)
    expect(outsider.body).not.toContain('zebra')
    // and nobody from Dev Studio reaches erin's workspace
    for (const c of [alice, bob, carol])
      expect((await searchRaw(c, erin.personalWorkspaceId, 'zebra')).statusCode).toBe(404)
    expect(
      (await guest.req('GET', `/api/workspaces/${erin.personalWorkspaceId}/search?q=zebra`)).statusCode,
    ).toBe(404)
    expect(boardsOf(await search(erin, erin.personalWorkspaceId, 'zebra'))).toEqual([b.X])
    // a made-up workspace id, a malformed one
    expect((await searchRaw(alice, 'wsp_Nope000000000000000', 'zebra')).statusCode).toBe(404)
    expect((await searchRaw(alice, '..%2F..', 'zebra')).statusCode).toBe(404)
  })

  it('needs a session', async () => {
    const res = await w.api.anon('GET', `/api/workspaces/${DEV_STUDIO}/search?q=zebra`)
    expect(res.statusCode).toBe(401)
  })

  it('searches archived boards only when asked, and only those the person can view', async () => {
    expect(boardsOf(await search(alice, DEV_STUDIO, 'zebra', { status: 'archived' }))).toEqual([b.A])
    expect(boardsOf(await search(carol, DEV_STUDIO, 'zebra', { status: 'archived' }))).toEqual([b.A])
    const g = await guest.req('GET', `/api/workspaces/${DEV_STUDIO}/search?q=zebra&status=archived`)
    expect(boardsOf(g.json())).toEqual([])
    const trashed = await searchRaw(alice, DEV_STUDIO, 'zebra', { status: 'trashed' })
    expect(trashed.statusCode).toBe(400)
  })

  it('follows access changes at once (the filter runs at query time)', async () => {
    const vis = async (visibility: string) =>
      expect((await bob.req('PATCH', `/api/boards/${b.P}`, { visibility })).statusCode).toBe(200)
    await vis('workspace_view')
    expect(boardsOf(await search(carol, DEV_STUDIO, 'zebra'))).toEqual([b.P, b.W, b.E].sort())
    await vis('private')
    expect(boardsOf(await search(carol, DEV_STUDIO, 'zebra'))).toEqual([b.W, b.E].sort())

    const removed = await bob.req('DELETE', `/api/boards/${b.P}/members/${dave.userId}`)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(boardsOf(await search(dave, DEV_STUDIO, 'zebra'))).toEqual([b.W, b.E].sort())
    const back = await bob.req('PUT', `/api/boards/${b.P}/members/${dave.userId}`, { role: 'viewer' })
    expect(back.statusCode).toBe(200)
    expect(boardsOf(await search(dave, DEV_STUDIO, 'zebra'))).toEqual([b.P, b.W, b.E].sort())
  })

  it('narrows to one project', async () => {
    const created = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Launch' })
    expect(created.statusCode, created.body).toBe(201)
    const projectId = (created.json() as { id: string }).id
    expect((await bob.req('PATCH', `/api/boards/${b.E}`, { projectId })).statusCode).toBe(200)
    expect(boardsOf(await search(carol, DEV_STUDIO, 'zebra', { projectId }))).toEqual([b.E])
    expect(boardsOf(await search(guest, DEV_STUDIO, 'zebra', { projectId }))).toEqual([])
    // a project of another workspace finds nothing (not an error: the id came from the caller)
    expect(
      boardsOf(await search(alice, DEV_STUDIO, 'zebra', { projectId: 'prj_Other00000000000000' })),
    ).toEqual([])
    expect((await searchRaw(alice, DEV_STUDIO, 'zebra', { projectId: 'nope' })).statusCode).toBe(400)
  })
})

describe('search: access that ends', () => {
  it('an expired review link takes its board out of search, for account holders and name-only guests', async () => {
    const x = await searchWorld()
    try {
      const { api } = x
      await api.login('alice')
      const owner = await api.login('bob')
      const member = await api.login('carol')
      const board = await createBoard(owner, DEV_STUDIO, 'Review board')
      x.sync.setText(board, [note('r1', 'okapi review notes')])
      const link = await guestLink(owner, board, { role: 'viewer' })
      const accepted = await member.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)
      expect(accepted.statusCode, accepted.body).toBe(200)
      const sam = await joinAsGuest(api, link.url, 'Sam')
      expect(boardsOf(await search(member, DEV_STUDIO, 'okapi'))).toEqual([board])
      expect(boardsOf(await search(sam, DEV_STUDIO, 'okapi'))).toEqual([board])

      api.clock.advance(Date.parse(link.expiresAt) + 1_000 - api.clock.now().getTime())
      await sweepExpiredReviewLinks({
        db: api.db,
        now: api.clock.now,
        notifier: { accessChanged: () => {}, drain: async () => {} },
        events: new EventHub(),
      } as unknown as FeatureContext)
      const after = await searchRaw(member, DEV_STUDIO, 'okapi')
      expect(after.statusCode).toBe(200)
      expect(boardsOf(after.json())).toEqual([])
      expect(after.body).not.toContain(board)
      expect(after.body).not.toContain('okapi review')
      // The guest's session ended with the link: nothing to search with.
      expect((await searchRaw(sam, DEV_STUDIO, 'okapi')).statusCode).toBe(401)
    } finally {
      await x.close()
    }
  })
})
