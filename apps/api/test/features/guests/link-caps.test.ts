// Per-link caps for name-only guests (SEAM-05, docs/WAVE3-CONTRACTS.md §2 guests): a guest identity
// costs nothing but a name, so per-person caps multiply by the guests one person can create. The guests
// of one link therefore share caps on what reaches everyone on the board: open event-stream slots,
// "Bring everyone to me" (summon) and reactions. People with an account are never counted, and a
// request the route itself refuses never uses up the link's share.
import {
  CURSOR_CHAT_RATE,
  GUEST_LINK_CURSOR_CHATS,
  GUEST_LINK_REACTIONS,
  GUEST_LINK_STREAMS,
  GUEST_LINK_SUMMONS,
  GUESTS_PER_LINK,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guestLinkCapSettings } from '../../../src/features/guests/link-caps.ts'
import { listen, openSse, type SseStream, until } from '../../sse.ts'
import { errorCode, type GuestClient, guestLink, joinAsGuest, setupWorld, type World } from './support.ts'

let w: World
const defaults = structuredClone(guestLinkCapSettings)
const streams: SseStream[] = []

beforeEach(() => {
  Object.assign(guestLinkCapSettings, structuredClone(defaults))
})
afterEach(async () => {
  for (const s of streams.splice(0)) await s.close()
  Object.assign(guestLinkCapSettings, structuredClone(defaults))
  await w?.api.close()
})

describe('the caps', () => {
  it('are sized for a full link: two event streams per guest, half the board’s reactions, a summon every few seconds', () => {
    expect(GUEST_LINK_STREAMS).toBe(2 * GUESTS_PER_LINK)
    expect(GUEST_LINK_REACTIONS).toEqual({ max: 50, windowMs: 1000 })
    expect(GUEST_LINK_SUMMONS).toEqual({ max: 1, windowMs: 3000 })
    // K6-4: cursor chat's share, a third of the board's own (60 per 10 s)
    expect(GUEST_LINK_CURSOR_CHATS).toEqual({ max: 20, windowMs: 10_000 })
    expect(guestLinkCapSettings).toEqual({
      streams: GUEST_LINK_STREAMS,
      reactions: GUEST_LINK_REACTIONS,
      summons: GUEST_LINK_SUMMONS,
      cursorChats: GUEST_LINK_CURSOR_CHATS,
    })
  })
})

describe('event streams per link', () => {
  it('the guests of one link together hold at most the link’s share; the owner and other links still connect', async () => {
    guestLinkCapSettings.streams = 3
    w = await setupWorld()
    const base = await listen(w.api)
    const url = (await guestLink(w.bob, w.board)).url
    const [a, b, c] = [
      await joinAsGuest(w.api, url, 'A'),
      await joinAsGuest(w.api, url, 'B'),
      await joinAsGuest(w.api, url, 'C'),
    ] as GuestClient[]
    const open = async (cookie: string) => {
      const s = await openSse(base, w.board, cookie)
      streams.push(s)
      return s
    }
    const a1 = await open(a?.cookie ?? '')
    expect(a1.status).toBe(200)
    expect((await open(a?.cookie ?? '')).status).toBe(200)
    expect((await open(b?.cookie ?? '')).status).toBe(200)
    const refused = await open(c?.cookie ?? '')
    expect(refused.status).toBe(503)
    expect(refused.headers.get('retry-after')).toBeTruthy()
    expect((refused.body as { error: { code: string } }).error.code).toBe('TOO_MANY_SUBSCRIBERS')
    // The board's owner, and a guest of another link, are not held to this link's share.
    expect((await open(w.bob.cookie)).status).toBe(200)
    const other = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'D')
    expect((await open(other.cookie)).status).toBe(200)
    // A slot of the link frees up when one of its streams closes.
    await a1.close()
    await until(() => w.events.userStreamCount(a?.userId ?? '', w.board) === 1, 3000, 'the closed stream')
    expect((await open(c?.cookie ?? '')).status).toBe(200)
  })
})

