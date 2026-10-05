// G2: "Anyone with the link can join with just a name" on a link that ALREADY exists
// (PATCH /api/boards/:bid/review-links/:id { allowGuests }). The Share dialog used to apply the box only
// to the next link, while its text changed as if it applied to the open one.
//
// - ON: the link's invite page and POST /api/invitations/:token/guest now let a name-only guest in, with
//   the link's own role (nothing else about the link changes: strict body, no role/expiry/uses).
// - OFF: no new name-only join; people who already joined keep their access and their sessions (which
//   still follow "+1 h"); revoking the link is what removes them.
// - Who: managers of the board. Turning it ON hands out access, so it is creator-only (domain access)
//   and never for a name-only guest; turning it OFF stays open to every manager.
// - A closed link (expired, revoked) stays closed; every refusal leaves the link as it was.
import {
  InvitationGuestAccess,
  ListInvitationsResponse,
  ReviewLinkExtended,
  ReviewLinkUpdated,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import {
  boardRole,
  errorCode,
  freshIp,
  guestLink,
  joinAsGuest,
  joinRequest,
  setupWorld,
  tokenOf,
  type World,
} from '../guests/support.ts'

const HOUR = 60 * 60 * 1000

let w: World
let events: { type: string; data: unknown }[]
beforeEach(async () => {
  w = await setupWorld()
  events = []
  w.events.subscribe(w.board, (e) => void events.push({ type: e.type, data: e.data }))
})
afterEach(() => w.api.close())

const patch = (c: Pick<Client, 'req'>, board: string, id: string, body?: unknown) =>
  c.req('PATCH', `/api/boards/${board}/review-links/${id}`, body)

const listed = async (c: Pick<Client, 'req'>, board: string) =>
  ListInvitationsResponse.parse((await c.req('GET', `/api/boards/${board}/invitations`)).json()).invitations
const previewAllowsGuests = async (url: string) => {
  const res = await w.api.anon('GET', `/api/invitations/${tokenOf(url)}`)
  expect(res.statusCode, res.body).toBe(200)
  return InvitationGuestAccess.parse(res.json()).allowGuests
}
const audits = () =>
  w.api.db.query<{ target: string; detail: Record<string, unknown>; actor_id: string }>(
    "SELECT target, detail, actor_id FROM audit_events WHERE action = 'invitation.update' ORDER BY at, id",
  )

describe('PATCH review-links/:id { allowGuests }', () => {
  it('turns "join with just a name" ON for a link that exists: its invite page and the guest join follow, with the link’s own role', async () => {
    const { bob, board, api } = w
    const link = await guestLink(bob, board, { role: 'editor', allowGuests: false })
    // before: the invite page asks for a sign-in, and a name-only join is refused
    expect(await previewAllowsGuests(link.url)).toBe(false)
    const refused = await joinRequest(api, tokenOf(link.url), { name: 'Sam' }, { ip: freshIp() })
    expect(refused.statusCode).toBe(403)
    expect(errorCode(refused)).toBe('GUESTS_NOT_ALLOWED')

    const res = await patch(bob, board, link.id, { allowGuests: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(ReviewLinkUpdated.parse(res.json())).toEqual({ allowGuests: true })

    // the list (the dialog's row), the invite page and the join all say so now
    const [row] = await listed(bob, board)
    expect(row).toMatchObject({ id: link.id, kind: 'review', role: 'editor', allowGuests: true })
    expect(await previewAllowsGuests(link.url)).toBe(true)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    // guest role caps unchanged: the link's role on this board, and nothing else
    expect(await boardRole(sam, board)).toBe('editor')
    expect(row?.expiresAt).toBe(link.expiresAt)
    expect(row?.maxUses).toBeNull()

    // told to every open board stream (a hint without identities), audited once
    expect(events.filter((e) => e.type === 'sharing.changed').map((e) => e.data)).toContainEqual(
      expect.objectContaining({ reason: 'review-link-updated' }),
    )
    const log = await audits()
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatchObject({
      target: link.id,
      actor_id: bob.userId,
      detail: { boardId: board, multiUse: true, allowGuests: true },
    })
  })

  it('a commenter (client) link keeps its role and its expiry when guests are turned on', async () => {
    const { bob, board, api } = w
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: false })
    expect((await patch(bob, board, link.id, { allowGuests: true })).statusCode).toBe(200)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    expect(await boardRole(sam, board)).toBe('commenter')
    const row = (await listed(bob, board)).find((i) => i.id === link.id)
    expect(row).toMatchObject({ role: 'commenter', expiresAt: link.expiresAt, uses: 1 })
  })

  it('turns it OFF: no new name-only join; the guests who are in keep their access, and their sessions follow "+1 h"', async () => {
    const { bob, board, api } = w
    const link = await guestLink(bob, board, { role: 'editor', allowGuests: true })
    const sam = await joinAsGuest(api, link.url, 'Sam')
    expect(await boardRole(sam, board)).toBe('editor')

    const res = await patch(bob, board, link.id, { allowGuests: false })
    expect(res.statusCode, res.body).toBe(200)
    expect(ReviewLinkUpdated.parse(res.json())).toEqual({ allowGuests: false })
    expect(await previewAllowsGuests(link.url)).toBe(false)
    const refused = await joinRequest(api, tokenOf(link.url), { name: 'Kim' }, { ip: freshIp() })
    expect(refused.statusCode).toBe(403)
    expect(errorCode(refused)).toBe('GUESTS_NOT_ALLOWED')
    // a person with an account still uses the link the usual way
    expect((await w.carol.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)).statusCode).toBe(200)
    // Sam, who joined while it was on, is still in
    expect(await boardRole(sam, board)).toBe('editor')

    // "+1 h": Sam's session follows the link's new end although guests are off now
    const ext = ReviewLinkExtended.parse(
      (await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/extend`, { hours: 1 })).json(),
    )
    const session = await api.db.one<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [sam.userId],
    )
    expect(session.expires_at.toISOString()).toBe(ext.expiresAt)
    expect(Date.parse(ext.expiresAt) - Date.parse(link.expiresAt)).toBe(HOUR)

    // revoking (with removal) is what takes Sam out
    const revoked = await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`, {
      removeAccess: true,
    })
    expect(revoked.statusCode).toBe(200)
    expect(await boardRole(sam, board)).toBeNull()
  })

  it('saying what it already is changes nothing: no audit row, no event', async () => {
    const { bob, board } = w
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: true })
    events.length = 0
    const res = await patch(bob, board, link.id, { allowGuests: true })
    expect(res.statusCode).toBe(200)
    expect(ReviewLinkUpdated.parse(res.json())).toEqual({ allowGuests: true })
    expect((await audits()).rows).toHaveLength(0)
    expect(events.filter((e) => e.type === 'sharing.changed')).toHaveLength(0)
  })

  it('only managers of the board: everyone else is refused and the link is as it was', async () => {
    const { bob, carol, erin, board, api } = w
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: false })
    const unchanged = async () =>
      expect((await listed(bob, board)).find((i) => i.id === link.id)?.allowGuests).toBe(false)

    expect((await patch(erin, board, link.id, { allowGuests: true })).statusCode).toBe(404) // no access to the board at all
    expect((await patch(carol, board, link.id, { allowGuests: true })).statusCode).toBe(404)
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    expect((await patch(carol, board, link.id, { allowGuests: true })).statusCode).toBe(403) // an editor does not manage access
    const anon = await api.anon('PATCH', `/api/boards/${board}/review-links/${link.id}`, {
      allowGuests: true,
    })
    expect(anon.statusCode).toBe(401)
    await unchanged()
    expect((await audits()).rows).toHaveLength(0)
  })

  it('a name-only guest never changes links, even as a board owner (a legacy grant)', async () => {
    const { bob, board, api } = w
    const open = await guestLink(bob, board, { role: 'commenter', allowGuests: true })
    const other = await guestLink(bob, board, { role: 'viewer', allowGuests: false })
    const sam = await joinAsGuest(api, open.url, 'Sam')
    await api.db.query("UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2", [
      board,
      sam.userId,
    ])
    expect(await boardRole(sam, board)).toBe('owner')
    for (const [id, allowGuests] of [
      [other.id, true],
      [open.id, false],
    ] as const) {
      const res = await patch(sam, board, id, { allowGuests })
      expect(res.statusCode, res.body).toBe(403)
      expect(errorCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    const rows = await listed(bob, board)
    expect(rows.find((i) => i.id === other.id)?.allowGuests).toBe(false)
    expect(rows.find((i) => i.id === open.id)?.allowGuests).toBe(true)
  })

  it('domain access: turning it ON is for creators; a manager who is not a creator can still turn it OFF', async () => {
    const { bob, board, api } = w
    // pat: a Dev Studio admin and owner of the board whose address is not a creator's (as in the creation matrix)
    const pat = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
    await api.db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'admin', now())",
      [DEV_STUDIO, pat.userId],
    )
    await api.db.query(
      "INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $3, now())",
      [board, pat.userId, bob.userId],
    )
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: false })
    const refused = await patch(pat, board, link.id, { allowGuests: true })
    expect(refused.statusCode, refused.body).toBe(403)
    expect(errorCode(refused)).toBe('CREATOR_REQUIRED')
    expect(await previewAllowsGuests(link.url)).toBe(false)
    // saying "on" for a link that is already on is a creator's call too (the answer never depends on the link)
    const on = await guestLink(bob, board, { role: 'commenter', allowGuests: true })
    expect(errorCode(await patch(pat, board, on.id, { allowGuests: true }))).toBe('CREATOR_REQUIRED')

    // lowering stays open to every manager
    const off = await patch(pat, board, on.id, { allowGuests: false })
    expect(off.statusCode, off.body).toBe(200)
    expect(await previewAllowsGuests(on.url)).toBe(false)
    // ...but pat cannot turn it back on
    expect(errorCode(await patch(pat, board, on.id, { allowGuests: true }))).toBe('CREATOR_REQUIRED')
    expect(await previewAllowsGuests(on.url)).toBe(false)
  })

  it('the body is exactly { allowGuests: boolean }: a link’s role, expiry and uses never change here', async () => {
    const { bob, board } = w
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: false })
    for (const body of [
      {},
      { allowGuests: 'yes' },
      { allowGuests: null },
      { allowGuests: true, role: 'editor' },
      { allowGuests: true, expiresInHours: 24 },
      { allowGuests: true, maxUses: 5 },
      { role: 'editor' },
    ]) {
      const res = await patch(bob, board, link.id, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    expect((await patch(bob, board, link.id)).statusCode).toBe(400) // no body at all
    const row = (await listed(bob, board)).find((i) => i.id === link.id)
    expect(row).toMatchObject({
      role: 'commenter',
      allowGuests: false,
      expiresAt: link.expiresAt,
      maxUses: null,
    })
  })

  it('finds only open links of this board: unknown, malformed, single-use and other boards’ ids are 404; a revoked or expired link is 409 LINK_CLOSED', async () => {
    const { bob, board, api } = w
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: false })
    const missing = 'inv_000000000000000000000'
    for (const id of [missing, 'not-an-id', "inv_'; drop table invitations; --"])
      expect((await patch(bob, board, encodeURIComponent(id), { allowGuests: true })).statusCode, id).toBe(
        404,
      )
    // a single-use invitation is not a link
    const single = await bob.req('POST', `/api/boards/${board}/invitations`, {
      role: 'viewer',
      email: 'newcomer@dev.test',
    })
    expect(single.statusCode, single.body).toBe(201)
    expect((await patch(bob, board, single.json().id as string, { allowGuests: true })).statusCode).toBe(404)
    // this board's link through another board of the same owner
    const other = await createBoard(bob, DEV_STUDIO, 'Other board')
    expect((await patch(bob, other, link.id, { allowGuests: true })).statusCode).toBe(404)

    // expired: closed (the sweep may not have run yet). A workshop link lasts 3 h.
    const workshop = await guestLink(bob, board, { role: 'editor', allowGuests: false })
    api.clock.advance(4 * HOUR)
    const late = await patch(bob, board, workshop.id, { allowGuests: true })
    expect(late.statusCode, late.body).toBe(409)
    expect(errorCode(late)).toBe('LINK_CLOSED')

    // revoked: closed
    const fresh = await guestLink(bob, board, { role: 'commenter', allowGuests: false })
    await bob.req('POST', `/api/boards/${board}/review-links/${fresh.id}/revoke`, { removeAccess: true })
    const gone = await patch(bob, board, fresh.id, { allowGuests: true })
    expect(gone.statusCode).toBe(409)
    expect(errorCode(gone)).toBe('LINK_CLOSED')
    expect((await audits()).rows).toHaveLength(0)
  })

  it('simultaneous joins and a switch-off: a join either happened (and stays) or was refused, never a half state', async () => {
    const { bob, board, api } = w
    const link = await guestLink(bob, board, { role: 'commenter', allowGuests: true })
    const results = await Promise.all([
      joinRequest(api, tokenOf(link.url), { name: 'A' }, { ip: freshIp() }),
      joinRequest(api, tokenOf(link.url), { name: 'B' }, { ip: freshIp() }),
      patch(bob, board, link.id, { allowGuests: false }),
      joinRequest(api, tokenOf(link.url), { name: 'C' }, { ip: freshIp() }),
    ])
    expect(results[2]?.statusCode).toBe(200)
    const joined = results.filter((r, i) => i !== 2 && r.statusCode === 201).length
    for (const [i, r] of results.entries())
      if (i !== 2) expect([201, 403], `${i}: ${r.body}`).toContain(r.statusCode)
    // every 201 is a guest with the commenter grant; the link counts exactly those
    const row = (await listed(bob, board)).find((i) => i.id === link.id)
    expect(row?.uses).toBe(joined)
    const guests = await api.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM board_members bm JOIN users u ON u.id = bm.user_id AND u.kind = 'guest'
        WHERE bm.board_id = $1 AND bm.role = 'commenter'`,
      [board],
    )
    expect(guests.n).toBe(joined)
    // once the switch-off committed, nobody joins any more
    const after = await joinRequest(api, tokenOf(link.url), { name: 'D' }, { ip: freshIp() })
    expect(after.statusCode).toBe(403)
  })
})
