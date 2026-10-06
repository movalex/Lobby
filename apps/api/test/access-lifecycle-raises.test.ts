// J2 item 3 (MISS-1): a grant a multi-use link created stays the links' when a second link raises it, so it
// ends with the last of them instead of becoming permanent, and the Share dialog keeps saying it is a link's.
// The rules for someone's own grant that a link raises are unchanged (a workshop puts it back, a review
// link's raise stays).

import { ListShareMembersResponse } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  accept,
  DAY,
  guestSweep,
  HOUR,
  joinAgain,
  link,
  put,
  revoke,
  roleOn,
  sweepLinks,
  useWorld,
  w,
} from './access-lifecycle-support.ts'
import { joinAsGuest } from './features/guests/support.ts'

useWorld()

const shareRow = async (userId: string) => {
  const res = await w.bob.req('GET', `/api/boards/${w.board}/sharing/members`)
  expect(res.statusCode, res.body).toBe(200)
  return ListShareMembersResponse.parse(res.json()).members.find((m) => m.user.id === userId)
}

describe('J2 item 3 (MISS-1): a grant a link created stays the links’ when a second link raises it', () => {
  it('(A) a 1-day viewer link, then a 2-day comment link: the access ends with the last link, and the Share row says so', async () => {
    const { api, bob, erin } = w
    const view = await link(bob, { role: 'viewer', expiresInDays: 1 })
    const comment = await link(bob, { role: 'commenter', expiresInDays: 2 })
    expect((await accept(erin, view.url)).statusCode).toBe(200)
    expect((await accept(erin, comment.url)).statusCode).toBe(200)
    expect(await roleOn(erin)).toBe('commenter')
    // before the fix: "Direct access" (viaReviewLink false, no end), as if an owner had chosen it
    expect(await shareRow(erin.userId)).toMatchObject({ viaReviewLink: true, linkEndsAt: comment.expiresAt })

    api.clock.advance(DAY + 1000)
    expect(await sweepLinks()).toBe(0) // the comment link still holds the grant
    expect(await roleOn(erin)).toBe('commenter')
    api.clock.advance(DAY)
    expect(await sweepLinks()).toBe(1) // before the fix: 0, and erin a commenter for good
    expect(await roleOn(erin)).toBeNull()
  })

  it('(A, the other order) the raising link ends first: back to the first link’s role, then out with it', async () => {
    const { api, bob, erin } = w
    const view = await link(bob, { role: 'viewer', expiresInDays: 2 })
    const comment = await link(bob, { role: 'commenter', expiresInDays: 1 })
    await accept(erin, view.url)
    await accept(erin, comment.url)
    api.clock.advance(DAY + 1000)
    expect(await sweepLinks()).toBe(1)
    expect(await roleOn(erin)).toBe('viewer')
    expect(await shareRow(erin.userId)).toMatchObject({ viaReviewLink: true, linkEndsAt: view.expiresAt })
    api.clock.advance(DAY)
    expect(await sweepLinks()).toBe(1)
    expect(await roleOn(erin)).toBeNull()
  })

  it('(B) a 1 h viewer link, then a workshop: when the workshop ends after the viewer link, nothing is left', async () => {
    const { api, bob, erin } = w
    const view = await link(bob, { role: 'viewer', expiresInHours: 1 })
    const workshop = await link(bob, { role: 'editor', expiresInHours: 3 })
    await accept(erin, view.url)
    await accept(erin, workshop.url)
    expect(await roleOn(erin)).toBe('editor')
    api.clock.advance(HOUR + 1000)
    expect(await sweepLinks()).toBe(0)
    api.clock.advance(2 * HOUR)
    expect(await sweepLinks()).toBe(1)
    // before the fix: viewer, for good (the workshop "put back" the role a link had given)
    expect(await roleOn(erin)).toBeNull()
  })

  it('(C) revoking both links with removal: the second revoke removes them', async () => {
    const { bob, erin } = w
    const view = await link(bob, { role: 'viewer' })
    const comment = await link(bob, { role: 'commenter' })
    await accept(erin, view.url)
    await accept(erin, comment.url)
    expect((await revoke(bob, view.id)).json()).toEqual({ removed: 0 }) // the comment link still holds it
    expect((await revoke(bob, comment.id)).json()).toEqual({ removed: 1 }) // before the fix: 0
    expect(await roleOn(erin)).toBeNull()
  })

  it('(D) a name-only guest on two guest links: both revoked with removal, then signed out', async () => {
    const { api, bob } = w
    const view = await link(bob, { role: 'viewer', allowGuests: true })
    const comment = await link(bob, { role: 'commenter', allowGuests: true })
    const sam = await joinAsGuest(api, view.url, 'Sam')
    await joinAgain(sam, comment.url)
    expect(await roleOn(sam)).toBe('commenter')
    expect((await revoke(bob, view.id)).json()).toEqual({ removed: 0 })
    expect((await revoke(bob, comment.id)).json()).toEqual({ removed: 1 })
    expect((await guestSweep()).signedOut).toEqual([sam.userId])
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('control: an owner’s own grant raised by a workshop goes back to it; one raised by a review link keeps the raise (unchanged rules)', async () => {
    const { api, bob, carol, dave } = w
    expect((await put(bob, carol.userId, 'viewer')).statusCode).toBe(200)
    expect((await put(bob, dave.userId, 'viewer')).statusCode).toBe(200)
    const workshop = await link(bob, { role: 'editor', expiresInHours: 1 })
    const review = await link(bob, { role: 'commenter', expiresInDays: 1 })
    await accept(carol, workshop.url)
    await accept(dave, review.url)
    api.clock.advance(DAY + 1000)
    expect(await sweepLinks()).toBe(1)
    expect(await roleOn(carol)).toBe('viewer')
    expect(await roleOn(dave)).toBe('commenter')
  })
})
