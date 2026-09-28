// Worker authentication (docs/M3-STORAGE-CONTRACTS.md §4, §7): `Authorization: Bearer
// <DRAFTROOM_WORKER_TOKEN>`, compared in constant time. Worker routes are not browser routes: they are
// exempt from the Origin check and refuse any request that carries a cookie, so a browser session can
// never be used to reach them (and a leaked worker token never mixes with a user identity).

import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer +([\x21-\x7e]{1,1024})$/i.exec(header.trim())
  return m?.[1] ?? null
}

/**
 * A checker for the configured token. Both sides are hashed first, so the comparison takes the same
 * time whatever the presented token's length or content.
 */
export function createTokenCheck(token: string): (presented: string | null) => boolean {
  const expected = digest(token)
  return (presented) => {
    if (presented === null) return false
    return timingSafeEqual(digest(presented), expected)
  }
}

/** Any Cookie header at all: workers never send cookies, browsers always do on this origin. */
export function carriesCookie(header: string | string[] | undefined): boolean {
  return Array.isArray(header) ? header.length > 0 : typeof header === 'string' && header.trim() !== ''
}
