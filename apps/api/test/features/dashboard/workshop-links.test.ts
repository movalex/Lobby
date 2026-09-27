// Workshop links (RETRO-04a): a multi-use EDIT link for a live session. Sign-in required, editor
// role, 3 h by default and 24 h at most, "+1 h" up to that cap, created only by people who may
// share the board. Permission isolation: an expired link is 410, the sweep ends the edit grants it
// created or raised, and sync is told for each person (the access monitor then closes or downgrades
// their open sockets: /internal/access answers the new role).
import {
  InternalAccessResponse,
  InvitationGoneBody,
  ListInvitationsResponse,
  ReviewLinkCreated,
  ReviewLinkExtended,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FeatureContext } from '../../../src/features/context.ts'
import { sweepExpiredReviewLinks } from '../../../src/features/dashboard/review-links.ts'
import type { AccessChange } from '../../../src/notifier.ts'
import { type Client, INTERNAL_SECRET } from '../../helpers.ts'
import { boardRole, setupWorld, tokenOf, type World } from './setup.ts'

const HOUR = 60 * 60 * 1000

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

async function workshopLink(c: Client, boardId: string, body: object = {}) {
  const res = await c.req('POST', `/api/boards/${boardId}/review-links`, { role: 'editor', ...body })
  expect(res.statusCode, res.body).toBe(201)
  return ReviewLinkCreated.parse(res.json())
}
const accept = (c: Client, url: string) => c.req('POST', `/api/invitations/${tokenOf(url)}/accept`)
const extend = (c: Client, boardId: string, id: string, hours?: number) =>
  c.req('POST', `/api/boards/${boardId}/review-links/${id}/extend`, hours === undefined ? {} : { hours })
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
/** What the sync server's access monitor would be told for this person (closes / downgrades sockets). */
async function syncRole(boardId: string, userId: string) {
  const res = await w.api.app.inject({
    method: 'GET',
    url: `/internal/access?boardId=${boardId}&userId=${userId}`,
    headers: { 'x-draftroom-internal': INTERNAL_SECRET },
  })
  expect(res.statusCode, res.body).toBe(200)
  return InternalAccessResponse.parse(res.json()).role
}

