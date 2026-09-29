// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.4, §4.1): creator status, identity freshness and
// the one creator check.
//
// - status(user): what GET /api/me says (`Me.access`), from the stored addresses and the current policy.
// - freshen(req, user, mode): "confirm when unknown, refresh in the background when merely stale" (D12).
//   An awaited refresh reloads the request's cached user, so the rest of the request decides on the
//   new addresses. The caller's OWN refresh that finds the account gone (404 resource_not_found) or
//   banned ends every session of that account.
// - refreshTarget(userId): only where the TARGET's creator status decides the answer (PUT owner,
//   transfer), after the route's own permission check. Never throws, never revokes anything.
// - requireCreator(q, userId, purpose, log): stored status only, no network; safe in a transaction.
//
// No provider call is ever made inside a database transaction or while a board or invitation lock
// is held. Nothing here logs an address, a provider payload or a provider error message.

import { DOMAIN_ACCESS_CODES, DOMAIN_ACCESS_MESSAGES, type MeAccess } from '@draftroom/contracts'
import type { Db, Queryable } from '@draftroom/db'
import type { FastifyRequest } from 'fastify'
import { ApiError, unauthenticated } from '../errors.ts'
import { GUEST_REFUSED_ROUTES, guestRefused } from '../features/guests/guard.ts'
import {
  ACCEPT_IDENTITY_MAX_AGE_MS,
  type CreatorLookup,
  IDENTITY_GRACE_MS,
  IDENTITY_RECHECK_MS,
  isConfirmed,
  REFRESH_FAILURE_BACKOFF_MS,
  userColumns,
  userParams,
} from './creator-sql.ts'
import { creatorReason, distinctDomains } from './creators.ts'
import type { AuthProvider, RefreshOutcome } from './provider.ts'
import type { SessionStore, SessionUser, SessionUserRow } from './session.ts'
import { ensurePersonalWorkspace, identityUnavailable, loadSessionUser, storedEmails } from './users.ts'

export {
  ACCEPT_IDENTITY_MAX_AGE_MS,
  IDENTITY_GRACE_MS,
  IDENTITY_RECHECK_MS,
  REFRESH_FAILURE_BACKOFF_MS,
} from './creator-sql.ts'
export { identityUnavailable } from './users.ts'

export type CreatorPurpose = 'create' | 'share'

/**
 * - 'me': GET /api/me and /api/auth/me; a failed awaited refresh keeps the stored data (still 200);
 * - 'confirm': the creator guard; `strict` (refuse: 'always' routes) answers 503 when an awaited refresh
 *   fails, otherwise the stored data is kept;
 * - 'accept': accepting an email-locked invitation: addresses at most 5 minutes old, else 503.
 */
export type FreshenMode = 'me' | 'confirm' | 'accept'

export interface RefusalLog {
  /** The matched route PATTERN (req.routeOptions.url), never req.url (the accept path has a token). */
  route: string
  by: 'guard' | 'route'
}

export interface IdentityService {
  /** Which stored addresses make a creator (running provider and policy). */
  readonly lookup: CreatorLookup
  status(user: SessionUser, q?: Queryable): Promise<MeAccess>
  freshen(
    req: FastifyRequest,
    user: SessionUser,
    mode: FreshenMode,
    opts?: { strict?: boolean },
  ): Promise<SessionUser>
  refreshTarget(userId: string): Promise<void>
  requireCreator(q: Queryable, userId: string, purpose: CreatorPurpose, log: RefusalLog): Promise<void>
  /** Stored status only; unconfirmed counts as not a creator. */
  isCreatorUser(q: Queryable, userId: string): Promise<boolean>
  /** The creators among these users (one query); unconfirmed counts as not a creator. */
  creatorsAmong(q: Queryable, userIds: readonly string[]): Promise<Set<string>>
  /**
   * ShareMember.canOwn for these users (one query): false for a CONFIRMED non-creator and for name-only
   * guests; true for creators and for accounts whose addresses are unconfirmed (the server refreshes
   * and decides at PUT).
   */
  canOwnAmong(q: Queryable, userIds: readonly string[]): Promise<Map<string, boolean>>
  /** A creator's personal workspace (D10): GET /api/me and after a refresh that finds a creator. */
  ensurePersonalWorkspace(user: SessionUser): Promise<void>
  /** Resolves when no background refresh is running (tests; the api's onClose). */
  settled(): Promise<void>
}

