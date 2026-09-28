// Ending a guest's access (docs/WAVE3-CONTRACTS.md §2 guests): revoking the link with removal, the
// link expiring and removing the guest from the board end the board through the M1 push; a guest
// session left with no board grant is revoked too. Sign out and sign out everywhere keep working.
import { RevokeAllSessionsResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestSweepSettings } from '../../../src/features/guests/index.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import {
  boardRole,
  guestLink,
  guestSweeper,
  joinAsGuest,
  joinRequest,
  setupWorld,
  sweepLinks,
  tokenOf,
  type World,
} from './support.ts'

const HOUR = 60 * 60 * 1000

let w: World
beforeEach(async () => {
  // These tests run the sweep themselves; the app's timer must not race them (one test below uses it).
  guestSweepSettings.intervalMs = 60 * 60 * 1000
  w = await setupWorld()
})
afterEach(() => w.api.close())

const liveSessions = async (userId: string) =>
  (
    await w.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2',
      [userId, w.api.clock.now()],
    )
  ).n

describe('ending a guest’s access', () => {
  it('revoking the link with removal: the board closes at once (sync is told), and the sweep signs the guest out', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    const before = api.notifications.length
    const res = await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`, {
      removeAccess: true,
    })
    expect(res.json()).toEqual({ removed: 1 })
    expect(api.notifications.slice(before)).toContainEqual({ boardId: board, userId: sam.userId })
    expect(await boardRole(sam, board)).toBeNull()
    const sweep = guestSweeper(w)
    const out = await sweep.run()
    expect(out.signedOut).toEqual([sam.userId])
    expect(sweep.revoked).toHaveLength(1) // announced: the app would end the guest's event streams
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
    // A second pass has nothing left to do.
    expect(await sweep.run()).toEqual({ signedOut: [], removed: [] })
  })

  it('the app’s own sweeper (every 5 s) signs the guest out within seconds', async () => {
    guestSweepSettings.intervalMs = 5_000
    const own = await setupWorld()
    try {
      const { api, bob, board } = own
      const link = await guestLink(bob, board)
      const sam = await joinAsGuest(api, link.url, 'Sam')
      await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`, { removeAccess: true })
      const started = Date.now()
      await vi.waitFor(async () => expect((await sam.req('GET', '/api/me')).statusCode).toBe(401), {
        timeout: 12_000,
        interval: 250,
      })
      expect(Date.now() - started).toBeLessThan(7_000)
    } finally {
      await own.api.close()
    }
  }, 30_000)

  it('the link expiring (the review-link sweeper) removes the grant, then the guest session', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board, { role: 'editor' })
    const sam = await joinAsGuest(api, link.url, 'Wes')
    expect(await boardRole(sam, board)).toBe('editor')
    api.clock.advance(3 * HOUR + 1_000)
    expect(await sweepLinks(w)).toBe(1)
    expect(await boardRole(w.bob, board)).toBe('owner')
    // The session ended with the link anyway (it never outlives it).
    expect(await liveSessions(sam.userId)).toBe(0)
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
    expect(
      (
        await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_members WHERE user_id = $1', [
          sam.userId,
        ])
      ).n,
    ).toBe(0)
  })

  it('removing the guest from their only board signs them out; from one of two boards keeps them in', async () => {
    const { api, bob, board } = w
    const second = await createBoard(bob, DEV_STUDIO, 'Second')
    const sam = await joinAsGuest(api, (await guestLink(bob, board)).url, 'Sam')
    const res = await joinRequest(
      api,
      tokenOf((await guestLink(bob, second)).url),
      {},
      { cookie: sam.cookie },
    )
    expect(res.statusCode).toBe(200)
    const sweep = guestSweeper(w)

    expect((await bob.req('DELETE', `/api/boards/${second}/members/${sam.userId}`)).statusCode).toBe(200)
    expect((await sweep.run()).signedOut).toEqual([])
    expect(await boardRole(sam, board)).toBe('commenter')

    expect((await bob.req('DELETE', `/api/boards/${board}/members/${sam.userId}`)).statusCode).toBe(200)
    expect((await sweep.run()).signedOut).toEqual([sam.userId])
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('a guest who signs out cannot come back as the same guest: the sweep removes their grants', async () => {
    const { api, bob, board } = w
    const sam = await joinAsGuest(api, (await guestLink(bob, board)).url, 'Sam')
    const members = async () =>
      (
        (await bob.req('GET', `/api/boards/${board}/members`)).json() as {
          members: { user: { id: string } }[]
        }
      ).members.map((m) => m.user.id)
    expect(await members()).toContain(sam.userId)
    expect((await sam.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
    const before = api.notifications.length
    const out = await guestSweeper(w).run()
    expect(out.removed).toEqual([{ userId: sam.userId, boardIds: [board] }])
    expect(api.notifications.slice(before)).toContainEqual({ boardId: board, userId: sam.userId })
    expect(await members()).not.toContain(sam.userId)
  })

  it('sign out everywhere works for a guest (no identity provider sessions to end)', async () => {
    const { api, bob, board } = w
    const sam = await joinAsGuest(api, (await guestLink(bob, board)).url, 'Sam')
    const res = await sam.req('POST', '/api/auth/sessions/revoke-all')
    expect(res.statusCode, res.body).toBe(200)
    expect(RevokeAllSessionsResponse.parse(res.json())).toEqual({
      revoked: 1,
      provider: { status: 'none', revoked: 0 },
    })
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('a join that commits while the sweep runs is never undone (the sweep re-checks under the guest’s lock)', async () => {
    const { api, bob, board } = w
    const second = await createBoard(bob, DEV_STUDIO, 'Second')
    const link = await guestLink(bob, board)
    const sam = await joinAsGuest(api, link.url, 'Sam')
    await bob.req('POST', `/api/boards/${board}/review-links/${link.id}/revoke`, { removeAccess: true })
    // Sam still holds a live session and just joined another board before the sweep ran.
    const res = await joinRequest(
      api,
      tokenOf((await guestLink(bob, second)).url),
      {},
      { cookie: sam.cookie },
    )
    expect(res.statusCode, res.body).toBe(200)
    expect((await guestSweeper(w).run()).signedOut).toEqual([])
    expect(await boardRole(sam, second)).toBe('commenter')
  })
})
