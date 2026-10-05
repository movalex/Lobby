// Wave H1: the board event stream straight from the api's own origin (DRAFTROOM_EVENTS_ORIGIN), with a
// short-lived single-use ticket minted same-origin (POST /api/boards/:bid/events/ticket) and presented in
// `Authorization: Bearer`, because Render's static-site rewrite holds a streamed response until it ends.
// The ticketed request runs the cookie request's path as the minting session: same caps, revalidation,
// session ends and guest per-link cap. CORS is exactly PUBLIC_ORIGIN, never credentials. Without the
// setting, and for pages built before H1, nothing changes.
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_TTL_MS } from '../src/auth/session.ts'
import { EventHub } from '../src/events/hub.ts'
import { EVENTS_TICKET_TTL_MS } from '../src/events/tickets.ts'
import { guestLinkCapSettings } from '../src/features/guests/link-caps.ts'
import { HAND_DISCONNECT_GRACE_MS } from '../src/features/workshops/hands.ts'
import { type GuestClient, guestLink, joinAsGuest } from './features/guests/support.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  devEmail,
  ORIGIN,
  type TestApi,
} from './helpers.ts'
import { listen, openSse, openSseAt, type SseStream, until } from './sse.ts'

const EVENTS_ORIGIN = 'https://api.events.test'
const HOUR = 60 * 60 * 1000

let api: TestApi | undefined
const streams: SseStream[] = []
const capDefaults = structuredClone(guestLinkCapSettings)
afterEach(async () => {
  for (const s of streams.splice(0)) await s.close()
  Object.assign(guestLinkCapSettings, structuredClone(capDefaults))
  await api?.close()
  api = undefined
})

interface Minted {
  url: string
  ticket: string
  expiresAt: string
}