export const creatorRequired = (purpose: CreatorPurpose) =>
  new ApiError(
    403,
    DOMAIN_ACCESS_CODES.creatorRequired,
    purpose === 'create'
      ? DOMAIN_ACCESS_MESSAGES.creatorRequiredCreate
      : DOMAIN_ACCESS_MESSAGES.creatorRequiredShare,
  )

export const roleRequiresCreator = () =>
  new ApiError(409, DOMAIN_ACCESS_CODES.roleRequiresCreator, DOMAIN_ACCESS_MESSAGES.roleRequiresCreator)

export const accountDisabled = () =>
  new ApiError(403, DOMAIN_ACCESS_CODES.accountDisabled, DOMAIN_ACCESS_MESSAGES.accountDisabled)

// A name-only guest keeps GUEST_ACCOUNT_REQUIRED everywhere, with the guest guard's own messages.
const GUEST_CREATE = GUEST_REFUSED_ROUTES['POST /api/workspaces/:wid/boards'] ?? ''
const GUEST_SHARE = GUEST_REFUSED_ROUTES['POST /api/boards/:bid/invitations'] ?? ''

interface Logger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

interface Deps {
  db: Db
  sessions: SessionStore
  provider: AuthProvider
  lookup: CreatorLookup
  now: () => Date
  log: Logger
}

interface CreatorRow {
  id: string
  kind: string
  creator: boolean
  identity_checked_at: Date | null
}