describe('reactions per link', () => {
  it('guests of one link share a reaction rate; a reaction the route refused (per person) uses none of it; members are not counted', async () => {
    guestLinkCapSettings.reactions = { max: 8, windowMs: 1000 }
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board)).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    const c = await joinAsGuest(w.api, url, 'C')
    const react = (g: { req: GuestClient['req'] }) =>
      g.req('POST', `/api/boards/${w.board}/reactions`, { emoji: '👏' })
    // A: the per-person limit (5 per second) refuses the 6th; that refusal is not the link's.
    const byA = [] as number[]
    for (let i = 0; i < 6; i++) byA.push((await react(a)).statusCode)
    expect(byA).toEqual([202, 202, 202, 202, 202, 429])
    // B: 3 more fill the link's 8.
    for (let i = 0; i < 3; i++) expect((await react(b)).statusCode).toBe(202)
    const refused = await react(c)
    expect(refused.statusCode).toBe(429)
    expect(errorCode(refused)).toBe('RATE_LIMITED')
    expect(refused.headers['retry-after']).toBeTruthy()
    // The board's owner reacts as usual.
    expect((await react(w.bob)).statusCode).toBe(202)
    // Another link has its own share.
    const other = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'D')
    expect((await react(other)).statusCode).toBe(202)
    w.api.clock.advance(1_100)
    expect((await react(c)).statusCode).toBe(202)
  })
})

describe('cursor chat per link (K6-4)', () => {
  it('commenting guests of one link share a message rate; a message the route refused (per person, a bad body) uses none of it; members are not counted', async () => {
    guestLinkCapSettings.cursorChats = { max: 7, windowMs: 10_000 }
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board, { role: 'commenter' })).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    const c = await joinAsGuest(w.api, url, 'C')
    const chat = (g: { req: GuestClient['req'] }, text = 'over here') =>
      g.req('POST', `/api/boards/${w.board}/cursor-chat`, { text })
    // A: the per-person limit refuses the 6th; that refusal is not the link's.
    const byA = [] as number[]
    for (let i = 0; i <= CURSOR_CHAT_RATE.max; i++) byA.push((await chat(a)).statusCode)
    expect(byA).toEqual([...Array(CURSOR_CHAT_RATE.max).fill(202), 429])
    // a body the route refuses (400) gives its share back
    expect((await chat(b, '')).statusCode).toBe(400)
    // B: 2 more fill the link's 7.
    for (let i = 0; i < 2; i++) expect((await chat(b)).statusCode).toBe(202)
    const refused = await chat(c)
    expect(refused.statusCode).toBe(429)
    expect(errorCode(refused)).toBe('RATE_LIMITED')
    expect(refused.headers['retry-after']).toBeTruthy()
    expect(refused.json().error.message).toContain('this link')
    // The board's owner chats as usual; another link has its own share.
    expect((await chat(w.bob)).statusCode).toBe(202)
    const other = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'D')
    expect((await chat(other)).statusCode).toBe(202)
    w.api.clock.advance(10_100)
    expect((await chat(c)).statusCode).toBe(202)
  })
})

describe('summons per link', () => {
  // Since final review R3, "Gather everyone" is for editors with an account: the route refuses every
  // guest (403), so the link's share is never used up; the cap stays as a second line of defence.
  it('guest editors cannot summon at all (403 from the route), which uses up no share; members can', async () => {
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board, { role: 'editor' })).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    const summon = (g: { req: GuestClient['req'] }) => g.req('POST', `/api/boards/${w.board}/summon`, {})
    for (const g of [a, b]) {
      const refused = await summon(g)
      expect(refused.statusCode, refused.body).toBe(403)
      expect(errorCode(refused)).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    expect((await summon(w.bob)).statusCode).toBe(202)
  })

  it('a summon the route refused does not use up the link’s share', async () => {
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board, { role: 'editor' })).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    // A's summon names nobody valid: the route answers 400, and B's reaches the route (403, not 429).
    const bad = await a.req('POST', `/api/boards/${w.board}/summon`, { targetUserId: 'nobody' })
    expect(bad.statusCode, bad.body).toBe(400)
    expect((await b.req('POST', `/api/boards/${w.board}/summon`, {})).statusCode).toBe(403)
  })
})

