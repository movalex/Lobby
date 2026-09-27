import {
  InvitationPreview,
  ListInvitationsResponse,
  ReviewLinkCreated,
  ReviewLinkRevoked,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256hex } from '../../../src/auth/session.ts'
import type { FeatureContext } from '../../../src/features/context.ts'
import {
  MAX_ACTIVE_REVIEW_LINKS,
  sweepExpiredReviewLinks,
} from '../../../src/features/dashboard/review-links.ts'
import type { AccessChange } from '../../../src/notifier.ts'
import { type Client, ORIGIN } from '../../helpers.ts'
import { boardRole, DAY, setupWorld, singleUseInvite, tokenOf, type World } from './setup.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

async function reviewLink(c: Client, boardId: string, body: object = {}) {
  const res = await c.req('POST', `/api/boards/${boardId}/review-links`, body)
  expect(res.statusCode, res.body).toBe(201)
  return ReviewLinkCreated.parse(res.json())
}
const accept = (c: Client, url: string) => c.req('POST', `/api/invitations/${tokenOf(url)}/accept`)
async function invitations(c: Client, boardId: string) {
  const res = await c.req('GET', `/api/boards/${boardId}/invitations`)
  expect(res.statusCode, res.body).toBe(200)
  return ListInvitationsResponse.parse(res.json()).invitations
}
/** The sweeper with the test API's clock and notifier (what the 60 s timer runs). */
const sweep = (w: World) =>
  sweepExpiredReviewLinks({
    db: w.api.db,
    now: w.api.clock.now,
    notifier: {
      accessChanged: (c: AccessChange) => void w.api.notifications.push({ ...c }),
      drain: async () => {},
    },
    events: w.events,
  } as unknown as FeatureContext)

