// Clerk sign-in adapter. UNVERIFIED: no Clerk keys exist yet, so this has only been typechecked
// against @clerk/backend 3.20.1 (verifyToken, createClerkClient().users.getUser,
// .sessions.getSessionList / .revokeSession) and exercised with injected fakes; it has never talked to
// Clerk. Verify end to end before relying on it.
//
// Flow: the web app signs in with @clerk/react, then POSTs its Clerk session JWT to
// /api/auth/clerk/session (Authorization: Bearer <token>). We verify it (issuer keys fetched with the
// secret key; `azp` must be PUBLIC_ORIGIN), map the Clerk user id (`sub`) to an identities row,
// auto-provision the internal user on first sign-in, and issue our own `dr_session` cookie. Clerk's
// token is never stored or logged; its session id (`sid`) is stored with our session (SCA-4).
//
// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §3.1, §3.3): the profile's VERIFIED addresses
// (primary and secondary; never 'transferable', unverified, non-ASCII or "+clerk_test" ones) are
// stored with the sign-in, with Clerk's verification strategy. A banned or locked account is refused
// (403 ACCOUNT_DISABLED) before any new session exists, and a banned one's existing sessions end too.
// A FIRST sign-in whose profile cannot be fetched is refused (503 IDENTITY_UNAVAILABLE, D9); a later
// one signs in on the stored addresses.
// refreshIdentity asks Clerk again (identity.ts decides when). Only a 404 whose errors include
// `resource_not_found` means the account is gone. Clerk error messages never reach a log (they can
// quote the address): the failure log carries Clerk's HTTP status and first error code only.
//
// Limits (docs/SECURITY-REVIEW-2026-09-27.md SCA-2): only FAILED verifications count against the
// per-IP sign-in limit, so an office full of people signing in behind one NAT is never refused, while
// someone guessing or replaying bad tokens is. Successful exchanges are bounded per Clerk user
// (CLERK_EXCHANGES_PER_SUBJECT): each one costs a Clerk Backend API call.
//
// Sign out everywhere (routes/auth.ts) ends the person's Clerk sessions too (revokeProviderSessions):
// every active session Clerk lists for the user plus the ones we stored, so no other device can
// exchange its way back in. Clerk session JWTs live about a minute, so a token minted just before can
// still be exchanged within that minute (documented residual). Webhook-driven revocation (Clerk to
// us) is future work: see routes/auth.ts.

import type { ProviderSessionsRevoked } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { unauthenticated } from '../errors.ts'
import { CLERK_TIMEOUT_MS, withTimeout } from '../features/dashboard/clerk-directory.ts'
import { keyedLimit, type RouteRateLimit } from '../rate-limit.ts'
import { accountDisabled } from './identity.ts'
import type { AuthProvider, RefreshOutcome } from './provider.ts'
import { SESSION_TTL_MS } from './session.ts'
import { findOrCreateUser, type ProfileEmail, replaceUserEmails, stampIdentityChecked } from './users.ts'

export type { ProfileEmail } from './users.ts'

export const CLERK_EXCHANGE_PATH = '/api/auth/clerk/session'

/** Successful exchanges per Clerk user per minute (a reload loop, not a sign-in pattern, gets past it). */
export const CLERK_EXCHANGES_PER_SUBJECT: RouteRateLimit = { max: 20, timeWindow: 60_000 }

export interface ClerkProfile {
  name: string
  avatarUrl: string | null
  /** Verified, normalised (normalizeEmail), deduplicated, primary first. Required. */
  emails: readonly ProfileEmail[]
  /** default false */
  banned?: boolean
  /** default false */
  locked?: boolean
}

export interface ClerkDeps {
  /**
   * Verifies a Clerk session token; resolves with its subject (Clerk user id), session id and session
   * status claim (`sts`: absent on tokens that carry none), or rejects.
   */
  verify(token: string): Promise<{ sub: string; sid?: string; sts?: string }>
  /** The Clerk user's profile; rejects with Clerk's error (a ClerkAPIResponseError when Clerk answered). */
  profile(sub: string): Promise<ClerkProfile>
  /**
   * Revokes the Clerk user's sessions: every active one Clerk lists, plus `known` (session ids we
   * stored). Resolves with how many were revoked; rejects when Clerk cannot be reached.
   */
  revokeSessions(sub: string, known: readonly string[]): Promise<number>
}

export interface ClerkProviderOptions {
  secretKey: string
  publishableKey: string
  publicOrigin: string
  /** Test seam; defaults call Clerk. */
  deps?: Partial<ClerkDeps>
}

const MAX_TOKEN_LENGTH = 8192
const MAX_LISTED_SESSIONS = 100

/** A verified token whose session is not active (Clerk marks one that still owes a session task `pending`). */
export class SessionNotActiveError extends Error {
  override name = 'SessionNotActiveError'
}

