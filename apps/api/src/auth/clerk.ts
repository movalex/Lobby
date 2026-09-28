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
// Limits (docs/SECURITY-REVIEW-2026-09-27.md SCA-2): only FAILED verifications count against the
// per-IP sign-in limit, so an office full of people signing in behind one NAT is never refused, while
// someone guessing or replaying bad tokens is. Successful exchanges are bounded per Clerk user
// (CLERK_EXCHANGES_PER_SUBJECT): each one costs a Clerk Backend API call.
//
// Sign out everywhere (routes/auth.ts) ends the person's Clerk sessions too (revokeProviderSessions):
// every active session Clerk lists for the user plus the ones we stored, so no other device can
// exchange its way back in. Clerk session JWTs live about a minute, so a token minted just before can
// still be exchanged within that minute (documented residual). Webhook-driven revocation (Clerk →
// us) is future work: see routes/auth.ts.

import type { ProviderSessionsRevoked } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { unauthenticated } from '../errors.ts'
import { keyedLimit, type RouteRateLimit } from '../rate-limit.ts'
import type { AuthProvider } from './provider.ts'
import { SESSION_TTL_MS } from './session.ts'
import { findOrCreateUser } from './users.ts'

export const CLERK_EXCHANGE_PATH = '/api/auth/clerk/session'

/** Successful exchanges per Clerk user per minute (a reload loop, not a sign-in pattern, gets past it). */
export const CLERK_EXCHANGES_PER_SUBJECT: RouteRateLimit = { max: 20, timeWindow: 60_000 }

export interface ClerkProfile {
  name: string
  avatarUrl: string | null
}

export interface ClerkDeps {
  /** Verifies a Clerk session token; resolves with its subject (Clerk user id) and session id, or rejects. */
  verify(token: string): Promise<{ sub: string; sid?: string }>
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
      return { sub: payload.sub, ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}) }
    },
    async profile(sub) {
      const clerk = await client()
      const u = await clerk.users.getUser(sub)
      const email = u.primaryEmailAddress?.emailAddress
      const name = u.fullName ?? u.username ?? (email ? email.split('@')[0] : null) ?? 'Clerk user'
      return { name: name.slice(0, 200) || 'Clerk user', avatarUrl: u.imageUrl || null }
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

export function createClerkAuthProvider(opts: ClerkProviderOptions): AuthProvider {
  const deps: ClerkDeps = { ...defaultDeps(opts), ...opts.deps }
  let clock: () => Date = () => new Date()
  return {
    id: 'clerk',
    publicConfig: () => ({ providers: ['clerk'], clerkPublishableKey: opts.publishableKey }),
    register(app, ctx) {
      clock = ctx.now
      const failures = keyedLimit(ctx.rateLimit, ctx.now)
      const perSubject = keyedLimit(CLERK_EXCHANGES_PER_SUBJECT, ctx.now)
      app.post(CLERK_EXCHANGE_PATH, async (req, reply) => {
        const ip = req.ip
        // Refused before verifying anything once this IP has failed too often; not counted itself.
        failures.check(ip)
        const header = req.headers.authorization
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
        let verified: { sub: string; sid?: string }
        try {
          if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error('missing or oversized token')
          verified = await deps.verify(token)
        } catch (e) {
          failures.record(ip)
          // The reason class only: never the token or its claims.
          ctx.log.warn({ reason: (e as Error)?.name ?? 'error' }, 'clerk token rejected')
          throw unauthenticated()
        }
        const { sub, sid } = verified
        perSubject.take(sub)
        let profile: ClerkProfile | null = null
        try {
          profile = await deps.profile(sub)
        } catch (e) {
          // Sign-in still works without a profile; name and avatar are refreshed on the next sign-in.
          ctx.log.warn({ reason: (e as Error)?.name ?? 'error' }, 'clerk profile unavailable')
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
              },
              now,
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
  }
}