describe('review links', () => {
  it('are multi-use: several people join with the link’s role; the link keeps working', async () => {
    const { bob, erin, frank, carol, board, api } = w
    const link = await reviewLink(bob, board)
    expect(link).toMatchObject({ role: 'commenter', maxUses: null })
    expect(link.url).toMatch(new RegExp(`^${ORIGIN}/invite/[A-Za-z0-9_-]{43}$`))
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * DAY - 60_000)
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThan(14 * DAY + 60_000)
    const row = await api.db.one<{ token_hash: string; multi_use: boolean }>(
      'SELECT token_hash, multi_use FROM invitations WHERE id = $1',
      [link.id],
    )
    expect(row).toEqual({ token_hash: sha256hex(tokenOf(link.url)), multi_use: true })

    for (const c of [erin, frank, carol]) {
      const res = await accept(c, link.url)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ boardId: board })
      expect(await boardRole(c, board)).toBe('commenter')
      expect(api.notifications).toContainEqual({ boardId: board, userId: c.userId })
    }
    expect((await accept(erin, link.url)).statusCode).toBe(200) // same person again: no second use
    const preview = await api.anon('GET', `/api/invitations/${tokenOf(link.url)}`)
    expect(preview.statusCode).toBe(200)
    expect(InvitationPreview.parse(preview.json())).toMatchObject({ role: 'commenter', board: { id: board } })
    const [listed] = await invitations(bob, board)
    expect(listed).toMatchObject({ id: link.id, kind: 'review', role: 'commenter', uses: 3, url: link.url })
  })

  it('role is capped at viewer/commenter and expiry at 30 days (API and database)', async () => {
    const { bob, board, api } = w
    for (const body of [
      { role: 'editor' },
      { role: 'owner' },
      { expiresInDays: 31 },
      { expiresInDays: 0 },
      { maxUses: 0 },
    ])
      expect((await bob.req('POST', `/api/boards/${board}/review-links`, body)).statusCode).toBe(400)
    const viewer = await reviewLink(bob, board, { role: 'viewer', expiresInDays: 30 })
    expect(new Date(viewer.expiresAt).getTime() - Date.now()).toBeGreaterThan(30 * DAY - 60_000)
    // The database refuses a multi-use editor link or a longer expiry even if a route forgot to check.
    const row = await api.db.one<{ workspace_id: string; created_by: string }>(
      'SELECT workspace_id, created_by FROM invitations WHERE id = $1',
      [viewer.id],
    )
    const insert = (role: string, days: number) =>
      api.db.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at, multi_use)
         VALUES ('inv_forged0000000000000', $1, $2, $3, $4, $5, now(), now() + make_interval(days => $6), true)`,
        ['f'.repeat(64), row.workspace_id, board, role, row.created_by, days],
      )
    await expect(insert('editor', 7)).rejects.toThrow()
    await expect(insert('viewer', 31)).rejects.toThrow()
  })

  it('max uses: the link closes for newcomers once used up; people who joined keep access', async () => {
    const { bob, erin, frank, board } = w
    const link = await reviewLink(bob, board, { role: 'viewer', maxUses: 1 })
    expect((await accept(erin, link.url)).statusCode).toBe(200)
    const res = await accept(frank, link.url)
    expect(res.statusCode).toBe(410)
    expect(await boardRole(frank, board)).toBeNull()
    expect(await boardRole(erin, board)).toBe('viewer')
    expect(await invitations(bob, board)).toEqual([])
  })

  it('expiry: the link stops working and the sweeper ends the access it created', async () => {
    const { bob, erin, frank, carol, board, api } = w
    const link = await reviewLink(bob, board, { role: 'commenter', expiresInDays: 2 })
    await accept(erin, link.url)
    await accept(frank, link.url)
    // carol already had viewer access before the link raised her to commenter: she keeps her grant.
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'viewer' })
    await accept(carol, link.url)
    expect(await boardRole(carol, board)).toBe('commenter')
    // frank was promoted by the owner afterwards: an explicit decision the link must not undo.
    await bob.req('PUT', `/api/boards/${board}/members/${frank.userId}`, { role: 'editor' })

    expect(await sweep(w)).toBe(0) // nothing expired yet
    api.clock.advance(2 * DAY + 1000)
    expect((await api.anon('GET', `/api/invitations/${tokenOf(link.url)}`)).statusCode).toBe(410)
    api.notifications.length = 0
    expect(await sweep(w)).toBe(1)
    expect(await boardRole(erin, board)).toBeNull()
    expect(await boardRole(frank, board)).toBe('editor')
    expect(await boardRole(carol, board)).toBe('commenter')
    expect(api.notifications).toEqual([{ boardId: board, userId: erin.userId }])
    expect(w.published.at(-1)).toMatchObject({
      type: 'sharing.changed',
      data: { reason: 'review-link-expired' },
    })
    expect(await sweep(w)).toBe(0) // swept once
  })

  it('revoke: removes the access it created by default (sync notified), or keeps it when asked', async () => {
    const { bob, erin, frank, board, api } = w
    const first = await reviewLink(bob, board)
    await accept(erin, first.url)
    api.notifications.length = 0
    const res = await bob.req('POST', `/api/boards/${board}/review-links/${first.id}/revoke`)
    expect(res.statusCode, res.body).toBe(200)
    expect(ReviewLinkRevoked.parse(res.json())).toEqual({ removed: 1 })
    expect(api.notifications).toEqual([{ boardId: board, userId: erin.userId }])
    expect(await boardRole(erin, board)).toBeNull()
    expect((await accept(frank, first.url)).statusCode).toBe(410)

    const second = await reviewLink(bob, board, { role: 'viewer' })
    await accept(frank, second.url)
    const keep = await bob.req('POST', `/api/boards/${board}/review-links/${second.id}/revoke`, {
      removeAccess: false,
    })
    expect(ReviewLinkRevoked.parse(keep.json())).toEqual({ removed: 0 })
    expect(await boardRole(frank, board)).toBe('viewer')
    expect((await accept(erin, second.url)).statusCode).toBe(410)
    // Revoking again with removal still ends the access the link created.
    const later = await bob.req('POST', `/api/boards/${board}/review-links/${second.id}/revoke`)
    expect(ReviewLinkRevoked.parse(later.json())).toEqual({ removed: 1 })
    expect(await boardRole(frank, board)).toBeNull()
    // M1's DELETE /api/invitations/:id also revokes a review link (without removing anyone).
    const third = await reviewLink(bob, board)
    expect((await bob.req('DELETE', `/api/invitations/${third.id}`)).statusCode).toBe(204)
    expect((await accept(erin, third.url)).statusCode).toBe(410)
  })

  it('someone who joined through two links keeps access until the last one ends', async () => {
    const { bob, erin, board, api } = w
    const a = await reviewLink(bob, board, { expiresInDays: 1 })
    const b = await reviewLink(bob, board, { expiresInDays: 3 })
    await accept(erin, a.url)
    await accept(erin, b.url)
    api.clock.advance(DAY + 1000)
    await sweep(w)
    expect(await boardRole(erin, board)).toBe('commenter')
    api.clock.advance(2 * DAY)
    await sweep(w)
    expect(await boardRole(erin, board)).toBeNull()
  })

  it('only people who can manage access create, list or revoke links', async () => {
    const { bob, carol, erin, board, alice } = w
    const link = await reviewLink(bob, board)
    expect((await carol.req('POST', `/api/boards/${board}/review-links`, {})).statusCode).toBe(404)
    expect((await carol.req('GET', `/api/boards/${board}/invitations`)).statusCode).toBe(404)
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    expect((await carol.req('POST', `/api/boards/${board}/review-links`, {})).statusCode).toBe(403)
    expect((await carol.req('GET', `/api/boards/${board}/invitations`)).statusCode).toBe(403)
    expect((await carol.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`)).statusCode).toBe(
      403,
    )
    expect((await erin.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`)).statusCode).toBe(
      404,
    )
    // A link id from another board is not found through this board.
    const other = (
      await bob.req('POST', `/api/workspaces/${await wsOf(bob, board)}/boards`, { title: 'O' })
    ).json().id
    expect((await bob.req('POST', `/api/boards/${other}/review-links/${link.id}/revoke`)).statusCode).toBe(
      404,
    )
    expect((await alice.req('GET', `/api/boards/${board}/invitations`)).statusCode).toBe(200)
  })

  it('the invitation list shows pending single-use links (URL shown once) and open review links only', async () => {
    const { bob, erin, board, api } = w
    const single = await singleUseInvite(bob, board, 'editor')
    const used = await singleUseInvite(bob, board, 'viewer')
    await accept(erin, used.url)
    const revoked = await singleUseInvite(bob, board, 'viewer')
    await bob.req('DELETE', `/api/invitations/${revoked.id}`)
    const review = await reviewLink(bob, board, { role: 'viewer' })
    const list = await invitations(bob, board)
    expect(list.map((i) => [i.id, i.kind, i.role, i.url])).toEqual([
      [review.id, 'review', 'viewer', review.url],
      [single.id, 'invite', 'editor', null],
    ])
    expect(list[1]?.createdBy).toEqual({ id: bob.userId, name: 'bob' })
    api.clock.advance(8 * DAY) // single-use links last 7 days
    expect((await invitations(bob, board)).map((i) => i.id)).toEqual([review.id])
  })

  it('M1 single-use links stay single-use', async () => {
    const { bob, erin, frank, board } = w
    const inv = await singleUseInvite(bob, board, 'viewer')
    expect((await accept(erin, inv.url)).statusCode).toBe(200)
    expect((await accept(frank, inv.url)).statusCode).toBe(410)
  })

  it(`caps open review links per board at ${MAX_ACTIVE_REVIEW_LINKS}`, async () => {
    const { bob, board } = w
    for (let i = 0; i < MAX_ACTIVE_REVIEW_LINKS; i++) await reviewLink(bob, board)
    const res = await bob.req('POST', `/api/boards/${board}/review-links`, {})
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('TOO_MANY_LINKS')
  })
})

async function wsOf(c: Client, boardId: string): Promise<string> {
  return ((await c.req('GET', `/api/boards/${boardId}`)).json() as { board: { workspaceId: string } }).board
    .workspaceId
}
