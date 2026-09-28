// Joining a guest link with just a name (docs/WAVE3-CONTRACTS.md §2 guests): who the guest is, the
// redemption it shares with accepting, the session's end, and the abuse limits.
import {
  BoardGuests,
  GUEST_SESSION_MAX_MS,
  GUESTS_PER_LINK,
  GuestJoined,
  InvitationGuestAccess,
  InvitationPreview,
  ListInvitationsResponse,
  ListMembersResponse,
  Me,
  MeKind,
  TicketResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEV_STUDIO } from '../../helpers.ts'
import {
  boardRole,
  clientFor,
  cookieOf,
  errorCode,
  freshIp,
  guestLink,
  joinAsGuest,
  joinRequest,
  setupWorld,
  tokenOf,
  type World,
} from './support.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

describe('joining a guest link', () => {
  it('creates a guest with no account: the link’s role on this board, a guest membership, kind "guest" and the marker on the name', async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board, { role: 'commenter' })
    expect(link.allowGuests).toBe(true)
    const before = api.notifications.length
    const sam = await joinAsGuest(api, link.url, '  Sam Rivera  ')
    expect(sam.joined).toMatchObject({
      workspaceId: DEV_STUDIO,
      boardId: board,
      created: true,
      user: { name: 'Sam Rivera (guest)' },
    })
    // The raw name is stored as typed (trimmed); users.name carries the display marker.
    const row = await api.db.one<{ name: string; guest_name: string; kind: string; handle: string | null }>(
      'SELECT name, guest_name, kind, handle FROM users WHERE id = $1',
      [sam.userId],
    )
    expect(row).toEqual({ name: 'Sam Rivera (guest)', guest_name: 'Sam Rivera', kind: 'guest', handle: null })
    expect(
      (
        await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM identities WHERE user_id = $1', [
          sam.userId,
        ])
      ).n,
    ).toBe(0)

    const meRes = await sam.req('GET', '/api/me')
    expect(meRes.statusCode).toBe(200)
    const me = Me.parse(meRes.json())
    expect(MeKind.parse(meRes.json()).kind).toBe('guest')
    expect(me.user.name).toBe('Sam Rivera (guest)')
    expect(me.workspaces).toEqual([{ id: DEV_STUDIO, name: 'Dev Studio', role: 'guest' }])
    expect(await boardRole(sam, board)).toBe('commenter')
    // Same redemption as accept: the link counts the use, sync is told.
    const [listed] = ListInvitationsResponse.parse(
      (await bob.req('GET', `/api/boards/${board}/invitations`)).json(),
    ).invitations
    expect(listed).toMatchObject({ id: link.id, uses: 1, allowGuests: true })
    expect(api.notifications.slice(before)).toContainEqual({ boardId: board, userId: sam.userId })

    // The marker reaches every name: the sync ticket (cursor label, people list) and member lists.
    const ticket = TicketResponse.parse((await sam.req('POST', `/api/boards/${board}/ticket`)).json())
    expect(ticket).toMatchObject({ role: 'commenter', user: { id: sam.userId, name: 'Sam Rivera (guest)' } })
    const members = ListMembersResponse.parse((await bob.req('GET', `/api/boards/${board}/members`)).json())
    expect(members.members.find((m) => m.user.id === sam.userId)?.user.name).toBe('Sam Rivera (guest)')
  })

  it('a commenter guest can comment; the comment shows the marker', async () => {
    const { api, bob, board } = w
    const sam = await joinAsGuest(api, (await guestLink(bob, board, { role: 'commenter' })).url, 'Sam')
    const res = await sam.req('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 10, y: 20 },
      body: 'Looks good',
    })
    expect(res.statusCode, res.body).toBe(201)
    const thread = (res.json() as { thread: { comments: { author: { id: string; name: string } }[] } }).thread
    expect(thread.comments[0]?.author).toMatchObject({ id: sam.userId, name: 'Sam (guest)' })
  })

  it('GET /api/boards/:bid/guests lists the guests on the board, for anyone who can view it (404 otherwise)', async () => {
    const { api, bob, carol, board } = w
    const sam = await joinAsGuest(api, (await guestLink(bob, board)).url, 'Sam')
    const list = async (c: { req: typeof bob.req }) => {
      const res = await c.req('GET', `/api/boards/${board}/guests`)
      return { status: res.statusCode, body: res.statusCode === 200 ? BoardGuests.parse(res.json()) : null }
    }
    expect(await list(bob)).toEqual({ status: 200, body: { userIds: [sam.userId] } })
    expect(await list(sam)).toEqual({ status: 200, body: { userIds: [sam.userId] } })
    expect((await list(carol)).status).toBe(404) // no access to the board
  })

  it('accounts read as kind "account"; the database keeps the marker on a guest’s name', async () => {
    const { api, bob, board } = w
    expect(MeKind.parse((await bob.req('GET', '/api/me')).json()).kind).toBe('account')
    const sam = await joinAsGuest(api, (await guestLink(bob, board)).url, 'Sam')
    await expect(
      api.db.query("UPDATE users SET name = 'Bob Chen' WHERE id = $1", [sam.userId]),
    ).rejects.toThrow()
    await expect(
      api.db.query("UPDATE users SET handle = 'bob2' WHERE id = $1", [sam.userId]),
    ).rejects.toThrow()
    await expect(
      api.db.query("UPDATE users SET kind = 'account' WHERE id = $1", [sam.userId]),
    ).rejects.toThrow()
  })

  it('the preview says whether guests may join; only multi-use links can allow them', async () => {
    const { api, bob, board } = w
    const withGuests = await guestLink(bob, board)
    const without = await guestLink(bob, board, { allowGuests: false })
    const preview = async (url: string) => {
      const res = await api.anon('GET', `/api/invitations/${tokenOf(url)}`)
      expect(res.statusCode).toBe(200)
      InvitationPreview.parse(res.json())
      return InvitationGuestAccess.parse(res.json()).allowGuests
    }
    expect(await preview(withGuests.url)).toBe(true)
    expect(await preview(without.url)).toBe(false)
    expect(without.allowGuests).toBe(false)
    // The flag cannot be set on a single-use invitation.
    const single = await bob.req('POST', `/api/boards/${board}/invitations`, { role: 'viewer' })
    const singleId = (single.json() as { id: string }).id
    await expect(
      api.db.query('UPDATE invitations SET allow_guests = true WHERE id = $1', [singleId]),
    ).rejects.toThrow()
  })

  it('the session ends with the link: a workshop link’s 3 h, a review link’s at most 7 days', async () => {
    const { api, bob, board } = w
    const workshop = await guestLink(bob, board, { role: 'editor' })
    const res = await joinRequest(api, tokenOf(workshop.url), { name: 'Wes' }, { ip: freshIp() })
    expect(res.statusCode, res.body).toBe(201)
    const joined = GuestJoined.parse(res.json())
    expect(joined.sessionExpiresAt).toBe(workshop.expiresAt)
    // The server's session ends with the link; the cookie is kept as long as the link could be
    // extended to (24 h for a workshop link), so an extension does not sign the guest out.
    const stored = await api.db.one<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE user_id = $1',
      [joined.user.id],
    )
    expect(stored.expires_at.toISOString()).toBe(workshop.expiresAt)
    const cookie = cookieOf(res)
    expect(cookie?.maxAge).toBeGreaterThan((24 * HOUR) / 1000 - 60)
    expect(cookie?.maxAge).toBeLessThanOrEqual((24 * HOUR) / 1000)

    const review = await guestLink(bob, board, { role: 'viewer' }) // 14 days by default
    const rita = await joinAsGuest(api, review.url, 'Rita')
    const ends = Date.parse(rita.joined.sessionExpiresAt) - Date.now()
    expect(ends).toBeGreaterThan(GUEST_SESSION_MAX_MS - 60_000)
    expect(ends).toBeLessThanOrEqual(GUEST_SESSION_MAX_MS)

    // Past its end the guest is signed out.
    const wes = clientFor(api, `dr_session=${cookie?.value}`, joined.user.id, joined)
    expect((await wes.req('GET', '/api/me')).statusCode).toBe(200)
    api.clock.advance(3 * HOUR + 1_000)
    expect((await wes.req('GET', '/api/me')).statusCode).toBe(401)
    api.clock.advance(7 * DAY)
    expect((await rita.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('extending a workshop link ("+1 h") keeps its guests signed in until the new end', async () => {
    const { api, bob, board } = w
    const workshop = await guestLink(bob, board, { role: 'editor' })
    const wes = await joinAsGuest(api, workshop.url, 'Wes')
    // Someone with an account joins through the same link: only guest sessions follow the link.
    const erinAccept = await w.erin.req('POST', `/api/invitations/${tokenOf(workshop.url)}/accept`)
    expect(erinAccept.statusCode).toBe(200)
    const res = await bob.req('POST', `/api/boards/${board}/review-links/${workshop.id}/extend`, { hours: 1 })
    expect(res.statusCode, res.body).toBe(200)
    const extended = (res.json() as { expiresAt: string }).expiresAt
    const stored = await api.db.one<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE user_id = $1',
      [wes.userId],
    )
    expect(stored.expires_at.toISOString()).toBe(extended)
    // Account sessions are untouched (30 days).
    const erins = await api.db.one<{ expires_at: Date }>(
      'SELECT max(expires_at) AS expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [w.erin.userId],
    )
    expect(erins.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * DAY)
    api.clock.advance(3 * HOUR + 1_000)
    expect((await wes.req('GET', '/api/me')).statusCode).toBe(200)
    expect(await boardRole(wes, board)).toBe('editor')
    api.clock.advance(HOUR)
    expect((await wes.req('GET', '/api/me')).statusCode).toBe(401)
  })

  it('a signed-in guest who opens a second guest link gets that grant on the same guest user', async () => {
    const { api, bob, board } = w
    const second = await (async () => {
      const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'Workshop' })
      return (res.json() as { id: string }).id
    })()
    const review = await guestLink(bob, board, { role: 'viewer' })
    const workshop = await guestLink(bob, second, { role: 'editor' })
    const sam = await joinAsGuest(api, review.url, 'Sam')
    // Joining again: no name needed (and a name is ignored), no new user.
    const res = await joinRequest(
      api,
      tokenOf(workshop.url),
      { name: 'Someone else' },
      { cookie: sam.cookie },
    )
    expect(res.statusCode, res.body).toBe(200)
    const again = GuestJoined.parse(res.json())
    expect(again).toMatchObject({
      created: false,
      boardId: second,
      user: { id: sam.userId, name: 'Sam (guest)' },
    })
    expect(await boardRole(sam, board)).toBe('viewer')
    expect(await boardRole(sam, second)).toBe('editor')
    // The workshop link ends sooner than the session (7 days): the session is kept.
    expect(cookieOf(res)).toBeUndefined()
    expect(again.sessionExpiresAt).toBe(sam.joined.sessionExpiresAt)
    expect(
      (await api.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE kind = 'guest'")).n,
    ).toBe(1)
  })

  it('a signed-in guest whose session ends sooner than the new link gets a longer session (the old one ends)', async () => {
    const { api, bob, board } = w
    const second = (
      (await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'Later' })).json() as {
        id: string
      }
    ).id
    const workshop = await guestLink(bob, board, { role: 'editor' }) // 3 h
    const review = await guestLink(bob, second, { role: 'commenter' }) // 14 days
    const sam = await joinAsGuest(api, workshop.url, 'Sam')
    const res = await joinRequest(api, tokenOf(review.url), {}, { cookie: sam.cookie })
    expect(res.statusCode, res.body).toBe(200)
    const fresh = cookieOf(res)
    expect(fresh?.value).toBeTruthy()
    expect((await sam.req('GET', '/api/me')).statusCode).toBe(401) // the old session ended
    const renewed = clientFor(api, `dr_session=${fresh?.value}`, sam.userId, sam.joined)
    expect(await boardRole(renewed, second)).toBe('commenter')
    expect(await boardRole(renewed, board)).toBe('editor')
  })

  it('validates the name: 1-40 characters after trimming, no control or bidi characters', async () => {
    const { api, bob, board } = w
    const token = tokenOf((await guestLink(bob, board)).url)
    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(41) },
      { name: 'Sam\u0000' },
      { name: 'Sam\nRivera' },
      { name: `Sam${String.fromCodePoint(0x202e)}admin` },
      { name: 42 },
    ]) {
      const res = await joinRequest(api, token, body, { ip: freshIp() })
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    // 40 characters (code points, so an emoji is one) is fine.
    const ok = await joinRequest(api, token, { name: `${'a'.repeat(38)}🎨b` }, { ip: freshIp() })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(
      (await api.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE kind = 'guest'")).n,
    ).toBe(1)
  })

  it('refuses links that do not allow guests (403), unknown tokens (404), closed links (410) and cross-site posts', async () => {
    const { api, bob, board } = w
    const noGuests = await guestLink(bob, board, { allowGuests: false })
    const res = await joinRequest(api, tokenOf(noGuests.url), { name: 'Sam' }, { ip: freshIp() })
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('GUESTS_NOT_ALLOWED')
    // A single-use board invitation or a workspace invitation never lets guests in.
    const single = (await bob.req('POST', `/api/boards/${board}/invitations`, { role: 'viewer' })).json() as {
      url: string
    }
    expect(errorCode(await joinRequest(api, tokenOf(single.url), { name: 'Sam' }, { ip: freshIp() }))).toBe(
      'GUESTS_NOT_ALLOWED',
    )
    const ws = (
      await w.alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role: 'member' })
    ).json() as {
      url: string
    }
    expect(errorCode(await joinRequest(api, tokenOf(ws.url), { name: 'Sam' }, { ip: freshIp() }))).toBe(
      'GUESTS_NOT_ALLOWED',
    )
    expect((await joinRequest(api, 'A'.repeat(43), { name: 'Sam' }, { ip: freshIp() })).statusCode).toBe(404)
    expect((await joinRequest(api, 'not-a-token', { name: 'Sam' }, { ip: freshIp() })).statusCode).toBe(404)

    const revoked = await guestLink(bob, board)
    expect(
      (await bob.req('POST', `/api/boards/${board}/review-links/${revoked.id}/revoke`, {})).statusCode,
    ).toBe(200)
    expect(
      (await joinRequest(api, tokenOf(revoked.url), { name: 'Sam' }, { ip: freshIp() })).statusCode,
    ).toBe(410)
    const capped = await guestLink(bob, board, { maxUses: 1 })
    await joinAsGuest(api, capped.url, 'First')
    expect(
      (await joinRequest(api, tokenOf(capped.url), { name: 'Second' }, { ip: freshIp() })).statusCode,
    ).toBe(410)
    const expiring = await guestLink(bob, board, { role: 'editor' })
    api.clock.advance(3 * HOUR + 1_000)
    expect(
      (await joinRequest(api, tokenOf(expiring.url), { name: 'Late' }, { ip: freshIp() })).statusCode,
    ).toBe(410)
    api.clock.advance(-(3 * HOUR + 1_000))

    const open = await guestLink(bob, board)
    const crossSite = await joinRequest(
      api,
      tokenOf(open.url),
      { name: 'Sam' },
      { ip: freshIp(), origin: null },
    )
    expect(crossSite.statusCode).toBe(403)
    expect(
      await api.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE kind = 'guest'"),
    ).toEqual({ n: 1 }) // only "First"
  })

  it('someone signed in with an account is told to accept instead (409 SIGNED_IN)', async () => {
    const { erin, bob, board } = w
    const link = await guestLink(bob, board)
    const res = await erin.req('POST', `/api/invitations/${tokenOf(link.url)}/guest`, { name: 'Erin' })
    expect(res.statusCode).toBe(409)
    expect(errorCode(res)).toBe('SIGNED_IN')
    expect(await boardRole(erin, board)).toBeNull()
    // Accepting with the account still works on a guest link.
    expect((await erin.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)).statusCode).toBe(200)
    expect(await boardRole(erin, board)).toBe('commenter')
  })

  it('limits new guests per client IP (10 per 10 minutes); other addresses are not affected', async () => {
    const { api, bob, board } = w
    const token = tokenOf((await guestLink(bob, board)).url)
    for (let i = 0; i < 10; i++)
      expect((await joinRequest(api, token, { name: `Guest ${i}` }, { ip: '10.1.1.1' })).statusCode).toBe(201)
    const refused = await joinRequest(api, token, { name: 'One too many' }, { ip: '10.1.1.1' })
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBeTruthy()
    expect((await joinRequest(api, token, { name: 'Elsewhere' }, { ip: '10.1.1.2' })).statusCode).toBe(201)
    api.clock.advance(10 * 60_000 + 1_000)
    expect((await joinRequest(api, token, { name: 'Later' }, { ip: '10.1.1.1' })).statusCode).toBe(201)
  })

  it(`lets at most ${GUESTS_PER_LINK} guests in through one link; guests already on it can come back`, async () => {
    const { api, bob, board } = w
    const link = await guestLink(bob, board)
    const first = await joinAsGuest(api, link.url, 'First')
    // Seed the rest of the cap directly (the join route itself is covered above).
    await api.db.query(
      `WITH g AS (
         INSERT INTO users (id, name, color, kind, guest_name)
         SELECT 'usr_seedguest' || lpad(n::text, 6, '0'), 'G' || n || ' (guest)', '#1d4ed8', 'guest', 'G' || n
           FROM generate_series(1, $1::int) AS n
         RETURNING id)
       INSERT INTO invitation_redemptions (invitation_id, workspace_id, board_id, user_id, redeemed_at)
       SELECT $2, $3, $4, g.id, now() FROM g`,
      [GUESTS_PER_LINK - 1, link.id, DEV_STUDIO, board],
    )
    const full = await joinRequest(api, tokenOf(link.url), { name: 'One more' }, { ip: freshIp() })
    expect(full.statusCode).toBe(409)
    expect(errorCode(full)).toBe('GUEST_LIMIT')
    const back = await joinRequest(api, tokenOf(link.url), {}, { cookie: first.cookie })
    expect(back.statusCode, back.body).toBe(200)
    // People with an account still accept the link (the cap is for guests).
    expect((await w.erin.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)).statusCode).toBe(200)
  })
})
