// The creator domains, as the page names them in plain words (wave K, K4-4). The server decides who is a
// creator (DRAFTROOM_CREATOR_DOMAINS; apps/api/src/auth/creators.ts) and answers 403 CREATOR_REQUIRED either
// way: this list only lets a screen say, in words, which addresses can create ("Work addresses end in ...").
// It is configuration, not copy: a web build for other domains sets VITE_DRAFTROOM_CREATOR_DOMAINS (a comma
// list, like the api's variable); unset, it is the api's own default list, which a test keeps equal. Nothing
// else in the app hardcodes a domain.

/** The api's default (apps/api/src/auth/creators.ts DEFAULT_CREATOR_DOMAINS; a test compares the two). */
export const DEFAULT_CREATOR_DOMAINS: readonly string[] = Object.freeze([
  'darkburn.com',
  'trailerparkgroup.com',
  'trailerpark.com',
])

/** ASCII letters, digits and hyphens in at least two labels (the api's DOMAIN_RE, without the length look-ahead). */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A comma list of domains (any case, spaces allowed) as a list of lowercase ASCII domains. An unset, blank or
 * wholly invalid value reads as the default; an entry that is not a plain domain (a "*", an "@", a port, an
 * ".invalid" name) is left out, so a mistyped value can never put a made-up domain on a screen.
 */
export function parseCreatorDomains(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_CREATOR_DOMAINS
  const out: string[] = []
  for (const part of raw.split(',')) {
    const d = part.trim().toLowerCase()
    if (d.length <= 253 && DOMAIN_RE.test(d) && !d.endsWith('.invalid') && !out.includes(d)) out.push(d)
  }
  return out.length ? Object.freeze(out) : DEFAULT_CREATOR_DOMAINS
}

const env = import.meta.env as unknown as { VITE_DRAFTROOM_CREATOR_DOMAINS?: string }

/** The domains this build names. */
export const CREATOR_DOMAINS: readonly string[] = parseCreatorDomains(env.VITE_DRAFTROOM_CREATOR_DOMAINS)

/**
 * "@darkburn.com", "@darkburn.com or @trailerpark.com", "@a.com, @b.com or @c.com": the endings of a work
 * address, in words.
 */
export function creatorDomainsInWords(domains: readonly string[] = CREATOR_DOMAINS): string {
  const ends = domains.map((d) => `@${d}`)
  if (ends.length <= 1) return ends[0] ?? ''
  return `${ends.slice(0, -1).join(', ')} or ${ends.at(-1)}`
}
