// Per-link caps for name-only guests (SEAM-05, docs/WAVE3-CONTRACTS.md §2 guests): a guest identity
// costs nothing but a name, so per-person caps multiply by the guests one person can create. The guests
// of one link therefore share caps on what reaches everyone on the board: open event-stream slots,
// "Bring everyone to me" (summon) and reactions. People with an account are never counted, and a
// request the route itself refuses never uses up the link's share.
import {
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
    expect(guestLinkCapSettings).toEqual({
      streams: GUEST_LINK_STREAMS,
      reactions: GUEST_LINK_REACTIONS,
      summons: GUEST_LINK_SUMMONS,
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

describe('summons per link', () => {
  it('guest editors of one link share one summon every few seconds; members and other links are not held to it', async () => {
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board, { role: 'editor' })).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    const summon = (g: { req: GuestClient['req'] }) => g.req('POST', `/api/boards/${w.board}/summon`, {})
    expect((await summon(a)).statusCode).toBe(202)
    const refused = await summon(b)
    expect(refused.statusCode, refused.body).toBe(429)
    expect(errorCode(refused)).toBe('RATE_LIMITED')
    expect((refused.json() as { error: { message: string } }).error.message).toMatch(/this link/)
    expect((await summon(w.bob)).statusCode).toBe(202)
    const other = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'editor' })).url, 'D')
    expect((await summon(other)).statusCode).toBe(202)
    w.api.clock.advance(GUEST_LINK_SUMMONS.windowMs + 100)
    expect((await summon(b)).statusCode).toBe(202)
  })

  it('a summon the route refused does not use up the link’s share', async () => {
    w = await setupWorld()
    const url = (await guestLink(w.bob, w.board, { role: 'editor' })).url
    const a = await joinAsGuest(w.api, url, 'A')
    const b = await joinAsGuest(w.api, url, 'B')
    // A's summon names nobody valid: the route answers 400, and B can still summon.
    const bad = await a.req('POST', `/api/boards/${w.board}/summon`, { targetUserId: 'nobody' })
    expect(bad.statusCode, bad.body).toBe(400)
    expect((await b.req('POST', `/api/boards/${w.board}/summon`, {})).statusCode).toBe(202)
  })
})
