// The event-stream ticket store (events/tickets.ts, wave H1): single use, short-lived, bounded, and
// never the shape of a session cookie.
import { describe, expect, it } from 'vitest'
import { isSecretToken } from '../src/auth/session.ts'
import {
  createEventTicketStore,
  EVENTS_TICKET_TTL_MS,
  isEventTicket,
  MAX_TICKETS_PER_SESSION,
} from '../src/events/tickets.ts'

const claims = (sessionId = 's1', boardId = 'b1') => ({
  boardId,
  userId: 'u1',
  sessionId,
  sessionToken: 'cookie-value-never-logged',
})

function clock() {
  let t = 1_700_000_000_000
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('event-stream tickets', () => {
  it('are opaque evt_ values that can never pass as a session cookie, and expire after 30 s', () => {
    const c = clock()
    const store = createEventTicketStore({ now: c.now })
    const minted = store.mint(claims())
    if (!minted) throw new Error('not minted')
    expect(minted.ticket).toMatch(/^evt_[A-Za-z0-9_-]{43}$/)
    expect(isEventTicket(minted.ticket)).toBe(true)
    expect(isSecretToken(minted.ticket)).toBe(false)
    expect(minted.expiresAt).toBe(c.now().getTime() + EVENTS_TICKET_TTL_MS)
    expect(EVENTS_TICKET_TTL_MS).toBe(30_000)
    // Two mints never share a value.
    expect(store.mint(claims())?.ticket).not.toBe(minted.ticket)
  })

  it('are single use: the first consume returns the claims, every later one null', () => {
    const store = createEventTicketStore({ now: clock().now })
    const t = store.mint(claims())?.ticket ?? ''
    expect(store.consume(t)).toMatchObject(claims())
    expect(store.consume(t)).toBeNull()
    expect(store.size).toBe(0)
  })

  it('expire: a ticket consumed after its 30 s is refused (and gone)', () => {
    const c = clock()
    const store = createEventTicketStore({ now: c.now })
    const a = store.mint(claims())?.ticket ?? ''
    const b = store.mint(claims())?.ticket ?? ''
    c.advance(EVENTS_TICKET_TTL_MS - 1)
    expect(store.consume(a)).not.toBeNull()
    c.advance(1)
    expect(store.consume(b)).toBeNull()
    expect(store.size).toBe(0)
  })

  it('refuse what was never minted, and anything not shaped like a ticket', () => {
    const store = createEventTicketStore({ now: clock().now })
    store.mint(claims())
    for (const v of ['', 'evt_', `evt_${'a'.repeat(43)}`, 'v1.payload.sig', 'x'.repeat(43)])
      expect(store.consume(v)).toBeNull()
    expect(store.size).toBe(1)
  })

  it('keep at most a few per session (the oldest goes) and a bounded number per process', () => {
    const store = createEventTicketStore({ now: clock().now, max: 6 })
    const mine = Array.from(
      { length: MAX_TICKETS_PER_SESSION + 2 },
      () => store.mint(claims('s1'))?.ticket ?? '',
    )
    expect(store.size).toBe(MAX_TICKETS_PER_SESSION)
    expect(store.consume(mine[0] ?? '')).toBeNull()
    expect(store.consume(mine[1] ?? '')).toBeNull()
    expect(store.consume(mine.at(-1) ?? '')).not.toBeNull()
    // The process cap: past it, nothing is minted until tickets are used or expire.
    for (const s of ['s2', 's3', 's4']) store.mint(claims(s))
    expect(store.size).toBe(6)
    expect(store.mint(claims('s5'))).toBeNull()
  })

  it('a full store frees up as tickets expire (the sweep on mint)', () => {
    const c = clock()
    const store = createEventTicketStore({ now: c.now, max: 2 })
    store.mint(claims('s1'))
    store.mint(claims('s2'))
    expect(store.mint(claims('s3'))).toBeNull()
    c.advance(EVENTS_TICKET_TTL_MS)
    expect(store.mint(claims('s3'))).not.toBeNull()
    expect(store.size).toBe(1)
  })

  it('revokeSessions drops every waiting ticket of those sessions only', () => {
    const store = createEventTicketStore({ now: clock().now })
    const a = store.mint(claims('s1'))?.ticket ?? ''
    const b = store.mint(claims('s2'))?.ticket ?? ''
    store.revokeSessions(['s1'])
    expect(store.consume(a)).toBeNull()
    expect(store.consume(b)).not.toBeNull()
  })
})