async function world(
  opts: { eventsOrigin?: string | null; limits?: Record<string, unknown>; logs?: string[] } = {},
) {
  const hub = new EventHub()
  const origin = opts.eventsOrigin === undefined ? EVENTS_ORIGIN : opts.eventsOrigin
  const logs = opts.logs
  const t = await createTestApi({
    env: origin ? { DRAFTROOM_EVENTS_ORIGIN: origin } : {},
    deps: {
      events: hub,
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(logs ? { logger: { level: 'trace', stream: { write: (l: string) => void logs.push(l) } } } : {}),
    },
  })
  api = t
  const owner = await t.login('owner')
  const boardId = await createBoard(owner, owner.personalWorkspaceId, 'Client review')
  const base = await listen(t)
  const mint = (c: Client, bid = boardId, headers: Record<string, string> = {}) =>
    c.req('POST', `/api/boards/${bid}/events/ticket`, undefined, headers)
  const minted = async (c: Client, bid = boardId): Promise<Minted> => {
    const res = await mint(c, bid)
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as Minted
  }
  /** GET the minted URL's path on the test server, as the page does: the ticket, the page's Origin, no cookie. */
  const direct = async (
    ticket: string,
    bid = boardId,
    headers: Record<string, string> = { origin: ORIGIN },
    query = '',
  ) => {
    const s = await openSseAt(`${base}/api/boards/${bid}/events${query}`, {
      ...headers,
      authorization: `Bearer ${ticket}`,
    })
    streams.push(s)
    return s
  }
  const viaCookie = async (c: Client, bid = boardId) => {
    const s = await openSse(base, bid, c.cookie)
    streams.push(s)
    return s
  }
  /** A board guest through an invitation (owner's personal workspace has no members to grant). */
  const invite = async (handle: string, role: 'viewer' | 'editor' = 'viewer') => {
    const person = await t.login(handle)
    const inv = await owner.req('POST', `/api/boards/${boardId}/invitations`, {
      role,
      email: devEmail(handle),
    })
    const token = (inv.json() as { url: string }).url.split('/').pop() ?? ''
    expect((await person.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    return person
  }
  return { t, hub, owner, boardId, base, mint, minted, direct, viaCookie, invite }
}

const errorCode = (s: SseStream) => (s.body as { error?: { code?: string } } | null)?.error?.code

describe('POST /api/boards/:bid/events/ticket', () => {
  it('answers the direct URL, an evt_ ticket and its ~30 s expiry', async () => {
    const w = await world()
    const before = Date.now()
    const m = await w.minted(w.owner)
    expect(m.url).toBe(`${EVENTS_ORIGIN}/api/boards/${w.boardId}/events`)
    expect(m.ticket).toMatch(/^evt_[A-Za-z0-9_-]{43}$/)
    const ttl = Date.parse(m.expiresAt) - before
    expect(ttl).toBeGreaterThan(EVENTS_TICKET_TTL_MS - 5_000)
    expect(ttl).toBeLessThanOrEqual(EVENTS_TICKET_TTL_MS + 1_000)
  })

  it('answers { url: null } when DRAFTROOM_EVENTS_ORIGIN is not set (the page keeps the cookie stream)', async () => {
    const w = await world({ eventsOrigin: null })
    const res = await w.mint(w.owner)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ url: null })
    // The cookie stream is what it was.
    const s = await w.viaCookie(w.owner)
    expect(s.status).toBe(200)
    expect((await s.waitFor('hello')).data).toMatchObject({ role: 'owner' })
    expect(s.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('needs a session, view access and the web origin (CSRF): 401, 404, 403', async () => {
    const w = await world()
    const signedOut = await w.t.anon('POST', `/api/boards/${w.boardId}/events/ticket`)
    expect(signedOut.statusCode).toBe(401)
    const stranger = await w.t.login('stranger')
    expect((await w.mint(stranger)).statusCode).toBe(404)
    expect((await w.mint(w.owner, 'brd_doesnotexist00000000')).statusCode).toBe(404)
    const crossSite = await w.mint(w.owner, w.boardId, { origin: 'https://evil.example' })
    expect(crossSite.statusCode).toBe(403)
  })

  it('is rate limited per person with the stream-open budget (429 + Retry-After)', async () => {
    const w = await world({ limits: { streamOpens: { max: 2, timeWindow: 60_000 } } })
    const codes = []
    for (let i = 0; i < 3; i++) codes.push((await w.mint(w.owner)).statusCode)
    expect(codes).toEqual([200, 200, 429])
    const refused = await w.mint(w.owner)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
  })
})

describe('GET /api/boards/:bid/events with a ticket (the direct origin)', () => {
  it('streams to the page’s origin with CORS for exactly PUBLIC_ORIGIN, no credentials, and no cookie', async () => {
    const w = await world()
    const m = await w.minted(w.owner)
    const s = await w.direct(m.ticket)
    expect(s.status).toBe(200)
    expect(s.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(s.headers.get('vary')).toBe('Origin')
    expect(s.headers.get('access-control-allow-credentials')).toBeNull()
    expect(s.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect((await s.waitFor('hello')).data).toMatchObject({ role: 'owner' })
    // A live event reaches it like any stream.
    w.hub.publish(w.boardId, { type: 'comments.thread', data: { id: 'thr_1' } })
    expect((await s.waitFor('comments.thread')).data).toEqual({ id: 'thr_1' })
    expect(w.hub.userStreamCount(w.owner.userId, w.boardId)).toBe(1)
  })

  it('a ticket is single use: the second request is a readable 401', async () => {
    const w = await world()
    const m = await w.minted(w.owner)
    await (await w.direct(m.ticket)).waitFor('hello')
    const again = await w.direct(m.ticket)
    expect(again.status).toBe(401)
    expect(errorCode(again)).toBe('NOT_AUTHENTICATED')
    // Refusals carry the CORS header too, so the page can tell a refusal from a broken route.
    expect(again.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('a ticket expires after 30 s', async () => {
    const w = await world()
    const m = await w.minted(w.owner)
    w.t.clock.advance(EVENTS_TICKET_TTL_MS + 1)
    const s = await w.direct(m.ticket)
    expect(s.status).toBe(401)
  })

  it('a ticket opens only its own board, and a misused ticket is spent', async () => {
    const w = await world()
    const other = await createBoard(w.owner, w.owner.personalWorkspaceId, 'Other')
    const m = await w.minted(w.owner)
    expect((await w.direct(m.ticket, other)).status).toBe(401)
    expect((await w.direct(m.ticket)).status).toBe(401)
  })

  it('a session revoked after the mint gets nothing (its tickets are dropped); a revoked open stream ends', async () => {
    const w = await world({ limits: { streamRecheckMs: HOUR } })
    const m1 = await w.minted(w.owner)
    const m2 = await w.minted(w.owner)
    const open = await w.direct(m1.ticket)
    await open.waitFor('hello')
    expect((await w.owner.req('POST', '/api/auth/logout')).statusCode).toBeLessThan(300)
    await open.waitFor('session-ended', 2_000)
    await open.waitEnded()
    const late = await w.direct(m2.ticket)
    expect(late.status).toBe(401)
  })

  it('access removed between the mint and the stream: 404; removed while open: access-lost', async () => {
    const w = await world({ limits: { streamRecheckMs: HOUR } })
    const carol = await w.invite('carol')
    const m1 = await w.minted(carol)
    const m2 = await w.minted(carol)
    const s = await w.direct(m1.ticket)
    expect((await s.waitFor('hello')).data).toMatchObject({ role: 'viewer' })
    expect((await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${carol.userId}`)).statusCode).toBe(
      200,
    )
    await s.waitFor('access-lost', 2_000)
    await s.waitEnded()
    const late = await w.direct(m2.ticket)
    expect(late.status).toBe(404)
  })

  it('the periodic revalidation covers ticketed streams (a session that expired is ended)', async () => {
    const w = await world({ limits: { streamRecheckMs: 20 } })
    const m = await w.minted(w.owner)
    const s = await w.direct(m.ticket)
    await s.waitFor('hello')
    w.t.clock.advance(SESSION_TTL_MS + 1_000)
    await s.waitFor('session-ended', 3_000)
  })

  it('the workshops’ raised-hand tracking sees the ticket’s person: a hand stays up while that stream is open', async () => {
    const w = await world()
    const carol = await w.invite('carol')
    const s = await w.direct((await w.minted(carol)).ticket)
    await s.waitFor('hello')
    expect((await carol.req('POST', `/api/boards/${w.boardId}/hand`, { raised: true })).statusCode).toBe(200)
    // Past the grace: a hand whose owner has no open stream (as far as the tracking knows) is lowered.
    w.t.clock.advance(HAND_DISCONNECT_GRACE_MS * 3)
    const hands = () =>
      w.owner
        .req('GET', `/api/boards/${w.boardId}/workshop`)
        .then((r) => (r.json() as { hands: { userId: string }[] }).hands.map((h) => h.userId))
    expect(await hands()).toEqual([carol.userId])
    // The stream closes for good: after the grace, the hand goes down.
    await s.close()
    await new Promise((r) => setTimeout(r, 100))
    w.t.clock.advance(HAND_DISCONNECT_GRACE_MS)
    expect(await hands()).toEqual([])
  })

  it('counts against the same per-person caps as cookie streams (the oldest is replaced)', async () => {
    const w = await world()
    const carol = await w.invite('carol')
    const mine: SseStream[] = []
    for (let i = 0; i < 6; i++) {
      const s = i % 2 ? await w.viaCookie(carol) : await w.direct((await w.minted(carol)).ticket)
      await s.waitFor('hello')
      mine.push(s)
    }
    await until(() => w.hub.userStreamCount(carol.userId, w.boardId) === 5, 3_000, 'capped at 5')
    await mine[0]?.waitFor('replaced')
    expect(mine[0]?.retries).toEqual([60_000])
  })

  it('name-only guests open it the same way, and their link’s stream cap counts ticketed streams', async () => {
    guestLinkCapSettings.streams = 1
    const w = await world()
    const bob = await w.t.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'Workshop')
    const url = (await guestLink(bob, board, { role: 'editor' })).url
    const a = await joinAsGuest(w.t, url, 'A')
    const b = await joinAsGuest(w.t, url, 'B')
    const mintAs = async (g: GuestClient) => {
      const res = await g.req('POST', `/api/boards/${board}/events/ticket`)
      expect(res.statusCode).toBe(200)
      return (res.json() as Minted).ticket
    }
    const first = await w.direct(await mintAs(a), board)
    expect(first.status).toBe(200)
    expect((await first.waitFor('hello')).data).toMatchObject({ role: 'editor' })
    // The link's one slot is taken: B's ticketed stream is refused like a cookie one would be.
    const second = await w.direct(await mintAs(b), board)
    expect(second.status).toBe(503)
    expect(errorCode(second)).toBe('TOO_MANY_SUBSCRIBERS')
    expect(second.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('takes nothing else as a ticket: a session cookie value, a sync ticket, garbage; and never a cookie with it', async () => {
    const w = await world()
    const cookieValue = w.owner.cookie.slice('dr_session='.length)
    expect((await w.direct(cookieValue)).status).toBe(401)
    const sync = await w.owner.req('POST', `/api/boards/${w.boardId}/ticket`)
    expect(sync.statusCode).toBe(200)
    expect((await w.direct((sync.json() as { ticket: string }).ticket)).status).toBe(401)
    expect((await w.direct('not a ticket')).status).toBe(401)
    // An Authorization header is ticketed or refused: a valid cookie next to a bad ticket does not let it in.
    const both = await w.direct('evt_bogus', w.boardId, { origin: ORIGIN, cookie: w.owner.cookie })
    expect(both.status).toBe(401)
    // An events ticket is not a session either.
    const m = await w.minted(w.owner)
    const asCookie = await w.t.anon('GET', '/api/me', undefined, { cookie: `dr_session=${m.ticket}` })
    expect(asCookie.statusCode).toBe(401)
  })

  it('never reads a ticket from the query string (tickets stay out of URLs and edge logs)', async () => {
    const w = await world()
    const m = await w.minted(w.owner)
    const s = await openSseAt(`${w.base}/api/boards/${w.boardId}/events?ticket=${m.ticket}`, {
      origin: ORIGIN,
    })
    streams.push(s)
    expect(s.status).toBe(401)
    // Not consumed by that request: the ticket still opens the stream in its header.
    expect((await w.direct(m.ticket)).status).toBe(200)
  })

  it('a page built before H1 keeps the cookie stream on an api with the direct origin set', async () => {
    const w = await world()
    const s = await w.viaCookie(w.owner)
    expect(s.status).toBe(200)
    expect((await s.waitFor('hello')).data).toMatchObject({ role: 'owner' })
    // Same-origin: whatever CORS says is moot, and it names only the web origin.
    expect(s.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })
})

describe('CORS on the stream route', () => {
  it('names no other origin, on the stream or its preflight', async () => {
    const w = await world()
    const m = await w.minted(w.owner)
    const evil = await w.direct(m.ticket, w.boardId, { origin: 'https://evil.example' })
    // The server does not refuse by Origin (a browser does, without an allow header): the ticket still
    // authenticates; the body is unreadable to that page.
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
    expect(evil.headers.get('vary')).toBe('Origin')
    const pre = await fetch(`${w.base}/api/boards/${w.boardId}/events`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBeNull()
    expect(pre.headers.get('access-control-allow-headers')).toBeNull()
  })

  it('answers the page’s preflight: GET with Authorization, from PUBLIC_ORIGIN only, cached 10 minutes', async () => {
    const w = await world()
    const pre = await fetch(`${w.base}/api/boards/${w.boardId}/events`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET')
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization')
    expect(pre.headers.get('access-control-max-age')).toBe('600')
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull()
    expect(pre.headers.get('vary')).toBe('Origin')
  })

  it('is off without DRAFTROOM_EVENTS_ORIGIN: no allow headers anywhere', async () => {
    const w = await world({ eventsOrigin: null })
    const pre = await fetch(`${w.base}/api/boards/${w.boardId}/events`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(pre.headers.get('access-control-allow-origin')).toBeNull()
    const s = await w.direct('evt_whatever')
    expect(s.status).toBe(401)
    expect(s.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('logs', () => {
  it('never contain a ticket or the session cookie, whatever the request did', async () => {
    const logs: string[] = []
    const w = await world({ logs })
    const m1 = await w.minted(w.owner)
    const s = await w.direct(m1.ticket)
    await s.waitFor('hello')
    await w.direct(m1.ticket) // reused: refused
    const m2 = await w.minted(w.owner)
    // in a URL anyway (refused, never read)
    const q = await openSseAt(`${w.base}/api/boards/${w.boardId}/events?ticket=${m2.ticket}`, {
      origin: ORIGIN,
    })
    streams.push(q)
    await w.direct(m2.ticket, 'brd_doesnotexist00000000') // the wrong board
    await s.close()
    await until(
      () => logs.some((l) => l.includes('"route":"/api/boards/:bid/events"')),
      3_000,
      'request lines',
    )
    expect(logs.length).toBeGreaterThan(3)
    const cookieValue = w.owner.cookie.slice('dr_session='.length)
    for (const secret of [m1.ticket, m2.ticket, cookieValue])
      expect(logs.filter((l) => l.includes(secret))).toEqual([])
    expect(logs.filter((l) => /evt_[A-Za-z0-9_-]{10}/.test(l))).toEqual([])
  })
})
