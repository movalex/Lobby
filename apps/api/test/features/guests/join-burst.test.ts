// Wave V (R1, the join-cap fix; docs/WAVE-V-CONTRACTS.md §3.4; WS3): a room of people joins one WORKSHOP link (a
// board's multi-use editor link: the QR on the join card) from one office address. Its joins are counted in three
// windows of their own, and no other link's caps move:
//   - per workshop link: 200 per 10 minutes (the database count; GUESTS_PER_LINK 200 still caps the total);
//   - per address and workshop link: 200 per 10 minutes;
//   - per address over every workshop link together: 400 per 10 minutes (every try counts, as for the 60);
//   - any other link: 60 per address and 60 per link per 10 minutes, as before, untouched by workshop joins.
// The full-size windows are proven with the real numbers; how the windows combine is proven with shrunk ones
// (guestJoinWindowSettings, read when the join route registers), so each window is the one that refuses.
import {
  GUEST_JOINS_PER_ADDRESS,
  GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS,
  GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK,
  GUEST_JOINS_PER_LINK,
  GUEST_JOINS_PER_WORKSHOP_LINK,
  GUESTS_PER_LINK,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { guestJoinWindowSettings } from '../../../src/features/guests/limits.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { errorCode, freshIp, guestLink, joinRequest, setupWorld, tokenOf, type World } from './support.ts'

const TEN_MIN = 10 * 60_000
const defaults = structuredClone(guestJoinWindowSettings)
let w: World | null = null
afterEach(async () => {
  Object.assign(guestJoinWindowSettings, structuredClone(defaults))
  await w?.api.close()
  w = null
})

const guests = async (world: World) =>
  (await world.api.db.one<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE kind = 'guest'")).n

/** n joins on `token` from `ip` (each 400 ms after the last, so 200 take 80 s of the test clock); their statuses. */
async function joins(world: World, token: string, ip: string, n: number, name: string): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const res = await joinRequest(world.api, token, { name: `${name} ${i}` }, { ip })
    out.push(res.statusCode)
    world.api.clock.advance(400)
  }
  return out
}
const count = (statuses: number[], code: number) => statuses.filter((s) => s === code).length

describe('the windows', () => {
  it('are the contracts’ numbers: a workshop link’s three, the other links’ two unchanged', () => {
    expect(GUEST_JOINS_PER_WORKSHOP_LINK).toEqual({ max: 200, windowMs: TEN_MIN })
    expect(GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK).toEqual({ max: 200, windowMs: TEN_MIN })
    expect(GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS).toEqual({ max: 400, windowMs: TEN_MIN })
    expect(GUEST_JOINS_PER_ADDRESS).toEqual({ max: 60, windowMs: TEN_MIN })
    expect(GUEST_JOINS_PER_LINK).toEqual({ max: 60, windowMs: TEN_MIN })
    expect(GUESTS_PER_LINK).toBe(200)
    expect(guestJoinWindowSettings).toEqual({
      perWorkshopLink: GUEST_JOINS_PER_WORKSHOP_LINK,
      perAddressPerWorkshopLink: GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK,
      perAddressOnWorkshopLinks: GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS,
    })
  })
})

