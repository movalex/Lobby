// Google sign-in for open sign-in (docs/OPEN-SIGNIN.md "Google"): the page gets an ID token from Google
// Identity Services ("Sign in with Google") and POSTs it; this verifies it, the way Google documents for
// server-side verification (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token):
//
//   - an RS256 JWT signed by one of Google's current keys (https://www.googleapis.com/oauth2/v3/certs,
//     cached for the time its Cache-Control allows, refetched once for an unknown key id);
//   - `aud` is our client id, `iss` is accounts.google.com, `exp` is in the future (60 s of skew);
//   - `email_verified` is true: Google vouches that the person controls the address.
//
// Any Google account from any domain is accepted (no `hd` check): the theater Lobby is open to all.
// node:crypto only, no dependency. The token is never logged.

import { createPublicKey, type JsonWebKey, verify } from 'node:crypto'

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
const SKEW_S = 60
const MAX_TOKEN_LENGTH = 4096
const DEFAULT_KEY_TTL_MS = 60 * 60 * 1000

export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string
  /** The verified address, as Google reports it (normalised by the caller). */
  email: string
  name: string | null
}

export class GoogleTokenError extends Error {}

interface Jwk extends JsonWebKey {
  kid?: string
}
export interface GoogleKeys {
  keys: Jwk[]
  /** ms epoch until which these keys may be reused. */
  expiresAt: number
}
export type FetchGoogleKeys = () => Promise<GoogleKeys>

/** Google's current signing keys, with the cache lifetime from Cache-Control max-age. */
export const fetchGoogleKeys: FetchGoogleKeys = async () => {
  const res = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Google certs: HTTP ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]
  const ttl = maxAge ? Math.min(Number(maxAge) * 1000, 24 * DEFAULT_KEY_TTL_MS) : DEFAULT_KEY_TTL_MS
  return { keys: body.keys ?? [], expiresAt: Date.now() + ttl }
}

const b64url = (s: string) => Buffer.from(s, 'base64url')

function decodePart<T>(part: string | undefined): T {
  if (!part) throw new GoogleTokenError('malformed token')
  try {
    return JSON.parse(b64url(part).toString('utf8')) as T
  } catch {
    throw new GoogleTokenError('malformed token')
  }
}

export interface GoogleVerifierOptions {
  clientId: string
  fetchKeys?: FetchGoogleKeys
  now?: () => Date
}

/** Returns a verifier for one client id: resolves with the identity, or rejects with GoogleTokenError. */
export function createGoogleVerifier(
  opts: GoogleVerifierOptions,
): (token: string) => Promise<GoogleIdentity> {
  const fetchKeys = opts.fetchKeys ?? fetchGoogleKeys
  const now = opts.now ?? (() => new Date())
  let cache: GoogleKeys | null = null
  let inflight: Promise<GoogleKeys> | null = null

  const keys = async (fresh: boolean): Promise<Jwk[]> => {
    if (!fresh && cache && cache.expiresAt > Date.now()) return cache.keys
    inflight ??= fetchKeys().finally(() => {
      inflight = null
    })
    cache = await inflight
    return cache.keys
  }

  return async (token) => {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)
      throw new GoogleTokenError('malformed token')
    const parts = token.split('.')
    if (parts.length !== 3) throw new GoogleTokenError('malformed token')
    const [h, p, s] = parts as [string, string, string]
    const header = decodePart<{ alg?: string; kid?: string }>(h)
    if (header.alg !== 'RS256' || !header.kid) throw new GoogleTokenError('unsupported token')

    let jwk = (await keys(false)).find((k) => k.kid === header.kid)
    if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid) // Google rotated its keys
    if (!jwk) throw new GoogleTokenError('unknown signing key')
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64url(s)))
      throw new GoogleTokenError('bad signature')

    const claims = decodePart<{
      iss?: string
      aud?: string
      exp?: number
      sub?: string
      email?: string
      email_verified?: boolean | string
      name?: string
    }>(p)
    const t = now().getTime() / 1000
    if (!claims.iss || !ISSUERS.has(claims.iss)) throw new GoogleTokenError('wrong issuer')
    if (claims.aud !== opts.clientId) throw new GoogleTokenError('wrong audience')
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) throw new GoogleTokenError('expired')
    if (!claims.sub || typeof claims.email !== 'string') throw new GoogleTokenError('no account in token')
    if (claims.email_verified !== true && claims.email_verified !== 'true')
      throw new GoogleTokenError('address not verified by Google')
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null
    return { sub: claims.sub, email: claims.email, name }
  }
}
