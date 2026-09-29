// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.4): the one SQL fragment that decides, per
// request, whether a user is a creator: from their STORED verified addresses (only the running
// provider's rows), the CURRENT policy (so removing an exception takes effect at the next restart,
// without anyone signing in again) and how recently those addresses were confirmed. Used by the
// session lookup, by every SELECT that feeds toSessionUser, and by identity.requireCreator.
//
// A leaf module (policy + SQL text only), so session.ts, users.ts and identity.ts can all use it
// without an import cycle. The freshness constants live here and are re-exported by identity.ts.

import { type CreatorPolicy, devDomainFor } from './creators.ts'

const HOUR_MS = 60 * 60 * 1000

/** A stored identity older than this is refreshed in the background (GET /api/me, gated routes). */
export const IDENTITY_RECHECK_MS = HOUR_MS
/** Stored addresses older than this (or never checked) are 'unconfirmed': not a creator until refreshed. */
export const IDENTITY_GRACE_MS = 24 * HOUR_MS
/** Accepting an email-locked invitation always uses addresses at most this old. */
export const ACCEPT_IDENTITY_MAX_AGE_MS = 5 * 60 * 1000
/** After a failed refresh, no new provider call for this user for this long (per process). */
export const REFRESH_FAILURE_BACKOFF_MS = 60 * 1000

export type EmailSource = 'dev' | 'clerk'

/** Which stored addresses make a creator, for the provider the api RUNS (never the AUTH_PROVIDER variable). */
export interface CreatorLookup {
  /** The running provider's id: only its user_emails rows count (dev rows never count under Clerk). */
  source: EmailSource
  /** policy.domains, plus dev.invalid under the dev provider only. */
  domains: readonly string[]
  /** policy.emails (the exceptions). */
  emails: readonly string[]
  /** The policy itself (for the pure matching functions in creators.ts). */
  policy: CreatorPolicy
  /** dev.invalid under the dev provider, else null. */
  devDomain: string | null
}

export function creatorLookup(policy: CreatorPolicy, providerId: EmailSource): CreatorLookup {
  const devDomain = devDomainFor(providerId)
  return {
    source: providerId,
    domains: devDomain ? [...policy.domains, devDomain] : [...policy.domains],
    emails: [...policy.emails],
    policy,
    devDomain,
  }
}

/** Nobody is a creator (a session store built without a policy: some tests). Fails closed. */
export const NO_CREATORS: CreatorLookup = {
  source: 'dev',
  domains: [],
  emails: [],
  policy: { domains: [], emails: [] },
  devDomain: null,
}

/**
 * The users columns behind every SessionUser, for a `users u` row. Its four parameters start at
 * `$first`: source, domains, emails, cutoff (userParams). An account is a creator only when its
 * addresses were confirmed at or after the cutoff (now - IDENTITY_GRACE_MS).
 */
export function userColumns(first: number): string {
  const [source, domains, emails, cutoff] = [first, first + 1, first + 2, first + 3].map((n) => `$${n}`)
  return `u.id, u.name, u.handle, u.color, u.avatar_url, u.kind, u.identity_checked_at,
    COALESCE(u.kind = 'account' AND u.identity_checked_at >= ${cutoff}::timestamptz AND EXISTS (
      SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.source = ${source}::text
         AND (e.domain = ANY(${domains}::text[]) OR e.email = ANY(${emails}::text[]))), false) AS creator`
}

export const userParams = (lookup: CreatorLookup, now: Date): unknown[] => [
  lookup.source,
  [...lookup.domains],
  [...lookup.emails],
  new Date(now.getTime() - IDENTITY_GRACE_MS),
]

/** Confirmed = checked at or after now - IDENTITY_GRACE_MS (the same boundary as the SQL above). */
export const isConfirmed = (checkedAt: Date | null, now: Date): boolean =>
  checkedAt !== null && checkedAt.getTime() >= now.getTime() - IDENTITY_GRACE_MS