/**
 * SCA-3 (docs/SECURITY-REVIEW-2026-09-27.md): only an ACTIVE Clerk session signs in. A token whose `sts`
 * claim is `pending` (or any other value Clerk adds) is refused, so a user who has not finished a
 * Clerk session task never gets a session here. A token with no `sts` claim at all is accepted, as
 * @clerk/backend itself does: it treats only a pending status as signed out. The reason class is all
 * that is logged (never the token or its claims).
 */
export function assertSessionActive(sts: string | undefined): void {
  if (sts !== undefined && sts !== 'active') throw new SessionNotActiveError('session is not active')
}

/** The parts of a Clerk User (@clerk/backend 3.20.1 User.d.ts, EmailAddress.d.ts) the profile reads. */
export interface ClerkUserEmails {
  primaryEmailAddressId: string | null
  emailAddresses: readonly {
    id: string
    emailAddress: string
    verification: { status: string; strategy?: string | null } | null
  }[]
}

/**
 * The addresses of a Clerk user that count (§3.1): `verification.status === 'verified'` only, primary
 * first. users.ts cleanProfileEmails then drops non-ASCII and "+clerk_test" ones, dedupes and caps.
 */
export function verifiedProfileEmails(u: ClerkUserEmails): ProfileEmail[] {
  const out: ProfileEmail[] = []
  for (const a of u.emailAddresses) {
    if (a.verification?.status !== 'verified') continue
    const strategy = typeof a.verification.strategy === 'string' ? a.verification.strategy : null
    const isPrimary = a.id === u.primaryEmailAddressId
    const entry = { email: a.emailAddress, isPrimary, strategy }
    if (isPrimary) out.unshift(entry)
    else out.push(entry)
  }
  return out
}

function defaultDeps(opts: ClerkProviderOptions): ClerkDeps {
  // Loaded lazily: dev-provider runs (and tests with fakes) never load the Clerk SDK.
  let sdk: Promise<typeof import('@clerk/backend')> | null = null
  const load = () => {
    sdk ??= import('@clerk/backend')
    return sdk
  }
  const client = async () => {
    const { createClerkClient } = await load()
    return createClerkClient({ secretKey: opts.secretKey, publishableKey: opts.publishableKey })
  }
  return {
    async verify(token) {
      const { verifyToken } = await load()
      const payload = await verifyToken(token, {
        secretKey: opts.secretKey,
        authorizedParties: [opts.publicOrigin],
      })
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject')
      return {
        sub: payload.sub,
        ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
        ...(typeof payload.sts === 'string' ? { sts: payload.sts } : {}),
      }
    },
    async profile(sub) {
      const clerk = await client()
      const u = await withTimeout(clerk.users.getUser(sub), CLERK_TIMEOUT_MS)
      const email = u.primaryEmailAddress?.emailAddress
      const name = u.fullName ?? u.username ?? (email ? email.split('@')[0] : null) ?? 'Clerk user'
      return {
        name: name.slice(0, 200) || 'Clerk user',
        avatarUrl: u.imageUrl || null,
        emails: verifiedProfileEmails(u),
        banned: u.banned === true,
        locked: u.locked === true,
      }
    },
    async revokeSessions(sub, known) {
      const clerk = await client()
      const listed = await clerk.sessions.getSessionList({
        userId: sub,
        status: 'active',
        limit: MAX_LISTED_SESSIONS,
      })
      const ids = new Set([...listed.data.map((s) => s.id), ...known])
      let revoked = 0
      for (const id of ids) {
        try {
          await clerk.sessions.revokeSession(id)
          revoked++
        } catch {
          // already ended (a stored id Clerk no longer lists): nothing to revoke
        }
      }
      return revoked
    },
  }
}

export interface ClerkFailureInfo {
  /** Only a ClerkAPIResponseError 404 whose errors include `resource_not_found`. */
  gone: boolean
  /** Clerk's HTTP status (null: no answer, e.g. a timeout). */
  status: number | null
  /** Clerk's first error code (never its message). */
  code: string | null
}

/** Classifies a failed Clerk profile call (§3.1). Never reads or returns Clerk's message. */
export async function classifyProfileFailure(e: unknown): Promise<ClerkFailureInfo> {
  const err = (typeof e === 'object' && e !== null ? e : {}) as { status?: unknown; errors?: unknown }
  const status = typeof err.status === 'number' ? err.status : null
  const list = Array.isArray(err.errors) ? (err.errors as { code?: unknown }[]) : []
  const first = list[0]?.code
  const code = typeof first === 'string' ? first.slice(0, 64) : null
  let gone = false
  if (status === 404) {
    const { isClerkAPIResponseError } = await import('@clerk/backend/errors')
    gone = isClerkAPIResponseError(e) && e.errors.some((x) => x.code === 'resource_not_found')
  }
  return { gone, status, code }
}

