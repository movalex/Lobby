// Adversarial review of name-only guests (docs/WAVE3-CONTRACTS.md §2 guests): the abuse limits under
// concurrency and through the other redemption route, HEAD requests against the refusal list, and a
// guest editor reorganising the workspace's projects.
import { GUEST_JOINS_PER_ADDRESS, GUEST_JOINS_PER_LINK, GUESTS_PER_LINK } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import {
  boardRole,
  errorCode,
  guestLink,
  joinAsGuest,
  joinRequest,
  setupWorld,
  tokenOf,
  type World,
} from './support.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const guestCount = async () =>
  (await w.api.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE kind = 'guest'")).n

/** Fills `invitationId` up to the per-link guest cap with seeded guests (no sessions needed). */
async function fillLink(invitationId: string, boardId: string, n = GUESTS_PER_LINK) {
  await w.api.db.query(
    `WITH g AS (
       INSERT INTO users (id, name, color, kind, guest_name)
       SELECT 'usr_fillguest' || lpad(n::text, 7, '0'), 'F' || n || ' (guest)', '#1d4ed8', 'guest', 'F' || n
         FROM generate_series(1, $1::int) AS n
       RETURNING id)
     INSERT INTO invitation_redemptions (invitation_id, workspace_id, board_id, user_id, redeemed_at)
     SELECT $2, $3, $4, g.id, now() FROM g`,
    [n, invitationId, DEV_STUDIO, boardId],
  )
}

describe('abuse limits cannot be side-stepped', () => {
  /** In-process PGlite answers at once; a networked Postgres takes a moment per transaction, which is
   * when simultaneous requests overlap. Simulate that latency. */
  function slowTransactions() {
    const db = w.api.db as unknown as { transaction: (fn: unknown) => Promise<unknown> }
    const transaction = db.transaction.bind(db)
    db.transaction = async (fn) => {
      await new Promise((r) => setTimeout(r, 25))
      return transaction(fn)
    }
  }

  it(`a burst of simultaneous joins from one address still lets in at most ${GUEST_JOINS_PER_ADDRESS.max} new guests`, async () => {
    // Two links, so the per-link rate is not what stops the burst (two review links: a workshop link has windows of
    // its own, wave V R1, join-burst.test.ts).
    const tokens = [
      tokenOf((await guestLink(w.bob, w.board)).url),
      tokenOf((await guestLink(w.bob, w.board, { role: 'viewer' })).url),
    ]
    slowTransactions()
    const total = GUEST_JOINS_PER_ADDRESS.max + 10
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        joinRequest(w.api, tokens[i % 2] ?? '', { name: `Burst ${i}` }, { ip: '10.7.7.7' }),
      ),
    )
    const created = results.filter((r) => r.statusCode === 201).length
    expect(created).toBeLessThanOrEqual(GUEST_JOINS_PER_ADDRESS.max)
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(total - created)
    expect(await guestCount()).toBe(created)
  })

  it(`a burst of simultaneous joins on one link, from many addresses, lets in at most ${GUEST_JOINS_PER_LINK.max} new guests`, async () => {
    const token = tokenOf((await guestLink(w.bob, w.board)).url)
    slowTransactions()
    const total = GUEST_JOINS_PER_LINK.max + 10
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        joinRequest(
          w.api,
          token,
          { name: `Crowd ${i}` },
          { ip: `10.8.${Math.floor(i / 200)}.${(i % 200) + 1}` },
        ),
      ),
    )
    const created = results.filter((r) => r.statusCode === 201).length
    expect(created).toBe(GUEST_JOINS_PER_LINK.max) // the link's row lock orders them: exactly the rate
    const refused = results.filter((r) => r.statusCode === 429)
    expect(refused).toHaveLength(total - created)
    for (const r of refused) expect(errorCode(r)).toBe('RATE_LIMITED')
    expect(await guestCount()).toBe(created)
  })

  it('addresses in one IPv6 /64 share the per-address limit (a client picks any address in its /64)', async () => {
    // two review links (a workshop link has windows of its own: join-burst.test.ts)
    const tokens = [
      tokenOf((await guestLink(w.bob, w.board)).url),
      tokenOf((await guestLink(w.bob, w.board, { role: 'viewer' })).url),
    ]
    for (let i = 0; i < GUEST_JOINS_PER_ADDRESS.max; i++) {
      const res = await joinRequest(
        w.api,
        tokens[i % 2] ?? '',
        { name: `V6 ${i}` },
        { ip: `2001:db8:1:2::${(i + 1).toString(16)}` },
      )
      expect(res.statusCode, res.body).toBe(201)
    }
    const token = tokens[0] ?? ''
    const same64 = await joinRequest(w.api, token, { name: 'Rotated' }, { ip: '2001:db8:1:2:ffff:1:2:3' })
    expect(same64.statusCode).toBe(429)
    // Another /64 (another customer) is not affected.
    expect(
      (await joinRequest(w.api, token, { name: 'Next door' }, { ip: '2001:db8:1:3::1' })).statusCode,
    ).toBe(201)
  })

  it('a signed-in guest accepting a full guest link through /accept is held to the per-link cap too', async () => {
    const full = await guestLink(w.bob, w.board)
    await fillLink(full.id, w.board)
    const second = await createBoard(w.bob, DEV_STUDIO, 'Elsewhere')
    const sam = await joinAsGuest(w.api, (await guestLink(w.bob, second)).url, 'Sam')
    const res = await sam.req('POST', `/api/invitations/${tokenOf(full.url)}/accept`)
    expect(res.statusCode, res.body).toBe(409)
    expect(errorCode(res)).toBe('GUEST_LIMIT')
    expect(await boardRole(sam, w.board)).toBeNull()
    // Through /guest the answer is the same.
    const viaGuest = await joinRequest(w.api, tokenOf(full.url), {}, { cookie: sam.cookie })
    expect(errorCode(viaGuest)).toBe('GUEST_LIMIT')
    // People with an account are not counted against it.
    expect((await w.erin.req('POST', `/api/invitations/${tokenOf(full.url)}/accept`)).statusCode).toBe(200)
  })
})

