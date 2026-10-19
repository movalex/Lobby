// Wave V (V2): join codes and the QR join card (docs/WAVE-V-CONTRACTS.md §3). OWNER: the wave V lead (contracts are
// lead-only); WS3 builds the api (apps/api/src/features/join-codes, the code lines of features/dashboard/review-links.ts,
// the join-cap fix in features/guests/join.ts) and the web (apps/web/src/features/join). Browser-safe.
//
// A workshop link (a board's multi-use EDITOR link that lets people join with just a name) may get a short code:
// 8 Crockford base-32 characters, shown "ABCD-2345" (40 bits), read case- and dash-insensitively, I/L as 1 and O as 0.
// The QR on the join card encodes `<web origin>/j/<CODE>` (a small version-2/3 QR, readable from the back of a room);
// /j/:code resolves it (GET /api/join/:code) and continues at /invite/:token, whose name-only join is unchanged.
// The code is a bearer secret like the link's token: whoever has it may join while the link is open. It is derived
// (HMAC of the link id and a bump counter under a key from the ticket secret, `JOIN_CODE_HMAC_LABEL`), so it can be
// shown again; only its sha256 is stored (invitations.join_code_hash, unique). Never on the board (a link expires
// within 24 h; a board outlives it), never in a log (the api logs route patterns only).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

/** Crockford's base-32 alphabet (no I, L, O, U). */
export const JOIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const JOIN_CODE_LENGTH = 8
/** The HMAC key's label (apps/api: HMAC(HMAC(ticketSecret, label), `${invitationId}:${n}`), first 40 bits). */
export const JOIN_CODE_HMAC_LABEL = 'draftroom:join-code:v1'
/** invitations.join_code_n: bumped on the (≈2^-40) collision with another link's code; 0038 CHECKs 0..15. */
export const JOIN_CODE_BUMP_MAX = 15

/**
 * MISSED lookups of GET /api/join/:code: per client address (an IPv6 client by its /64), and for the whole api. A miss
 * past either is 429; a code that resolves is never refused. 120 so a room behind one office address can mistype.
 */
export const JOIN_CODE_LOOKUPS_PER_ADDRESS = { max: 120, windowMs: 10 * 60 * 1000 } as const
export const JOIN_CODE_LOOKUPS_GLOBAL = { max: 600, windowMs: 60 * 1000 } as const

const CANONICAL = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`)
/** The stored/compared form: 8 alphabet characters, upper case, no dash. */
export const JOIN_CODE_PATTERN = CANONICAL

/**
 * The canonical form of a typed or scanned code, or null: spaces and dashes dropped, upper-cased, I and L read as 1,
 * O as 0 (Crockford). Anything else outside the alphabet (U, punctuation, a ninth character) is null.
 */
export function normalizeJoinCode(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null
  const s = raw
    .replace(/[\s-]+/g, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  return CANONICAL.test(s) ? s : null
}

/** "ABCD-2345": how a code is shown and read out. */
export const formatJoinCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

/** 40 bits (5 bytes) as the 8-character code (the api's derivation ends here; pure, tested). */
export function joinCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 5) throw new Error('a join code needs 5 bytes')
  let n = 0n
  for (let i = 0; i < 5; i++) n = (n << 8n) | BigInt(bytes[i] ?? 0)
  let out = ''
  for (let i = JOIN_CODE_LENGTH - 1; i >= 0; i--)
    out += JOIN_CODE_ALPHABET[Number((n >> BigInt(i * 5)) & 31n)]
  return out
}

/** The web route a code opens (and the QR's path): /j/ABCD2345. The route accepts any case and dashes. */
export const JOIN_CODE_WEB_PREFIX = '/j/'
export const joinCodeWebPath = (code: string) => `${JOIN_CODE_WEB_PREFIX}${encodeURIComponent(code)}`

/** A link's code as the Share dialog and the join card show it. */
export const JoinCode = z.object({
  /** canonical (JOIN_CODE_PATTERN) */
  code: z.string().regex(CANONICAL),
  /** "ABCD-2345" */
  display: z.string(),
  /** `<PUBLIC_ORIGIN>/j/<code>`: what the QR encodes */
  joinUrl: z.string(),
  /** the link's expiry: the code works until then (or until the link is revoked) */
  expiresAt: z.string(),
})
export type JoinCode = z.infer<typeof JoinCode>

/** POST /api/boards/:bid/review-links/:id/code (creator): the link's code, made on first ask (idempotent). Body: none. */
export const JoinCodeResponse = z.object({ joinCode: JoinCode })
export type JoinCodeResponse = z.infer<typeof JoinCodeResponse>

/**
 * GET /api/join/:code (no session): the link's token, for /invite/:token. The same 404 NOT_FOUND for an unknown, a
 * malformed, an expired and a revoked code, and with the switch off (no oracle).
 */
export const ResolvedJoinCode = z.object({ token: z.string().min(16).max(128) })
export type ResolvedJoinCode = z.infer<typeof ResolvedJoinCode>

export const JOIN_CODE_ROUTES = {
  create: '/api/boards/:bid/review-links/:id/code',
  resolve: '/api/join/:code',
} as const
export const JOIN_CODE_ROUTE_KEYS = [
  `POST ${JOIN_CODE_ROUTES.create}`,
  `GET ${JOIN_CODE_ROUTES.resolve}`,
] as const
export type JoinCodeRouteKey = (typeof JOIN_CODE_ROUTE_KEYS)[number]
export const JOIN_CODE_RULES: Readonly<Record<JoinCodeRouteKey, 'creator' | 'anyone'>> = {
  'POST /api/boards/:bid/review-links/:id/code': 'creator',
  'GET /api/join/:code': 'anyone',
}
/** Making a code hands out the link's access (like extending the link): guest row and creator row (share, always). */
export const JOIN_CODE_CREATOR_ROUTE_KEYS: readonly JoinCodeRouteKey[] = [
  'POST /api/boards/:bid/review-links/:id/code',
]

const enc = encodeURIComponent
export const joinCodeCreatePath = (bid: string, linkId: string) =>
  `/api/boards/${enc(bid)}/review-links/${enc(linkId)}/code`
export const joinCodeResolvePath = (code: string) => `/api/join/${enc(code)}`