export function createClerkAuthProvider(opts: ClerkProviderOptions): AuthProvider {
  const deps: ClerkDeps = { ...defaultDeps(opts), ...opts.deps }
  let clock: () => Date = () => new Date()
  let log: { warn(obj: object, msg: string): void } = { warn: () => {} }
  return {
    id: 'clerk',
    publicConfig: () => ({ providers: ['clerk'], clerkPublishableKey: opts.publishableKey }),
    register(app, ctx) {
      clock = ctx.now
      log = ctx.log
      const failures = keyedLimit(ctx.rateLimit, ctx.now)
      const perSubject = keyedLimit(CLERK_EXCHANGES_PER_SUBJECT, ctx.now)
      app.post(CLERK_EXCHANGE_PATH, async (req, reply) => {
        const ip = req.ip
        // Refused before verifying anything once this IP has failed too often; not counted itself.
        failures.check(ip)
        const header = req.headers.authorization
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
        let verified: { sub: string; sid?: string; sts?: string }
        try {
          if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error('missing or oversized token')
          verified = await deps.verify(token)
          assertSessionActive(verified.sts)
        } catch (e) {
          failures.record(ip)
          // The reason class only: never the token or its claims.
          ctx.log.warn({ reason: (e as Error)?.name ?? 'error' }, 'clerk token rejected')
          throw unauthenticated()
        }
        const { sub, sid } = verified
        perSubject.take(sub)
        // Read BEFORE asking Clerk: an older snapshot never overwrites a newer one (users.ts).
        const fetchedAt = ctx.now()
        let profile: ClerkProfile | null = null
        try {
          profile = await deps.profile(sub)
        } catch (e) {
          // A later sign-in still works on the stored addresses; a first one is refused (D9, users.ts).
          const f = await classifyProfileFailure(e)
          ctx.log.warn(
            { evt: 'identity.refresh_failed', userId: null, status: f.status, code: f.code },
            'clerk profile unavailable',
          )
        }
        if (profile && (profile.banned === true || profile.locked === true)) {
          // A banned account's existing sessions end too, as a refresh that finds it banned ends them. A
          // locked one (a temporary lockout, which failed sign-in attempts by anyone can cause) is only
          // refused here.
          if (profile.banned === true) await ctx.endBannedAccount('clerk', sub)
          throw accountDisabled()
        }
        return ctx.signIn(
          req,
          reply,
          async (tx, now) => {
            const { user } = await findOrCreateUser(
              tx,
              {
                provider: 'clerk',
                subject: sub,
                name: profile?.name ?? 'Clerk user',
                handle: null,
                avatarUrl: profile?.avatarUrl ?? null,
                refreshProfile: profile !== null,
                emails: profile ? profile.emails : null,
                fetchedAt,
              },
              now,
              ctx.creators,
            )
            return user
          },
          { clerkSessionId: sid ?? null },
        )
      })
    },
    async revokeProviderSessions(db: Queryable, userId: string): Promise<ProviderSessionsRevoked> {
      const identities = await db.query<{ subject: string }>(
        "SELECT subject FROM identities WHERE provider = 'clerk' AND user_id = $1 ORDER BY subject",
        [userId],
      )
      if (!identities.rows.length) return { status: 'none', revoked: 0 }
      // Clerk sessions our sessions came from, within a session lifetime (older ones are long gone).
      const known = await db.query<{ clerk_session_id: string }>(
        `SELECT DISTINCT clerk_session_id FROM sessions
          WHERE user_id = $1 AND clerk_session_id IS NOT NULL AND created_at > $2`,
        [userId, new Date(clock().getTime() - SESSION_TTL_MS)],
      )
      const knownIds = known.rows.map((r) => r.clerk_session_id)
      let revoked = 0
      for (const { subject } of identities.rows) revoked += await deps.revokeSessions(subject, knownIds)
      return { status: 'revoked', revoked }
    },
    async refreshIdentity(db, userId, fetchedAt): Promise<RefreshOutcome> {
      const identities = await db.query<{ subject: string }>(
        "SELECT subject FROM identities WHERE provider = 'clerk' AND user_id = $1 ORDER BY subject",
        [userId],
      )
      if (!identities.rows.length) {
        await stampIdentityChecked(db, userId, fetchedAt, { now: clock() })
        return 'none'
      }
      // Every network call first, outside any transaction; then one write.
      const profiles: ClerkProfile[] = []
      for (const { subject } of identities.rows) {
        try {
          profiles.push(await deps.profile(subject))
        } catch (e) {
          const f = await classifyProfileFailure(e)
          log.warn(
            { evt: 'identity.refresh_failed', userId, status: f.status, code: f.code },
            'identity refresh failed',
          )
          if (f.gone) continue
          return 'unavailable'
        }
      }
      if (!profiles.length) return 'gone'
      if (profiles.some((p) => p.banned === true)) return 'banned'
      const emails = profiles.flatMap((p) => p.emails)
      await db.transaction((tx) =>
        replaceUserEmails(tx, userId, 'clerk', emails, fetchedAt, { now: clock() }),
      )
      return 'ok'
    },
  }
}
