// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §2): who is a "creator". Pure: no I/O, no clock.
//
// A creator has a verified sign-in address whose domain is exactly one of the creator domains
// (default darkburn.com, trailerparkgroup.com and trailerpark.com), or an address on the exceptions list. Matching is
// exact ASCII string equality on the text after the LAST "@": no suffixes, no subdomains, no Unicode
// case folding (U+212A KELVIN SIGN lowercases to "k"), and never a Clerk test-mode "+clerk_test"
// address. Every source of addresses goes through normalizeEmail: Clerk profiles, dev logins,
// invitations (after AccountEmail) and this config.
//
// Error messages name the variable and the 1-based entry number, never the value.

import { ACCOUNT_EMAIL_MAX_LENGTH, asciiLowercase, isClerkTestAddress } from '@draftroom/contracts'

export interface CreatorPolicy {
  /** Exact, ASCII, lowercase domains. */
  domains: readonly string[]
  /** Exact, ASCII, lowercase addresses (the exceptions list). */
  emails: readonly string[]
}

// trailerpark.com: added by the owner 2026-10-06 (Trailer Park Group's other domain).
export const DEFAULT_CREATOR_DOMAINS = ['darkburn.com', 'trailerparkgroup.com', 'trailerpark.com'] as const
/** Counts as a creator domain only while the api RUNS the dev provider (D8). Never configurable. */
export const DEV_CREATOR_DOMAIN = 'dev.invalid'
/**
 * Every domain: the policy of the open email provider only (docs/OPEN-SIGNIN.md), built in code by
 * creatorLookup. Never configurable: DOMAIN_RE refuses "*" in DRAFTROOM_CREATOR_DOMAINS.
 */
export const OPEN_CREATOR_DOMAIN = '*'
/** At most this many exceptions (DRAFTROOM_CREATOR_EMAILS). */
export const MAX_CREATOR_EMAILS = 50

export type CreatorMatch = 'domain' | 'exception' | 'dev'

/**
 * ASCII LDH labels, at least two of them, 1 to 253 characters: no "*", "@", leading or trailing dot,
 * or port. Internationalised domains are written in punycode (xn--…); nothing converts between them.
 */
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Printable ASCII only (0x21 to 0x7e): no spaces, no non-ASCII look-alikes such as U+FF20 "＠". */
const PRINTABLE_ASCII_RE = /^[!-~]+$/

/**
 * The one normal form of an address: trimmed, printable ASCII, at most 254 characters, a non-empty
 * local part (before the first "@") and domain (after the last "@"), never "+clerk_test" (any ASCII
 * case), ASCII letters lowercased. null when any of that fails. Matches the user_emails and
 * invitations.invited_email CHECKs of migration 0021.
 */
export function normalizeEmail(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || !PRINTABLE_ASCII_RE.test(s)) return null
  if (s.length > ACCOUNT_EMAIL_MAX_LENGTH) return null
  const first = s.indexOf('@')
  const last = s.lastIndexOf('@')
  if (first <= 0 || last === s.length - 1) return null
  if (isClerkTestAddress(s)) return null
  return asciiLowercase(s)
}

/** The text after the LAST "@": `"a@darkburn.com"@evil.test` → `evil.test`. */
export const emailDomain = (email: string): string => email.slice(email.lastIndexOf('@') + 1)

/** The dev domain applies only under the dev provider (keyed on the provider the api RUNS). */
export const devDomainFor = (providerId: string): string | null =>
  providerId === 'dev' ? DEV_CREATOR_DOMAIN : null

/** How one normalised address qualifies, or null. */
export function creatorMatch(
  email: string,
  policy: CreatorPolicy,
  devDomain: string | null,
): CreatorMatch | null {
  const domain = emailDomain(email)
  if (policy.domains.includes(domain) || policy.domains.includes(OPEN_CREATOR_DOMAIN)) return 'domain'
  if (policy.emails.includes(email)) return 'exception'
  if (devDomain !== null && domain === devDomain) return 'dev'
  return null
}

/** Exact string equality only: no endsWith, no subdomains, no suffix matching. */
export const isCreatorEmail = (email: string, policy: CreatorPolicy, devDomain: string | null): boolean =>
  creatorMatch(email, policy, devDomain) !== null

/** Why these addresses make a creator ('domain' before 'exception' before 'dev'), or null. */
export function creatorReason(
  emails: readonly string[],
  policy: CreatorPolicy,
  devDomain: string | null,
): CreatorMatch | null {
  const found = new Set(emails.map((e) => creatorMatch(e, policy, devDomain)))
  for (const reason of ['domain', 'exception', 'dev'] as const) if (found.has(reason)) return reason
  return null
}

/** Distinct domains of these addresses (at most `max`), for logs that must never carry an address. */
export const distinctDomains = (emails: readonly string[], max = 5): string[] =>
  [...new Set(emails.map(emailDomain))].slice(0, max)

type Env = Record<string, string | undefined>

function entries(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(',')) {
    const e = part.trim()
    if (e) out.push(e)
  }
  return out
}

const isDomainEntry = (d: string) => DOMAIN_RE.test(d) && d !== 'invalid' && !d.endsWith('.invalid')

/**
 * DRAFTROOM_CREATOR_DOMAINS (unset or blank: the two built-in domains, in every environment) and
 * DRAFTROOM_CREATOR_EMAILS (unset or blank: no exceptions). Fails closed: no value turns the policy
 * off, and an invalid value throws (the api does not start).
 */
export function parseCreatorPolicy(env: Env): CreatorPolicy {
  const domainsRaw = env.DRAFTROOM_CREATOR_DOMAINS?.trim()
  let domains: string[] = [...DEFAULT_CREATOR_DOMAINS]
  if (domainsRaw) {
    const list = entries(domainsRaw)
    domains = []
    list.forEach((entry, i) => {
      const d = asciiLowercase(entry)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the whole ASCII range is the point
      if (!/^[\x00-\x7f]+$/.test(d))
        throw new Error(
          `DRAFTROOM_CREATOR_DOMAINS entry ${i + 1} is not an ASCII domain (write internationalised domains in punycode, xn--…)`,
        )
      if (!isDomainEntry(d))
        throw new Error(
          `DRAFTROOM_CREATOR_DOMAINS entry ${i + 1} is not a valid domain (letters, digits and hyphens in at least two labels; no *, @, port, leading or trailing dot, or .invalid)`,
        )
      if (!domains.includes(d)) domains.push(d)
    })
    if (!domains.length) throw new Error('DRAFTROOM_CREATOR_DOMAINS lists no domain')
  }

  const emailsRaw = env.DRAFTROOM_CREATOR_EMAILS?.trim()
  const emails: string[] = []
  if (emailsRaw) {
    const list = entries(emailsRaw)
    if (list.length > MAX_CREATOR_EMAILS)
      throw new Error(`DRAFTROOM_CREATOR_EMAILS lists more than ${MAX_CREATOR_EMAILS} addresses`)
    list.forEach((entry, i) => {
      if (isClerkTestAddress(entry))
        throw new Error(`DRAFTROOM_CREATOR_EMAILS entry ${i + 1} is a Clerk test address (+clerk_test)`)
      const e = normalizeEmail(entry)
      if (e === null || !isDomainEntry(emailDomain(e)))
        throw new Error(`DRAFTROOM_CREATOR_EMAILS entry ${i + 1} is not a valid email address`)
      if (!emails.includes(e)) emails.push(e)
    })
  }
  return { domains, emails }
}