describe('the marker survives short labels', () => {
  it('the sync ticket (cursor labels, the people list) shortens a long guest name, never the marker', async () => {
    const url = (await guestLink(w.bob, w.board)).url
    const ticketName = async (name: string) => {
      const guest = await joinAsGuest(w.api, url, name)
      const res = await guest.req('POST', `/api/boards/${w.board}/ticket`)
      expect(res.statusCode, res.body).toBe(200)
      return { ticket: (res.json() as { user: { name: string } }).user.name, joined: guest.joined.user.name }
    }
    // Short names are untouched.
    expect(await ticketName('Sam')).toEqual({ ticket: 'Sam (guest)', joined: 'Sam (guest)' })
    expect(await ticketName('Sam Rivera')).toEqual({
      ticket: 'Sam Rivera (guest)',
      joined: 'Sam Rivera (guest)',
    })
    // A long one is cut before the marker (everywhere else the full name shows).
    expect(await ticketName('Chase Boyajian')).toEqual({
      ticket: 'Chase B… (guest)',
      joined: 'Chase Boyajian (guest)',
    })
    // Invisible wide fillers cannot push the marker out either.
    const filler = String.fromCodePoint(0x3164)
    const padded = await ticketName(`Chase${filler.repeat(20)}x`)
    expect(padded.ticket.endsWith('… (guest)')).toBe(true)
    expect([...padded.ticket].length).toBeLessThan(20)
    // An account's name is never changed.
    const bobTicket = (await w.bob.req('POST', `/api/boards/${w.board}/ticket`)).json() as {
      user: { name: string }
    }
    const bobMe = (await w.bob.req('GET', '/api/me')).json() as { user: { name: string } }
    expect(bobTicket.user.name).toBe(bobMe.user.name)
  })
})

describe('a guest id from another workspace tells a board owner nothing', () => {
  it('adding it, making it an owner or transferring to it answers 404 like any outsider (not 409)', async () => {
    // Erin's own workspace, with a guest who never came near Dev Studio.
    const erinsBoard = await createBoard(w.erin, w.erin.personalWorkspaceId, 'Erin’s board')
    const stranger = await joinAsGuest(w.api, (await guestLink(w.erin, erinsBoard)).url, 'Stranger')
    for (const target of [stranger.userId, w.erin.userId]) {
      for (const role of ['viewer', 'owner']) {
        const res = await w.bob.req('PUT', `/api/boards/${w.board}/members/${target}`, { role })
        expect(res.statusCode, `${target} ${role}: ${res.body}`).toBe(404)
      }
      const transfer = await w.bob.req('POST', `/api/boards/${w.board}/transfer-ownership`, {
        userId: target,
      })
      expect(transfer.statusCode, `${target}: ${transfer.body}`).toBe(404)
    }
  })
})

describe('the refusal list covers every way to call a route', () => {
  it('HEAD on a refused GET route is refused as well (even for a guest holding an owner grant)', async () => {
    const sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board)).url, 'Sam')
    // A legacy owner grant (guests cannot be made owners through the API): the M1 checks would pass.
    await w.api.db.query("UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2", [
      w.board,
      sam.userId,
    ])
    for (const url of [
      `/api/boards/${w.board}/invitations`,
      `/api/boards/${w.board}/sharing/members`,
      `/api/boards/${w.board}/access-requests`,
      `/api/workspaces/${DEV_STUDIO}/members`,
      `/api/workspaces/${DEV_STUDIO}/projects`,
    ]) {
      const res = await w.api.app.inject({ method: 'HEAD', url, headers: { cookie: sam.cookie } })
      expect(res.statusCode, `HEAD ${url}`).toBe(403)
    }
  })

  it('a guest holding an owner grant cannot open the board to the workspace (that hands out access)', async () => {
    const sam = await joinAsGuest(w.api, (await guestLink(w.bob, w.board)).url, 'Sam')
    await w.api.db.query("UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2", [
      w.board,
      sam.userId,
    ])
    const res = await sam.req('PATCH', `/api/boards/${w.board}`, { visibility: 'workspace_edit' })
    expect(res.statusCode, res.body).toBe(403)
    expect(errorCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect(await boardRole(w.carol, w.board)).toBeNull()
  })

  it('a guest editor cannot move the board between projects (they cannot see projects); renaming works', async () => {
    const project = (
      (await w.bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Clients' })).json() as {
        id: string
      }
    ).id
    expect((await w.bob.req('PATCH', `/api/boards/${w.board}`, { projectId: project })).statusCode).toBe(200)
    const wes = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'Wes')
    const moved = await wes.req('PATCH', `/api/boards/${w.board}`, { projectId: null })
    expect(moved.statusCode, moved.body).toBe(403)
    expect(errorCode(moved)).toBe('GUEST_ACCOUNT_REQUIRED')
    const after = (await w.bob.req('GET', `/api/boards/${w.board}`)).json() as {
      board: { projectId: string }
    }
    expect(after.board.projectId).toBe(project)
    const renamed = await wes.req('PATCH', `/api/boards/${w.board}`, { title: 'Renamed by Wes' })
    expect(renamed.statusCode, renamed.body).toBe(200)
  })
})
