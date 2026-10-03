// A6 (GUEST-JOIN-TRASH): POST /api/invitations/:token/guest never joins a guest link whose board is in
// the trash, as accepting an invitation does not (routes/invitations.ts: 409 BOARD_IN_TRASH). Nobody can
// open a trashed board, so a join would only create guest users and sessions and use up the link.
// Nothing is redeemed: the link works again once the board is restored.
import { BOARD_IN_TRASH } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { errorCode, guestLink, joinAsGuest, joinRequest, setupWorld, tokenOf, type World } from './support.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const guestCount = async (api: World['api']) =>
  (await api.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE kind = 'guest'")).n
const redemptions = async (api: World['api'], invitationId: string) =>
  (
    await api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM invitation_redemptions WHERE invitation_id = $1',
      [invitationId],
    )
  ).n

describe('joining a guest link whose board is in the trash', () => {
  it('answers 409 BOARD_IN_TRASH and creates no guest, session or redemption; the link works again after a restore', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board)
    const token = tokenOf(link.url)
    expect((await bob.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)

    const notifications = api.notifications.length
    const refused = await joinRequest(api, token, { name: 'Sam' }, {})
    expect(refused.statusCode, refused.body).toBe(409)
    expect(errorCode(refused)).toBe(BOARD_IN_TRASH.code)
    expect(refused.json()).toEqual({ error: { code: BOARD_IN_TRASH.code, message: BOARD_IN_TRASH.message } })
    // No cookie, no guest user, no session, no redemption, no sync push.
    expect(refused.cookies.find((c) => c.name === 'dr_session')).toBeUndefined()
    expect(await guestCount(api)).toBe(0)
    expect(
      (
        await api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id AND u.kind = 'guest'",
        )
      ).n,
    ).toBe(0)
    expect(await redemptions(api, link.id)).toBe(0)
    expect(api.notifications.length).toBe(notifications)

    // Restored: the same link joins (it was not used up).
    expect((await bob.req('POST', `/api/boards/${board}/restore`)).statusCode).toBe(200)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    expect(sam.joined.boardId).toBe(board)
    expect(await guestCount(api)).toBe(1)
  })

  it('does not use up a link: one capped at a single use still has it after refused joins', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board, { maxUses: 1 })
    await bob.req('POST', `/api/boards/${board}/trash`)
    for (let i = 0; i < 3; i++)
      expect((await joinRequest(api, tokenOf(link.url), { name: `Try ${i}` }, {})).statusCode).toBe(409)
    expect(await redemptions(api, link.id)).toBe(0)
    await bob.req('POST', `/api/boards/${board}/restore`)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    expect(sam.joined.created).toBe(true)
    expect(await redemptions(api, link.id)).toBe(1)
  })

  it('a guest who already joined gets the same refusal while the board is in the trash, and joins again after the restore', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    await bob.req('POST', `/api/boards/${board}/trash`)
    const again = await joinRequest(api, tokenOf(link.url), {}, { cookie: sam.cookie })
    expect(again.statusCode, again.body).toBe(409)
    expect(errorCode(again)).toBe(BOARD_IN_TRASH.code)
    expect(again.cookies.find((c) => c.name === 'dr_session')).toBeUndefined()
    await bob.req('POST', `/api/boards/${board}/restore`)
    expect((await joinRequest(api, tokenOf(link.url), {}, { cookie: sam.cookie })).statusCode).toBe(200)
  })

  it('an archived board is still joinable (it is read-only, not gone)', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board)
    expect((await bob.req('POST', `/api/boards/${board}/archive`)).statusCode).toBe(200)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    expect(sam.joined.boardId).toBe(board)
  })
})
