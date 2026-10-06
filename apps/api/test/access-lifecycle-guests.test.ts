// J2 item 1 (INV-2 / AUTHZ-GUEST-REVOKE-ROLE-CHANGED): revoking a link with removal, or the link expiring,
// ends a name-only guest who came in through it whatever role an owner gave them since; another open link
// of theirs on the board keeps them, never above what the owner left. The guest sweep then signs them out.
// People with an account keep the old rule (an owner's change stands).

import { describe, expect, it } from 'vitest'
import {
  accept,
  DAY,
  grantOf,
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
import { createBoard, DEV_STUDIO } from './helpers.ts'

useWorld()

describe('J2 item 1 (INV-2): a name-only guest is out when their link ends, whatever role an owner gave them', () => {
  it('a guest an owner LOWERED (workshop editor to viewer): revoke with removal removes them; the guest sweep signs them out', async () => {
    const { api, bob } = w
    const workshop = await link(bob, { role: 'editor', allowGuests: true })
    const sam = await joinAsGuest(api, workshop.url, 'Sam')
    expect(await roleOn(sam)).toBe('editor')
    expect((await put(bob, sam.userId, 'viewer')).statusCode).toBe(200) // the guard allows it
    api.notifications.length = 0

    const res = await revoke(bob, workshop.id)
    expect(res.statusCode, res.body).toBe(200)
    // before the fix: { removed: 0 }, and Sam kept viewer until the link's original end
    expect(res.json()).toEqual({ removed: 1 })
    expect(api.notifications).toContainEqual(expect.objectContaining({ userId: sam.userId }))
    expect(await roleOn(sam)).toBeNull()
    expect(await grantOf(sam.userId)).toBeNull()
    const out = await guestSweep()
    expect(out.signedOut).toEqual([sam.userId])
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('a guest an owner RAISED (review commenter to editor): out at revoke, and still out six days later', async () => {
    const { api, bob } = w
    const review = await link(bob, { role: 'commenter', allowGuests: true, expiresInDays: 14 })
    const sam = await joinAsGuest(api, review.url, 'Sam')
    expect((await put(bob, sam.userId, 'editor')).statusCode).toBe(200)
    expect(await roleOn(sam)).toBe('editor')
    expect((await revoke(bob, review.id)).json()).toEqual({ removed: 1 })
    await guestSweep()
    api.clock.advance(6 * DAY)
    expect((await sam.req('GET', `/api/boards/${w.board}`)).statusCode).toBe(401)
    expect(await grantOf(sam.userId)).toBeNull()
  })

  it('the link EXPIRING ends a lowered guest too (the expiry sweep)', async () => {
    const { api, bob } = w
    const workshop = await link(bob, { role: 'editor', allowGuests: true, expiresInHours: 2 })
    const sam = await joinAsGuest(api, workshop.url, 'Sam')
    expect((await put(bob, sam.userId, 'commenter')).statusCode).toBe(200)
    api.clock.advance(2 * HOUR + 1000)
    // before the fix: 0, and Sam kept commenter (their session had ended with the link here, but a guest
    // with a longer session through another board's link kept the board)
    expect(await sweepLinks()).toBe(1)
    expect(await grantOf(sam.userId)).toBeNull()
  })

  it('another open guest link of theirs on the board keeps them, never above what an owner left', async () => {
    const { api, bob } = w
    const workshop = await link(bob, { role: 'editor', allowGuests: true })
    const review = await link(bob, { role: 'commenter', allowGuests: true, expiresInDays: 7 })
    const sam = await joinAsGuest(api, workshop.url, 'Sam')
    await joinAgain(sam, review.url)
    expect(await roleOn(sam)).toBe('editor')

    // the workshop ends: the review link keeps Sam, at its role
    expect((await revoke(bob, workshop.id)).json()).toEqual({ removed: 1 })
    expect(await roleOn(sam)).toBe('commenter')

    // the owner lowers Sam; a second workshop that Sam joins and that ends must not put Sam back up
    const second = await link(bob, { role: 'editor', allowGuests: true })
    await joinAgain(sam, second.url)
    expect(await roleOn(sam)).toBe('editor')
    expect((await put(bob, sam.userId, 'viewer')).statusCode).toBe(200)
    expect((await revoke(bob, second.id)).json()).toEqual({ removed: 0 })
    expect(await roleOn(sam)).toBe('viewer')

    // the last open link ends: out, whatever the role
    expect((await revoke(bob, review.id)).json()).toEqual({ removed: 1 })
    expect(await grantOf(sam.userId)).toBeNull()
    expect((await guestSweep()).signedOut).toEqual([sam.userId])
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('a guest on another board through another link keeps that board (and their session)', async () => {
    const { api, bob } = w
    const other = await createBoard(bob, DEV_STUDIO, 'Second board')
    const here = await link(bob, { role: 'editor', allowGuests: true })
    const there = await link(bob, { role: 'viewer', allowGuests: true }, other)
    const sam = await joinAsGuest(api, here.url, 'Sam')
    await joinAgain(sam, there.url)
    expect((await put(bob, sam.userId, 'viewer')).statusCode).toBe(200)
    expect((await revoke(bob, here.id)).json()).toEqual({ removed: 1 })
    expect(await guestSweep()).toEqual({ signedOut: [], removed: [] })
    expect(await roleOn(sam)).toBeNull()
    expect(await roleOn(sam, other)).toBe('viewer')
  })

  it('control: an owner’s change to a person WITH an account still stands (the rule for accounts is unchanged)', async () => {
    const { bob, erin } = w
    const workshop = await link(bob, { role: 'editor' })
    expect((await accept(erin, workshop.url)).statusCode).toBe(200)
    expect((await put(bob, erin.userId, 'viewer')).statusCode).toBe(200)
    expect((await revoke(bob, workshop.id)).json()).toEqual({ removed: 0 })
    expect(await roleOn(erin)).toBe('viewer')
  })
})