export function createIdentityService(deps: Deps): IdentityService {
  const { db, sessions, provider, lookup, now, log } = deps
  const inflight = new Map<string, Promise<RefreshOutcome>>()
  const failedAt = new Map<string, number>()
  const background = new Set<Promise<unknown>>()

  const inBackoff = (userId: string) => {
    const t = failedAt.get(userId)
    return t !== undefined && now().getTime() - t < REFRESH_FAILURE_BACKOFF_MS
  }

  async function ensureWorkspace(userId: string, name: string): Promise<void> {
    const has = await db.maybeOne('SELECT 1 AS ok FROM workspaces WHERE personal_of = $1', [userId])
    if (has) return
    await db.transaction((tx) => ensurePersonalWorkspace(tx, userId, name, now()))
  }

  async function runRefresh(userId: string): Promise<RefreshOutcome> {
    const refreshIdentity = provider.refreshIdentity
    if (!refreshIdentity) return 'none'
    const before = await loadSessionUser(db, userId, lookup, now())
    const fetchedAt = now()
    let outcome: RefreshOutcome
    try {
      outcome = await refreshIdentity.call(provider, db, userId, fetchedAt)
    } catch (e) {
      // The provider classifies its own failures; anything that escapes it is 'unavailable'. No message.
      const err = e as { name?: unknown }
      log.warn(
        {
          evt: 'identity.refresh_failed',
          userId,
          status: null,
          code: typeof err?.name === 'string' ? err.name : null,
        },
        'identity refresh failed',
      )
      outcome = 'unavailable'
    }
    if (outcome === 'unavailable') failedAt.set(userId, now().getTime())
    else failedAt.delete(userId)
    if (outcome === 'ok' || outcome === 'none') {
      const after = await loadSessionUser(db, userId, lookup, now())
      if (after && before && after.creator !== before.creator) {
        const emails = await storedEmails(db, userId, lookup.source)
        log.info(
          {
            evt: 'identity.creator_changed',
            userId,
            creator: after.creator,
            emailDomains: distinctDomains(emails),
          },
          'creator status changed',
        )
      }
      if (after?.creator) await ensureWorkspace(userId, after.name)
    }
    return outcome
  }

  /** One refresh per user at a time (awaited and background callers share it); none during backoff. */
  function refresh(userId: string): Promise<RefreshOutcome> {
    const running = inflight.get(userId)
    if (running) return running
    if (inBackoff(userId)) return Promise.resolve('unavailable')
    const p = runRefresh(userId).finally(() => inflight.delete(userId))
    inflight.set(userId, p)
    return p
  }

  /** The caller's OWN refresh found the account gone or banned: end every session it has. */
  async function endSessions(userId: string, outcome: RefreshOutcome): Promise<void> {
    const ids = await sessions.revokeAll(userId)
    log.info({ evt: 'identity.sessions_revoked', userId, outcome, sessions: ids.length }, 'account ended')
  }

  function startBackground(userId: string): void {
    if (inflight.has(userId) || inBackoff(userId)) return
    const p: Promise<void> = refresh(userId)
      .then(async (outcome) => {
        if (outcome === 'gone' || outcome === 'banned') await endSessions(userId, outcome)
      })
      .catch((e: unknown) => {
        log.warn(
          { evt: 'identity.background_failed', userId, err: { name: (e as Error)?.name } },
          'background identity refresh failed',
        )
      })
      .finally(() => background.delete(p))
    background.add(p)
  }

  async function creatorRows(q: Queryable, userIds: readonly string[]): Promise<CreatorRow[]> {
    if (!userIds.length) return []
    const rows = await q.query<SessionUserRow>(
      `SELECT ${userColumns(2)} FROM users u WHERE u.id = ANY($1::text[])`,
      [[...new Set(userIds)], ...userParams(lookup, now())],
    )
    return rows.rows
  }

  return {
    lookup,

    async status(user, q = db) {
      if (user.kind === 'guest') return { creator: false, reason: 'guest', email: null }
      const emails = await storedEmails(q, user.id, lookup.source)
      const email = emails[0] ?? null
      if (!isConfirmed(user.identityCheckedAt, now())) return { creator: false, reason: 'unconfirmed', email }
      const reason = creatorReason(emails, lookup.policy, lookup.devDomain)
      return reason ? { creator: true, reason, email } : { creator: false, reason: 'outside', email }
    },

    async freshen(req, user, mode, opts = {}) {
      if (user.kind === 'guest' || !provider.refreshIdentity) return user
      const t = now().getTime()
      const age = user.identityCheckedAt ? t - user.identityCheckedAt.getTime() : Number.POSITIVE_INFINITY
      const limit = mode === 'accept' ? ACCEPT_IDENTITY_MAX_AGE_MS : IDENTITY_GRACE_MS
      if (age > limit) {
        const outcome = await refresh(user.id)
        if (outcome === 'gone' || outcome === 'banned') {
          await endSessions(user.id, outcome)
          throw unauthenticated()
        }
        if (outcome === 'unavailable') {
          if (mode === 'accept' || (mode === 'confirm' && opts.strict)) throw identityUnavailable()
          return user
        }
        const reloaded = await sessions.reload(req)
        if (!reloaded) throw unauthenticated()
        return reloaded
      }
      if (mode !== 'accept' && age > IDENTITY_RECHECK_MS) startBackground(user.id)
      return user
    },

    async refreshTarget(userId) {
      if (!provider.refreshIdentity) return
      try {
        const row = await db.maybeOne<{ kind: string; identity_checked_at: Date | null }>(
          'SELECT kind, identity_checked_at FROM users WHERE id = $1',
          [userId],
        )
        if (!row || row.kind === 'guest' || isConfirmed(row.identity_checked_at, now())) return
        await refresh(userId) // the outcome is ignored: the route decides from stored data
      } catch {
        // never throws: an unconfirmed target simply counts as not a creator
      }
    },

    async requireCreator(q, userId, purpose, where) {
      const t = now()
      const user = await loadSessionUser(q, userId, lookup, t)
      if (!user) throw unauthenticated()
      if (user.kind === 'guest') throw guestRefused(purpose === 'create' ? GUEST_CREATE : GUEST_SHARE)
      if (user.creator) return
      const confirmed = isConfirmed(user.identityCheckedAt, t)
      const emails = await storedEmails(q, userId, lookup.source)
      log.info(
        {
          evt: 'creator.refused',
          userId,
          route: where.route,
          by: where.by,
          purpose,
          reason: confirmed ? 'outside' : 'unconfirmed',
          emailDomains: distinctDomains(emails),
        },
        'creator required',
      )
      if (!confirmed) throw identityUnavailable()
      throw creatorRequired(purpose)
    },

    async isCreatorUser(q, userId) {
      const [row] = await creatorRows(q, [userId])
      return row?.creator === true
    },

    async creatorsAmong(q, userIds) {
      const rows = await creatorRows(q, userIds)
      return new Set(rows.filter((r) => r.creator).map((r) => r.id))
    },

    async canOwnAmong(q, userIds) {
      const t = now()
      const out = new Map<string, boolean>()
      for (const r of await creatorRows(q, userIds))
        out.set(r.id, r.kind !== 'guest' && (r.creator || !isConfirmed(r.identity_checked_at, t)))
      return out
    },

    async ensurePersonalWorkspace(user) {
      if (user.kind === 'guest' || !user.creator) return
      await ensureWorkspace(user.id, user.name)
    },

    async settled() {
      while (background.size || inflight.size) await Promise.allSettled([...background, ...inflight.values()])
    },
  }
}