describe('workshop links', () => {
  it('give edit access to everyone who signs in with them, for 3 h by default; "+1 h" extends up to 24 h in all', async () => {
    const { bob, erin, frank, board, api } = w
    const link = await workshopLink(bob, board)
    expect(link).toMatchObject({ role: 'editor', maxUses: null })
    const created = Date.now()
    expect(Date.parse(link.expiresAt) - created).toBeGreaterThan(3 * HOUR - 60_000)
    expect(Date.parse(link.expiresAt) - created).toBeLessThan(3 * HOUR + 60_000)
    for (const c of [erin, frank]) {
      expect((await accept(c, link.url)).statusCode).toBe(200)
      expect(await boardRole(c, board)).toBe('editor')
      expect(await syncRole(board, c.userId)).toBe('editor')
    }
    // an anonymous visitor sees the preview but must sign in to join
    expect((await api.anon('GET', `/api/invitations/${tokenOf(link.url)}`)).statusCode).toBe(200)
    expect((await api.anon('POST', `/api/invitations/${tokenOf(link.url)}/accept`)).statusCode).toBe(401)

    const [listed] = ListInvitationsResponse.parse(
      (await bob.req('GET', `/api/boards/${board}/invitations`)).json(),
    ).invitations
    expect(listed).toMatchObject({ id: link.id, kind: 'review', role: 'editor', uses: 2, url: link.url })
    const cap = Date.parse(listed?.maxExpiresAt ?? '')
    expect(cap - created).toBeGreaterThan(24 * HOUR - 60_000)
    expect(cap - created).toBeLessThan(24 * HOUR + 60_000)

    const one = await extend(bob, board, link.id)
    expect(one.statusCode, one.body).toBe(200)
    const ext = ReviewLinkExtended.parse(one.json())
    expect(Date.parse(ext.expiresAt) - Date.parse(link.expiresAt)).toBe(HOUR)
    expect(ext.maxExpiresAt).toBe(listed?.maxExpiresAt)
    expect(w.published.at(-1)).toMatchObject({
      type: 'sharing.changed',
      data: { reason: 'review-link-extended' },
    })
    // never past 24 h after creation
    const big = ReviewLinkExtended.parse((await extend(bob, board, link.id, 24)).json())
    expect(big.expiresAt).toBe(listed?.maxExpiresAt)
    const more = await extend(bob, board, link.id)
    expect(more.statusCode).toBe(409)
    expect(more.json()).toMatchObject({ error: { code: 'LINK_MAX_EXPIRY' } })
    // the database holds the same line even if a route forgot to check
    await expect(
      api.db.query("UPDATE invitations SET expires_at = created_at + interval '25 hours' WHERE id = $1", [
        link.id,
      ]),
    ).rejects.toThrow()
  })

  it('expiry: 410 for the link, the sweep removes the edit grants it created and puts a raised viewer back; sync is told for each', async () => {
    const { bob, carol, erin, frank, board, api } = w
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'viewer' })
    const link = await workshopLink(bob, board, { expiresInHours: 2 })
    for (const c of [erin, frank, carol]) expect((await accept(c, link.url)).statusCode).toBe(200)
    expect(await boardRole(carol, board)).toBe('editor') // raised for the workshop
    // frank is made an owner during the session: an explicit decision the link must not undo
    await bob.req('PUT', `/api/boards/${board}/members/${frank.userId}`, { role: 'owner' })

    api.clock.advance(HOUR)
    expect(await sweep(w)).toBe(0) // still open
    api.clock.advance(HOUR + 1000)
    const preview = await api.anon('GET', `/api/invitations/${tokenOf(link.url)}`)
    expect(preview.statusCode).toBe(410)
    const vic = await w.api.login('vic')
    const late = await accept(vic, link.url)
    expect(late.statusCode).toBe(410)
    expect(InvitationGoneBody.parse(late.json()).gone.boardId).toBeNull()
    expect(await boardRole(vic, board)).toBeNull()

    api.notifications.length = 0
    expect(await sweep(w)).toBe(2)
    expect(await boardRole(erin, board)).toBeNull()
    expect(await boardRole(carol, board)).toBe('viewer')
    expect(await boardRole(frank, board)).toBe('owner')
    // the access monitor's answer: erin's sockets close (FORBIDDEN), carol's reconnect read-only
    expect(await syncRole(board, erin.userId)).toBeNull()
    expect(await syncRole(board, carol.userId)).toBe('viewer')
    expect(api.notifications).toEqual(
      expect.arrayContaining([
        { boardId: board, userId: erin.userId },
        { boardId: board, userId: carol.userId },
      ]),
    )
    expect(api.notifications).toHaveLength(2)
    expect(w.published.at(-1)).toMatchObject({ data: { reason: 'review-link-expired' } })
    expect(await sweep(w)).toBe(0) // once
  })

  it('revoke with removal ends the edit access at once; someone removed by the owner who rejoins still loses it at the end', async () => {
    const { bob, erin, frank, board, api } = w
    const link = await workshopLink(bob, board)
    await accept(erin, link.url)
    await accept(frank, link.url)
    // bob removes frank during the session; frank opens the link again and is back as an editor
    await bob.req('DELETE', `/api/boards/${board}/members/${frank.userId}`)
    api.clock.advance(60_000)
    expect((await accept(frank, link.url)).statusCode).toBe(200)
    expect(await boardRole(frank, board)).toBe('editor')

    api.notifications.length = 0
    const res = await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ removed: 2 })
    for (const c of [erin, frank]) {
      expect(await boardRole(c, board)).toBeNull()
      expect(await syncRole(board, c.userId)).toBeNull()
    }
    expect(api.notifications).toHaveLength(2)
    // a revoked link cannot be extended back to life
    expect((await extend(bob, board, link.id)).statusCode).toBe(409)
  })

  it('joined through a workshop link and a review link: edit ends with the workshop, comment with the review link', async () => {
    const { bob, erin, board, api } = w
    const workshop = await workshopLink(bob, board, { expiresInHours: 3 })
    const review = ReviewLinkCreated.parse(
      (
        await bob.req('POST', `/api/boards/${board}/review-links`, { role: 'commenter', expiresInDays: 2 })
      ).json(),
    )
    await accept(erin, workshop.url)
    await accept(erin, review.url) // never downgrades: still an editor
    expect(await boardRole(erin, board)).toBe('editor')
    api.clock.advance(3 * HOUR + 1000)
    await sweep(w)
    expect(await boardRole(erin, board)).toBe('commenter')
    api.clock.advance(2 * 24 * HOUR)
    await sweep(w)
    expect(await boardRole(erin, board)).toBeNull()
  })

  it('only people who may share the board create or extend one; viewers and editors cannot, outsiders get 404', async () => {
    const { bob, carol, erin, board } = w
    const link = await workshopLink(bob, board)
    expect((await erin.req('POST', `/api/boards/${board}/review-links`, { role: 'editor' })).statusCode).toBe(
      404,
    )
    for (const role of ['viewer', 'commenter', 'editor']) {
      await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role })
      expect(
        (await carol.req('POST', `/api/boards/${board}/review-links`, { role: 'editor' })).statusCode,
        role,
      ).toBe(403)
      expect((await extend(carol, board, link.id)).statusCode, role).toBe(403)
    }
    expect((await extend(erin, board, link.id)).statusCode).toBe(404)
    expect((await extend(bob, board, 'inv_doesnotexist00000')).statusCode).toBe(404)
    for (const body of [{ hours: 0 }, { hours: 25 }, { hours: 'one' }])
      expect(
        (await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/extend`, body)).statusCode,
      ).toBe(400)
  })
})