describe('a room of 200 behind one address (the real numbers)', () => {
  it('200 joins from one address on one workshop link within 2 minutes all get in; the 201st is told the link is full (GUEST_LIMIT); nothing is made for it', async () => {
    w = await setupWorld()
    const link = await guestLink(w.bob, w.board, { role: 'editor' })
    const start = w.api.clock.now().getTime()
    const statuses = await joins(w, tokenOf(link.url), '10.20.30.40', GUESTS_PER_LINK, 'Room')
    expect(w.api.clock.now().getTime() - start).toBeLessThanOrEqual(2 * 60_000)
    expect(count(statuses, 201)).toBe(GUESTS_PER_LINK)
    const refused = await joinRequest(w.api, tokenOf(link.url), { name: 'One more' }, { ip: '10.20.30.40' })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(errorCode(refused)).toBe('GUEST_LIMIT')
    // from another address too: the link's 200 is the cap
    const elsewhere = await joinRequest(w.api, tokenOf(link.url), { name: 'Elsewhere' }, { ip: freshIp() })
    expect(errorCode(elsewhere)).toBe('GUEST_LIMIT')
    expect(await guests(w)).toBe(GUESTS_PER_LINK)
  }, 120_000)

  it('a simultaneous burst of 210 from one address: exactly 200 get in (the link’s row lock orders them), the rest GUEST_LIMIT', async () => {
    w = await setupWorld()
    const token = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    const results = await Promise.all(
      Array.from({ length: GUESTS_PER_LINK + 10 }, (_, i) =>
        joinRequest(w?.api as World['api'], token, { name: `Burst ${i}` }, { ip: '10.20.30.41' }),
      ),
    )
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(GUESTS_PER_LINK)
    const refused = results.filter((r) => r.statusCode !== 201)
    expect(refused).toHaveLength(10)
    for (const r of refused) expect(errorCode(r), r.body).toBe('GUEST_LIMIT')
    expect(await guests(w)).toBe(GUESTS_PER_LINK)
  }, 120_000)

  it('workshop joins never use up the address’s 60 on review links, and review links keep their old caps (60 per address, 60 per link)', async () => {
    w = await setupWorld()
    const ip = '10.20.30.42'
    const workshop = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    // 100 workshop joins first (well past 60)
    expect(count(await joins(w, workshop, ip, 100, 'Workshop'), 201)).toBe(100)
    // then the same address on two review links: its 60, exactly as before wave V
    const reviewA = tokenOf((await guestLink(w.bob, w.board)).url)
    const reviewB = tokenOf((await guestLink(w.bob, w.board, { role: 'viewer' })).url)
    for (let i = 0; i < GUEST_JOINS_PER_ADDRESS.max; i++) {
      const res = await joinRequest(w.api, i % 2 ? reviewB : reviewA, { name: `Review ${i}` }, { ip })
      expect(res.statusCode, `review join ${i + 1}: ${res.body}`).toBe(201)
    }
    const sixtyFirst = await joinRequest(w.api, reviewA, { name: 'One too many' }, { ip })
    expect(sixtyFirst.statusCode).toBe(429)
    expect(errorCode(sixtyFirst)).toBe('RATE_LIMITED')
    expect((sixtyFirst.json() as { error: { message: string } }).error.message).toMatch(/from this network/)
    // ...and the review links' joins used none of the workshop windows: the room keeps coming in
    expect(count(await joins(w, workshop, ip, 20, 'Late'), 201)).toBe(20)
    // a review link from many addresses: still 60 per link per 10 minutes
    const crowd = tokenOf((await guestLink(w.bob, w.board, { role: 'viewer' })).url)
    for (let i = 0; i < GUEST_JOINS_PER_LINK.max; i++) {
      const res = await joinRequest(w.api, crowd, { name: `Crowd ${i}` }, { ip: freshIp() })
      expect(res.statusCode, `crowd join ${i + 1}: ${res.body}`).toBe(201)
    }
    const linkFull = await joinRequest(w.api, crowd, { name: 'Crowd 61' }, { ip: freshIp() })
    expect(linkFull.statusCode).toBe(429)
    expect((linkFull.json() as { error: { message: string } }).error.message).toMatch(/through this link/)
  }, 120_000)

  it('a workshop link from many addresses takes more than the review links’ 60 per 10 minutes', async () => {
    w = await setupWorld()
    const token = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    for (let i = 0; i < GUEST_JOINS_PER_LINK.max + 20; i++) {
      const res = await joinRequest(w.api, token, { name: `Phone ${i}` }, { ip: freshIp() })
      expect(res.statusCode, `join ${i + 1}: ${res.body}`).toBe(201)
    }
  }, 60_000)
})

