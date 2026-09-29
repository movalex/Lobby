import { createHmac } from 'node:crypto'
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

// Spike B contracts step C0 (docs/EXCALIDRAW-MIGRATION.md §1 A3, §3.5).
describe('A3 guest claim and the uid length', () => {
  const resign = (claims: object) => {
    // a correctly signed ticket around arbitrary claims (what a buggy or hostile signer could produce)
    const signed = `v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
    return `${signed}.${createHmac('sha256', SECRET).update(signed).digest('base64url')}`
  }

  it('carries guest: true only when asked, and verifies it', () => {
    const g = signTicket(SECRET, { ...base, guest: true, now: 1_000 })
    expect(g.claims.guest).toBe(true)
    expect(verifyTicket(SECRET, g.ticket, { boardId: base.bid, now: 2_000 })).toEqual({
      ok: true,
      claims: g.claims,
    })
    const n = signTicket(SECRET, { ...base, guest: false, now: 1_000 })
    expect('guest' in n.claims).toBe(false)
    expect(JSON.parse(Buffer.from(n.ticket.split('.')[1] ?? '', 'base64url').toString())).not.toHaveProperty(
      'guest',
    )
  })

  it('refuses a guest claim that is not exactly true', () => {
    const { claims } = signTicket(SECRET, { ...base, now: 1_000 })
    for (const guest of [false, 'true', 1, null])
      expect(verifyTicket(SECRET, resign({ ...claims, guest }), { boardId: base.bid, now: 2_000 })).toEqual({
        ok: false,
        reason: 'bad_claims',
      })
  })

  it('caps the uid at 60 characters when signing and when verifying', () => {
    expect(() => signTicket(SECRET, { ...base, uid: 'u'.repeat(61) })).toThrow(/uid/)
    expect(signTicket(SECRET, { ...base, uid: 'u'.repeat(60) }).claims.uid).toHaveLength(60)
    const { claims } = signTicket(SECRET, { ...base, now: 1_000 })
    expect(
      verifyTicket(SECRET, resign({ ...claims, uid: 'u'.repeat(61) }), { boardId: base.bid, now: 2_000 }),
    ).toEqual({
      ok: false,
      reason: 'bad_claims',
    })
  })
})
