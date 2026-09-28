// GET /api/boards/:bid/events under attack (docs/SECURITY-REVIEW-2026-09-27.md):
// - authz-003: one viewer (a review-link guest) must not be able to take every stream slot of a
//   board; per-user caps replace the same person's oldest stream, opens are rate limited per user.
// - authz-005: revocation reaches open streams at once (the EventHub access-changed hook, called
//   wherever the sync server is told), logout ends that session's streams, and the periodic check
//   (at most 10 s) re-validates the session as well as board access.

import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../src/events/hub.ts'
import { ACCESS_RECHECK_MS } from '../src/events/routes.ts'
import { type Client, createBoard, createTestApi, type TestApi } from './helpers.ts'
import { listen, openSse, type SseStream, until } from './sse.ts'

let api: TestApi | undefined
const streams: SseStream[] = []
afterEach(async () => {
  for (const s of streams.splice(0)) await s.close()
  await api?.close()
  api = undefined
})

const HOUR = 60 * 60 * 1000

async function world(opts: { hub?: EventHub; limits?: Record<string, unknown> } = {}) {
  const hub = opts.hub ?? new EventHub()
  const t = await createTestApi({ deps: { events: hub, ...(opts.limits ? { limits: opts.limits } : {}) } })
  api = t
  const owner = await t.login('owner')
  const boardId = await createBoard(owner, owner.personalWorkspaceId, 'Client review')
  const base = await listen(t)
  const open = async (c: Client, bid = boardId) => {
    const s = await openSse(base, bid, c.cookie)
    streams.push(s)
    return s
  }
  /** An outsider who joined through a view-only review link (a workspace guest with a viewer grant). */
  const reviewGuest = async (handle: string) => {
    const link = await owner.req('POST', `/api/boards/${boardId}/review-links`, { role: 'viewer' })
    expect(link.statusCode).toBe(201)
    const token = (link.json() as { url: string }).url.split('/').pop() ?? ''
    const guest = await t.login(handle)
    const accepted = await guest.req('POST', `/api/invitations/${token}/accept`)
    expect(accepted.statusCode).toBe(200)
    return { guest, linkId: (link.json() as { id: string }).id }
  }
  return { t, hub, owner, boardId, base, open, reviewGuest }
}

describe('authz-003: one viewer cannot lock a board’s event stream', () => {
  it('a review-link guest opening many streams keeps at most 5 (their oldest are replaced), and the owner still connects', async () => {
    const w = await world()
    const { guest } = await w.reviewGuest('guest')
    const mine: SseStream[] = []
    for (let i = 0; i < 8; i++) {
      const s = await w.open(guest)
      expect(s.status).toBe(200)
      await s.waitFor('hello')
      mine.push(s)
    }
    await until(() => w.hub.userStreamCount(guest.userId, w.boardId) === 5, 3_000, 'guest capped at 5')
    // The three oldest were ended by the server with 'replaced' and a long reconnect delay.
    for (const s of mine.slice(0, 3)) {
      await s.waitEnded()
      expect((await s.waitFor('replaced')).data).toBeNull()
      expect(s.retries).toEqual([60_000])
    }
    for (const s of mine.slice(3)) expect(s.ended()).toBe(false)

    const ownerStream = await w.open(w.owner)
    expect(ownerStream.status).toBe(200)
    expect((await ownerStream.waitFor('hello')).data).toMatchObject({ role: 'owner' })
  })

  it('a board at its cap refuses newcomers with 503 (never pushing anyone out), and one user cannot fill it', async () => {
    const w = await world({ hub: new EventHub({ limits: { perBoard: 6 } }) })
    const { guest } = await w.reviewGuest('guest')
    for (let i = 0; i < 10; i++) await (await w.open(guest)).waitFor('hello')
    await until(() => w.hub.userStreamCount(guest.userId, w.boardId) === 5)
    // The guest holds 5 of 6 slots: the owner still gets the sixth.
    const ownerStream = await w.open(w.owner)
    await ownerStream.waitFor('hello')
    const { guest: other } = await w.reviewGuest('other')
    const refused = await w.open(other)
    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBe('30')
    expect(refused.body).toEqual({ error: { code: 'TOO_MANY_SUBSCRIBERS', message: expect.any(String) } })
    expect(ownerStream.ended()).toBe(false)
  })

  it('rate-limits stream opens per signed-in user (429 + Retry-After); other people are not affected', async () => {
    const w = await world({ limits: { streamOpens: { max: 3, timeWindow: 60_000 } } })
    const { guest } = await w.reviewGuest('guest')
    const codes: number[] = []
    for (let i = 0; i < 5; i++) {
      const s = await w.open(guest)
      codes.push(s.status)
      if (s.status === 200) await s.close()
    }
    expect(codes).toEqual([200, 200, 200, 429, 429])
    const last = await w.open(guest)
    expect(last.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await w.open(w.owner)).status).toBe(200)
    // The window passes: the guest may open again.
    w.t.clock.advance(61_000)
    expect((await w.open(guest)).status).toBe(200)
  })
})