describe('how the windows combine (shrunk windows, so each one is the one that refuses)', () => {
  it('per workshop link, whatever the addresses: the database window refuses (429, "through this link"), then frees after 10 minutes', async () => {
    guestJoinWindowSettings.perWorkshopLink = { max: 7, windowMs: TEN_MIN }
    w = await setupWorld()
    const token = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    for (let i = 0; i < 7; i++)
      expect((await joinRequest(w.api, token, { name: `P${i}` }, { ip: freshIp() })).statusCode).toBe(201)
    const refused = await joinRequest(w.api, token, { name: 'P7' }, { ip: freshIp() })
    expect(refused.statusCode).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    expect((refused.json() as { error: { message: string } }).error.message).toMatch(/through this link/)
    // a review link is still held to its own 60, not to this window
    const review = tokenOf((await guestLink(w.bob, w.board)).url)
    for (let i = 0; i < 10; i++)
      expect((await joinRequest(w.api, review, { name: `R${i}` }, { ip: freshIp() })).statusCode).toBe(201)
    w.api.clock.advance(TEN_MIN + 1_000)
    expect((await joinRequest(w.api, token, { name: 'Later' }, { ip: freshIp() })).statusCode).toBe(201)
  })

  it('per address and workshop link: the 6th from one address is refused (429, "from this network") while other addresses and the address’s other workshop link still get in', async () => {
    guestJoinWindowSettings.perAddressPerWorkshopLink = { max: 5, windowMs: TEN_MIN }
    w = await setupWorld()
    const ip = '10.20.30.50'
    const a = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    const b = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    expect(await joins(w, a, ip, 5, 'A')).toEqual([201, 201, 201, 201, 201])
    const sixth = await joinRequest(w.api, a, { name: 'A5' }, { ip })
    expect(sixth.statusCode).toBe(429)
    expect(errorCode(sixth)).toBe('RATE_LIMITED')
    expect((sixth.json() as { error: { message: string } }).error.message).toMatch(/from this network/)
    expect(await guests(w)).toBe(5)
    // another address on the same link, and this address on another workshop link
    expect((await joinRequest(w.api, a, { name: 'Other office' }, { ip: freshIp() })).statusCode).toBe(201)
    expect((await joinRequest(w.api, b, { name: 'B0' }, { ip })).statusCode).toBe(201)
    // the window slides: 10 minutes on, the address is back on link a
    w.api.clock.advance(TEN_MIN + 1_000)
    expect((await joinRequest(w.api, a, { name: 'A later' }, { ip })).statusCode).toBe(201)
  })

  it('per address over every workshop link: a second (and a third) workshop link gets its own share, but the address’s 400 caps them together, on any board', async () => {
    guestJoinWindowSettings.perAddressPerWorkshopLink = { max: 5, windowMs: TEN_MIN }
    guestJoinWindowSettings.perAddressOnWorkshopLinks = { max: 8, windowMs: TEN_MIN }
    w = await setupWorld()
    const ip = '10.20.30.51'
    const other = await createBoard(w.bob, DEV_STUDIO, 'Second room')
    const a = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    const b = tokenOf((await guestLink(w.bob, other, { role: 'editor' })).url)
    const c = tokenOf((await guestLink(w.bob, other, { role: 'editor' })).url)
    expect(await joins(w, a, ip, 5, 'A')).toEqual([201, 201, 201, 201, 201])
    // b: its own 5 would allow more, but the address has 3 left of its 8
    expect(await joins(w, b, ip, 4, 'B')).toEqual([201, 201, 201, 429])
    const capped = await joinRequest(w.api, c, { name: 'C0' }, { ip })
    expect(capped.statusCode).toBe(429)
    expect((capped.json() as { error: { message: string } }).error.message).toMatch(/from this network/)
    expect(await guests(w)).toBe(8)
    // review links are not counted in it: the same address still joins one
    const review = tokenOf((await guestLink(w.bob, w.board)).url)
    expect((await joinRequest(w.api, review, { name: 'Client' }, { ip })).statusCode).toBe(201)
    // and another address is not affected
    expect((await joinRequest(w.api, c, { name: 'Elsewhere' }, { ip: freshIp() })).statusCode).toBe(201)
  })

  it('every try on a workshop link counts against the address’s 400, a refused one too (a full link cannot be hammered for free); the per-link 200 counts only who got in', async () => {
    guestJoinWindowSettings.perAddressPerWorkshopLink = { max: 5, windowMs: TEN_MIN }
    guestJoinWindowSettings.perAddressOnWorkshopLinks = { max: 6, windowMs: TEN_MIN }
    w = await setupWorld()
    const ip = '10.20.30.52'
    const link = await guestLink(w.bob, w.board, { role: 'editor' })
    const closed = await guestLink(w.bob, w.board, { role: 'editor' })
    expect(
      (await w.bob.req('POST', `/api/boards/${w.board}/review-links/${closed.id}/revoke`, {})).statusCode,
    ).toBe(200)
    // three tries on a revoked workshop link: 410 each, and each used one of the address's 6
    for (let i = 0; i < 3; i++)
      expect((await joinRequest(w.api, tokenOf(closed.url), { name: `X${i}` }, { ip })).statusCode).toBe(410)
    // the open link: 3 get in (3 of its 5 per address and link), which uses up the 6
    expect(await joins(w, tokenOf(link.url), ip, 3, 'In')).toEqual([201, 201, 201])
    const after = await joinRequest(w.api, tokenOf(link.url), { name: 'Late' }, { ip })
    expect(after.statusCode).toBe(429)
    expect(await guests(w)).toBe(3)
  })

  it('an unknown token from an address is held to the review links’ 60, not to a workshop window', async () => {
    guestJoinWindowSettings.perAddressOnWorkshopLinks = { max: 2, windowMs: TEN_MIN }
    w = await setupWorld()
    const ip = '10.20.30.53'
    for (let i = 0; i < 5; i++) {
      const res = await joinRequest(w.api, 'A'.repeat(43), { name: `Guess ${i}` }, { ip })
      expect(res.statusCode).toBe(404)
    }
    // the workshop window of the address is untouched by the guesses
    const token = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    expect(await joins(w, token, ip, 2, 'Real')).toEqual([201, 201])
  })

  it('a signed-in guest coming in through a workshop link (accept) is held to the workshop link’s window, not the review links’ 60', async () => {
    guestJoinWindowSettings.perWorkshopLink = { max: 2, windowMs: TEN_MIN }
    w = await setupWorld()
    const token = tokenOf((await guestLink(w.bob, w.board, { role: 'editor' })).url)
    for (let i = 0; i < 2; i++)
      expect((await joinRequest(w.api, token, { name: `P${i}` }, { ip: freshIp() })).statusCode).toBe(201)
    const second = await createBoard(w.bob, DEV_STUDIO, 'Elsewhere')
    const elsewhere = await joinRequest(
      w.api,
      tokenOf((await guestLink(w.bob, second)).url),
      { name: 'Sam' },
      { ip: freshIp() },
    )
    const cookie = `dr_session=${elsewhere.cookies.find((c) => c.name === 'dr_session')?.value}`
    const accept = await w.api.anon('POST', `/api/invitations/${token}/accept`, undefined, { cookie })
    expect(accept.statusCode, accept.body).toBe(429)
    expect((accept.json() as { error: { message: string } }).error.message).toMatch(/through this link/)
  })
})
