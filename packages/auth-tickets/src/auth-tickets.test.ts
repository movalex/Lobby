import { describe, expect, it } from 'vitest'
import { checkInternalSecret, checkSecret, signTicket, TICKET_TTL_MS, verifyTicket } from './index.ts'

const SECRET = 'test-secret-0123456789-0123456789-abcdef'
const base = { bid: 'b-abcdefghij', uid: 'usr_1', name: 'Alice', color: '#1971c2', role: 'editor' as const }

describe('board tickets', () => {
  it('round-trips claims for the right board', () => {
    const { ticket, claims } = signTicket(SECRET, { ...base, now: 1_000 })
    const r = verifyTicket(SECRET, ticket, { boardId: 'b-abcdefghij', now: 2_000 })
    expect(r).toEqual({ ok: true, claims })
    expect(claims.exp - claims.iat).toBe(TICKET_TTL_MS)
  })

  it('rejects another board, expiry, a different secret, and tampering', () => {
    const { ticket } = signTicket(SECRET, { ...base, now: 1_000 })
    expect(verifyTicket(SECRET, ticket, { boardId: 'b-otherboard', now: 2_000 })).toEqual({
      ok: false,
      reason: 'wrong_board',
    })
    expect(verifyTicket(SECRET, ticket, { boardId: base.bid, now: 1_000 + TICKET_TTL_MS + 6_000 })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(verifyTicket(`${SECRET}x`, ticket, { boardId: base.bid, now: 2_000 }).ok).toBe(false)
    // escalate the role inside the payload but keep the old signature
    const [v, payload, sig] = ticket.split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())
    const forged = `${v}.${Buffer.from(JSON.stringify({ ...claims, role: 'owner' })).toString('base64url')}.${sig}`
    expect(verifyTicket(SECRET, forged, { boardId: base.bid, now: 2_000 })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('rejects malformed input without throwing', () => {
    for (const t of [undefined, '', 'v1', 'v1..', 'v2.a.b', 'v1.a.b.c', 'x'.repeat(5000), 42])
      expect(verifyTicket(SECRET, t, { boardId: base.bid }).ok).toBe(false)
  })

  it('rejects correctly signed but invalid claims', () => {
    const { ticket } = signTicket(SECRET, { ...base, role: 'superuser' as never })
    expect(verifyTicket(SECRET, ticket, { boardId: base.bid })).toEqual({ ok: false, reason: 'bad_claims' })
  })
})

describe('secrets', () => {
  it('requires length and refuses dev placeholders in production', () => {
    expect(() => checkSecret('S', 'short', false)).toThrow()
    expect(checkSecret('S', 'dev-only-ticket-secret-change-me-0123456789', false)).toBeTruthy()
    expect(() => checkSecret('S', 'dev-only-ticket-secret-change-me-0123456789', true)).toThrow(/placeholder/)
    expect(checkSecret('S', SECRET, true)).toBe(SECRET)
  })

  it('internal secret comparison is exact', () => {
    expect(checkInternalSecret(SECRET, SECRET)).toBe(true)
    expect(checkInternalSecret(`${SECRET} `, SECRET)).toBe(false)
    expect(checkInternalSecret(undefined, SECRET)).toBe(false)
    expect(checkInternalSecret(['a'], SECRET)).toBe(false)
  })
})
