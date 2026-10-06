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
/**
 * A stored identity_checked_at more than this far AHEAD of this process's clock was written by a
 * process whose clock ran ahead (a deploy overlap on another host), so its real age is unknown. It
 * never blocks a newer snapshot (users.ts replaceUserEmails) and counts as stale (identity.ts
 * freshen). Within one process a stored check time is never later than now; the tolerance only
 * absorbs small skews.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000

/** A check time from a clock that ran ahead of this one by more than CLOCK_SKEW_TOLERANCE_MS. */
export const isFutureCheck = (checkedAt: Date | null, now: Date): boolean =>
  checkedAt !== null && checkedAt.getTime() > now.getTime() + CLOCK_SKEW_TOLERANCE_MS

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

// ---- wave J (outside markers): what is known about an account, for the manager-only fields ---------

/** `alias` has a stored address of the running provider that qualifies (any age); params from `first`. */
const qualifiesSql = (alias: string, first: number) =>
  `EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = ${alias}.id AND e.source = $${first}::text
      AND (e.domain = ANY($${first + 1}::text[]) OR e.email = ANY($${first + 2}::text[])))`

/**
 * The columns behind an account's OutsideInfo (@draftroom/contracts outside.ts) for a `users u` row,
 * with the same four parameters as userColumns, starting at `$first`: `o_creator` is exactly
 * userColumns' `creator` (the same predicate), `o_qualifies` the same test at any age, `o_email` the
 * primary stored address of the running provider (else the oldest), never logged.
 */
export function originColumns(first: number): string {
  const cutoff = `$${first + 3}`
  return `u.id AS o_id, u.kind AS o_kind, u.identity_checked_at AS o_checked_at,
    COALESCE(u.kind = 'account' AND u.identity_checked_at >= ${cutoff}::timestamptz AND ${qualifiesSql('u', first)}, false) AS o_creator,
    COALESCE(${qualifiesSql('u', first)}, false) AS o_qualifies,
    (SELECT e.email FROM user_emails e WHERE e.user_id = u.id AND e.source = $${first}::text
      ORDER BY e.is_primary DESC, e.seen_at, e.email LIMIT 1) AS o_email`
}

/**
 * SQL that is true for an account Lobby KNOWS is outside: its addresses were checked at least once and
 * none qualifies (however long ago: a later check can only make it a creator by finding a new
 * address). Never-checked accounts, and accounts whose qualifying addresses are only stale, are
 * 'unconfirmed', not this. Three parameters from `first` (matchParams).
 */
export const knownOutsideSql = (alias: string, first: number): string =>
  `(${alias}.kind = 'account' AND ${alias}.identity_checked_at IS NOT NULL AND NOT ${qualifiesSql(alias, first)})`

/** The parameters of knownOutsideSql: source, domains, emails (userParams without the cutoff). */
export const matchParams = (lookup: CreatorLookup): unknown[] => [
  lookup.source,
  [...lookup.domains],
  [...lookup.emails],
]

/** Confirmed = checked at or after now - IDENTITY_GRACE_MS (the same boundary as the SQL above). */
export const isConfirmed = (checkedAt: Date | null, now: Date): boolean =>
  checkedAt !== null && checkedAt.getTime() >= now.getTime() - IDENTITY_GRACE_MS
