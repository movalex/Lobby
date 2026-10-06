// J2 item 4 (INV-4 / AUTHZ-KEEPSHARING-LINK-GRANTS): "Duplicate, keep sharing" copies no grant a review or
// workshop link created (on the copy it would outlive the link), and a grant a workshop link raised at the
// role it goes back to when the link ends. People's own grants are copied as before.

import { describe, expect, it } from 'vitest'
import {
  accept,
  DAY,
  grantOf,
  HOUR,
  link,
  put,
  roleOn,
  sweepLinks,
  useWorld,
  w,
} from './access-lifecycle-support.ts'

useWorld()

/** A board's grants as [user, role], sorted by code unit (not by the database's collation). */
const grantsOf = async (boardId: string) =>
  (
    await w.api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1',
      [boardId],
    )
  ).rows
    .map((r) => [r.user_id, r.role])
    .sort((a, b) => ((a[0] ?? '') < (b[0] ?? '') ? -1 : 1))
const sorted = (rows: string[][]) => [...rows].sort((a, b) => ((a[0] ?? '') < (b[0] ?? '') ? -1 : 1))

describe('J2 item 4 (INV-4): "Duplicate, keep sharing" copies no access a link gave', () => {
  it('a grant a link created is not copied; a workshop raise is copied at the role it goes back to; people’s own grants are copied', async () => {
    const { api, bob, carol, dave, erin, frank } = w
    expect((await put(bob, carol.userId, 'viewer')).statusCode).toBe(200) // a direct viewer...
    expect((await put(bob, dave.userId, 'commenter')).statusCode).toBe(200) // ...and a direct commenter
    const workshop = await link(bob, { role: 'editor', expiresInHours: 3 })
    const review = await link(bob, { role: 'commenter', expiresInDays: 2 })
    expect((await accept(erin, workshop.url)).statusCode).toBe(200) // created by the workshop link
    expect((await accept(carol, workshop.url)).statusCode).toBe(200) // raised viewer -> editor
    expect((await accept(frank, review.url)).statusCode).toBe(200) // created by the review link...
    expect((await put(bob, frank.userId, 'editor')).statusCode).toBe(200) // ...then made an editor by bob

    const res = await bob.req('POST', `/api/boards/${w.board}/duplicate`, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    const copy = (res.json() as { board: { id: string } }).board.id
    // before the fix: erin editor and carol editor on the copy too
    expect(await grantsOf(copy)).toEqual(
      sorted([
        [bob.userId, 'owner'],
        [carol.userId, 'viewer'],
        [dave.userId, 'commenter'],
        [frank.userId, 'editor'],
      ]),
    )

    // the links end: the source loses what they gave, and the copy never had it
    api.clock.advance(3 * HOUR + 1000)
    await sweepLinks()
    expect(await roleOn(erin)).toBeNull()
    expect(await roleOn(erin, copy)).toBeNull()
    expect(await roleOn(carol)).toBe('viewer')
    expect(await roleOn(carol, copy)).toBe('viewer')
    expect(await roleOn(frank, copy)).toBe('editor')
  })

  it('a review link’s raise of someone’s own grant stays on the source after the link, so it is copied as it is', async () => {
    const { bob, carol } = w
    expect((await put(bob, carol.userId, 'viewer')).statusCode).toBe(200)
    const review = await link(bob, { role: 'commenter' })
    await accept(carol, review.url)
    const res = await bob.req('POST', `/api/boards/${w.board}/duplicate`, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    const copy = (res.json() as { board: { id: string } }).board.id
    expect(await grantOf(carol.userId, copy)).toBe('commenter')
  })

  it('a grant a link created that the link sweep already handed to another open link is not copied either', async () => {
    const { api, bob, erin } = w
    const short = await link(bob, { role: 'viewer', expiresInDays: 1 })
    const long = await link(bob, { role: 'viewer', expiresInDays: 3 })
    await accept(erin, short.url)
    await accept(erin, long.url)
    api.clock.advance(DAY + 1000)
    await sweepLinks() // the grant now lives on through `long` (removeReviewLinkGrants' keeper)
    expect(await roleOn(erin)).toBe('viewer')
    const res = await bob.req('POST', `/api/boards/${w.board}/duplicate`, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    expect(await grantOf(erin.userId, (res.json() as { board: { id: string } }).board.id)).toBeNull()
  })
})