describe('authz-005: revoked people stop receiving board events at once', () => {
  it('removing a member ends their stream immediately (no periodic check needed); comments posted after never reach them', async () => {
    const w = await world({ limits: { streamRecheckMs: HOUR } })
    const carol = await w.t.login('carol')
    // carol must be a workspace member for an explicit grant; the owner's personal workspace has
    // none, so she comes in as a guest through a board invitation.
    const inv = await w.owner.req('POST', `/api/boards/${w.boardId}/invitations`, { role: 'viewer' })
    const token = (inv.json() as { url: string }).url.split('/').pop() ?? ''
    expect((await carol.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    const s = await w.open(carol)
    await s.waitFor('hello')

    const removed = await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${carol.userId}`)
    expect(removed.statusCode).toBe(200)
    await s.waitFor('access-lost', 2_000)
    await s.waitEnded()
    const posted = await w.owner.req('POST', `/api/boards/${w.boardId}/threads`, {
      anchor: { kind: 'point', x: 0, y: 0 },
      body: 'Internal: the client must not see this',
    })
    expect(posted.statusCode).toBe(201)
    await new Promise((r) => setTimeout(r, 100))
    expect(s.events.map((e) => e.type)).toEqual(['hello', 'access-lost'])
    expect(w.hub.userStreamCount(carol.userId)).toBe(0)
  })

  it('revoking a review link with "remove access" ends its guests’ streams at once', async () => {
    const w = await world({ limits: { streamRecheckMs: HOUR } })
    const { guest, linkId } = await w.reviewGuest('guest')
    const s = await w.open(guest)
    await s.waitFor('hello')
    const ownerStream = await w.open(w.owner)
    await ownerStream.waitFor('hello')
    const revoked = await w.owner.req('POST', `/api/boards/${w.boardId}/review-links/${linkId}/revoke`, {
      removeAccess: true,
    })
    expect(revoked.statusCode).toBe(200)
    await s.waitFor('access-lost', 2_000)
    expect(ownerStream.ended()).toBe(false)
  })

  it('making a board private ends the streams of people who only had workspace access (board-wide change)', async () => {
    const w = await world({ limits: { streamRecheckMs: HOUR } })
    const alice = await w.t.login('alice')
    const bob = await w.t.login('bob')
    // Dev Studio: alice owns it, bob is a member who sees workspace_view boards.
    const studio = alice.me.workspaces.find((x) => x.name === 'Dev Studio')?.id ?? ''
    const boardId = await createBoard(alice, studio, 'Studio board')
    expect(
      (await alice.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    const s = await w.open(bob, boardId)
    await s.waitFor('hello')
    const aliceStream = await w.open(alice, boardId)
    await aliceStream.waitFor('hello')
    expect((await alice.req('PATCH', `/api/boards/${boardId}`, { visibility: 'private' })).statusCode).toBe(
      200,
    )
    await s.waitFor('access-lost', 2_000)
    expect(aliceStream.ended()).toBe(false)
  })

  it('logging out ends that session’s streams at once; the same person’s other session keeps its stream', async () => {
    const w = await world({ limits: { streamRecheckMs: HOUR } })
    const laptop = await w.t.login('dana')
    const phone = await w.t.login('dana') // a second, independent session of the same person
    const studio = laptop.me.workspaces.find((x) => x.name === 'Dev Studio')?.id ?? ''
    const boardId = await createBoard(laptop, studio, 'Dana board')
    const a = await w.open(laptop, boardId)
    const b = await w.open(phone, boardId)
    await a.waitFor('hello')
    await b.waitFor('hello')
    expect((await laptop.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    await a.waitFor('session-ended', 2_000)
    await a.waitEnded()
    expect(b.ended()).toBe(false)
  })

  it('the periodic check re-validates the session: a session revoked outside this process ends its streams', async () => {
    const w = await world({ limits: { streamRecheckMs: 100 } })
    const erin = await w.t.login('erin')
    const studio = erin.me.workspaces.find((x) => x.name === 'Dev Studio')?.id ?? ''
    const boardId = await createBoard(erin, studio, 'Erin board')
    const s = await w.open(erin, boardId)
    await s.waitFor('hello')
    // What an operator's SQL (or another api instance) does: this process's session store never hears of it.
    await w.t.db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [erin.userId])
    await s.waitFor('session-ended', 2_000)
    await s.waitEnded()
  })

  it('the periodic check also ends streams whose board access went away without a notification', async () => {
    const w = await world({ limits: { streamRecheckMs: 100 } })
    const { guest } = await w.reviewGuest('guest')
    const s = await w.open(guest)
    await s.waitFor('hello')
    await w.t.db.query('DELETE FROM board_members WHERE user_id = $1', [guest.userId])
    await s.waitFor('access-lost', 2_000)
  })

  it('a stream that subscribes while a revocation is being applied re-checks itself at once', async () => {
    const hub = new EventHub()
    const w = await world({ hub, limits: { streamRecheckMs: HOUR } })
    const { guest } = await w.reviewGuest('guest')
    const openStream = hub.openStream.bind(hub)
    let raced = false
    hub.openStream = (boardId, handle) => {
      if (!raced && handle.userId === guest.userId) {
        raced = true
        // The removal commits and is announced after this stream's own access check passed but before
        // it was subscribed: the hub had nothing of this person's to re-check.
        void w.t.db.query('DELETE FROM board_members WHERE user_id = $1', [guest.userId])
        hub.accessChanged({ boardId, userId: guest.userId })
      }
      return openStream(boardId, handle)
    }
    const s = await w.open(guest)
    await s.waitFor('access-lost', 2_000)
    expect(s.events.map((e) => e.type)).toEqual(['hello', 'access-lost'])
  })

  it('checks every open stream at least every 10 s', () => {
    expect(ACCESS_RECHECK_MS).toBeLessThanOrEqual(10_000)
  })
})
