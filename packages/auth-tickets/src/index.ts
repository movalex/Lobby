// Short-lived, board-specific connection tickets (docs/M1-CONTRACTS.md §6) and the api<->sync
// internal-secret check. Node only (node:crypto). The API signs; the sync server verifies.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type TicketRole = 'owner' | 'editor' | 'commenter' | 'viewer'
const ROLES: readonly string[] = ['owner', 'editor', 'commenter', 'viewer']

export interface TicketClaims {
  bid: string
  uid: string
  name: string
  color: string
  role: TicketRole
  iat: number
  exp: number
  jti: string
  /**
   * A3 (docs/EXCALIDRAW-MIGRATION.md §1): present and true for a name-only guest. Guest limits (half the
   * op rate, a 500-item creation cap, Lobby-relative links only, no lock or unlock) are enforced by sync
   * from this claim. Absent for everyone else (older tickets never carry it).
   */
  guest?: true
}

/** A ticket's `uid` is at most this many characters (§3.5: the +1 budget assumes it; api ids are 44). */
export const MAX_TICKET_UID_CHARS = 60

export const TICKET_TTL_MS = 60_000
export const INTERNAL_SECRET_HEADER = 'x-draftroom-internal'
const VERSION = 'v1'
const MIN_SECRET_LENGTH = 32
const DEV_SECRET_PREFIX = 'dev-only-'

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url')
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest()

/** Validates a configured secret. In production, dev placeholders (`dev-only-…`) are refused. */
export function checkSecret(name: string, value: string | undefined, production: boolean): string {
  if (!value || value.length < MIN_SECRET_LENGTH)
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`)
  if (production && value.startsWith(DEV_SECRET_PREFIX))
    throw new Error(`${name} is a development placeholder`)
  return value
}

export interface SignInput {
  bid: string
  uid: string
  name: string
  color: string
  role: TicketRole
  /** A3: sign a guest's ticket (the claim is only ever `true`; omit it for everyone else). */
  guest?: boolean
  ttlMs?: number
  now?: number
}

export function signTicket(secret: string, input: SignInput): { ticket: string; claims: TicketClaims } {
  if (!input.uid || input.uid.length > MAX_TICKET_UID_CHARS)
    throw new Error(`ticket uid must be 1-${MAX_TICKET_UID_CHARS} characters`)
  const now = input.now ?? Date.now()
  const claims: TicketClaims = {
    bid: input.bid,
    uid: input.uid,
    name: input.name,
    color: input.color,
    role: input.role,
    iat: now,
    exp: now + (input.ttlMs ?? TICKET_TTL_MS),
    jti: randomBytes(12).toString('base64url'),
  }
  if (input.guest) claims.guest = true
  const payload = b64(JSON.stringify(claims))
  const signed = `${VERSION}.${payload}`
  return { ticket: `${signed}.${b64(mac(secret, signed))}`, claims }
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_board' | 'bad_claims'
export type VerifyResult = { ok: true; claims: TicketClaims } | { ok: false; reason: VerifyFailure }

export function verifyTicket(
  secret: string,
  ticket: unknown,
  opts: { boardId: string; now?: number; clockSkewMs?: number },
): VerifyResult {
  if (typeof ticket !== 'string' || ticket.length > 4096) return { ok: false, reason: 'malformed' }
  const parts = ticket.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2])
    return { ok: false, reason: 'malformed' }
  const signed = `${parts[0]}.${parts[1]}`
  const expected = mac(secret, signed)
  let given: Buffer
  try {
    given = Buffer.from(parts[2], 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // Signature first: nothing inside an unauthenticated payload is trusted or even parsed.
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'bad_signature' }
  let claims: TicketClaims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!isClaims(claims)) return { ok: false, reason: 'bad_claims' }
  const now = opts.now ?? Date.now()
  const skew = opts.clockSkewMs ?? 5_000
  if (claims.exp < now - skew || claims.iat > now + skew) return { ok: false, reason: 'expired' }
  if (claims.bid !== opts.boardId) return { ok: false, reason: 'wrong_board' }
  return { ok: true, claims }
}

function isClaims(c: unknown): c is TicketClaims {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return (
    typeof o.bid === 'string' &&
    typeof o.uid === 'string' &&
    o.uid.length > 0 &&
    o.uid.length <= MAX_TICKET_UID_CHARS &&
    (o.guest === undefined || o.guest === true) &&
    typeof o.name === 'string' &&
    typeof o.color === 'string' &&
    typeof o.role === 'string' &&
    ROLES.includes(o.role) &&
    typeof o.iat === 'number' &&
    typeof o.exp === 'number' &&
    typeof o.jti === 'string'
  )
}

/** Constant-time check of the internal-call header value. */
export function checkInternalSecret(headerValue: unknown, secret: string): boolean {
  if (typeof headerValue !== 'string') return false
  const a = Buffer.from(headerValue)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