// PGlite answers every statement in microtasks, so in-process requests never interleave: each one
// runs to its response before the next starts. A Postgres pool answers over the network, so many
// requests sit between their checks and their effects at once. These tests add that latency.
function withDbLatency(db: unknown, ms = 3) {
  const q = db as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const k of ['query', 'one', 'maybeOne'] as const) {
    const f = q[k]
    if (!f) continue
    q[k] = async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, ms))
      return f(...a)
    }
  }
}

describe('simultaneous requests from the guests of one link (as a Postgres pool interleaves them)', () => {
  it('event streams: the link’s share holds, and the owner still connects', async () => {
    guestLinkCapSettings.streams = 4
    w = await setupWorld()
    const base = await listen(w.api)
    const url = (await guestLink(w.bob, w.board)).url
    const guests: GuestClient[] = []
    for (let i = 0; i < 3; i++) guests.push(await joinAsGuest(w.api, url, `G${i}`))
    withDbLatency(w.api.db)
    const opened = await Promise.all(
      guests.flatMap((g) => Array.from({ length: 3 }, () => openSse(base, w.board, g.cookie))),
    )
    streams.push(...opened)
    const statuses = opened.map((s) => s.status).sort()
    expect(statuses.filter((s) => s === 200)).toHaveLength(4)
    expect(statuses.filter((s) => s === 503)).toHaveLength(5)
    const owner = await openSse(base, w.board, w.bob.cookie)
    streams.push(owner)
    expect(owner.status).toBe(200)
    // Refused and admitted streams leave nothing reserved: closing one frees exactly one slot.
    const [first] = opened.filter((s) => s.status === 200)
    await first?.close()
    await until(
      () => w.events.streams().filter((s) => s.boardId === w.board).length === 4,
      3000,
      'the closed stream',
    )
    const again = await Promise.all(guests.map((g) => openSse(base, w.board, g.cookie)))
    streams.push(...again)
    expect(again.filter((s) => s.status === 200)).toHaveLength(1)
  })

  it('reactions: at most the link’s share are accepted', async () => {
    guestLinkCapSettings.reactions = { max: 4, windowMs: 1000 }
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board)).url
    const guests: GuestClient[] = []
    for (let i = 0; i < 4; i++) guests.push(await joinAsGuest(w.api, url, `R${i}`))
    withDbLatency(w.api.db)
    const res = await Promise.all(
      guests.flatMap((g) =>
        [0, 1, 2].map(() => g.req('POST', `/api/boards/${w.board}/reactions`, { emoji: '👏' })),
      ),
    )
    const codes = res.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 202)).toHaveLength(4)
    expect(codes.filter((c) => c === 429)).toHaveLength(8)
  })

  it('summons: one per window', async () => {
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board, { role: 'editor' })).url
    const guests: GuestClient[] = []
    for (let i = 0; i < 5; i++) guests.push(await joinAsGuest(w.api, url, `S${i}`))
    withDbLatency(w.api.db)
    const res = await Promise.all(guests.map((g) => g.req('POST', `/api/boards/${w.board}/summon`, {})))
    const codes = res.map((r) => r.statusCode)
    // At most one reaches the route at a time, which refuses guests (final review R3): none goes out.
    expect(codes.filter((c) => c === 202)).toHaveLength(0)
    expect(codes.filter((c) => c === 403).length).toBeGreaterThanOrEqual(1)
    expect(codes.every((c) => c === 403 || c === 429)).toBe(true)
  })

  it('a request the route refuses gives its reservation back, even when it overlapped others', async () => {
    guestLinkCapSettings.reactions = { max: 2, windowMs: 1000 }
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board)).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    withDbLatency(w.api.db)
    // A's malformed reaction (400) and B's valid one at the same time; then B again: both of B's count.
    const [bad, good] = await Promise.all([
      a.req('POST', `/api/boards/${w.board}/reactions`, { emoji: 'not an emoji at all' }),
      b.req('POST', `/api/boards/${w.board}/reactions`, { emoji: '👏' }),
    ])
    expect(bad?.statusCode).toBe(400)
    expect(good?.statusCode).toBe(202)
    expect((await b.req('POST', `/api/boards/${w.board}/reactions`, { emoji: '👏' })).statusCode).toBe(202)
    expect((await a.req('POST', `/api/boards/${w.board}/reactions`, { emoji: '👏' })).statusCode).toBe(429)
  })
})
