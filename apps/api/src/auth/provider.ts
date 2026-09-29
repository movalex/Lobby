// Sign-in providers. A provider only proves who the caller is (dev handle, Clerk token) and then
// hands off to `ctx.signIn`, which provisions the internal user and issues the one session type the
// rest of the API understands (the `dr_session` cookie).

import type { AuthConfig, Me, ProviderSessionsRevoked } from '@draftroom/contracts'
import type { Db, Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthProviderId } from '../config.ts'
import type { RouteRateLimit } from '../rate-limit.ts'
import type { CreatorLookup } from './creator-sql.ts'
import type { SessionUser } from './session.ts'

export type { RouteRateLimit } from '../rate-limit.ts'

/**
 * What an identity refresh found (docs/DOMAIN-ACCESS-CONTRACTS.md §3.4):
 * - 'ok': the provider answered and the addresses were stored (unless a newer snapshot already was);
 * - 'none': the user has no identity with this provider (identity_checked_at is stamped: nothing to find);
 * - 'gone': the provider says the account no longer exists (Clerk: 404 resource_not_found only);
 * - 'banned': the provider says the account is banned;
 * - 'unavailable': anything else (timeouts, 5xx, a wrong key, a 404 without that code).
 */
export type RefreshOutcome = 'ok' | 'none' | 'gone' | 'banned' | 'unavailable'

export interface SignInContext {
  /**
   * Sign-in attempts per client IP. The dev login applies it to every attempt (route config); the
   * Clerk exchange counts only FAILED verifications against it (SCA-2), so a NAT full of people
   * signing in is never refused.
   */
  rateLimit: RouteRateLimit
  /**
   * Runs `provision` and session creation in one transaction (retried once on a concurrent first
   * sign-in), revokes the session this browser had before, sets the new session cookie and returns
   * the signed-in user's `Me` (its `access` from the data provisioning just stored). `clerkSessionId`
   * is stored with the new session (SCA-4).
   */
  signIn(
    req: FastifyRequest,
    reply: FastifyReply,
    provision: (tx: Queryable, now: Date) => Promise<SessionUser>,
    opts?: { clerkSessionId?: string | null },
  ): Promise<Me>
  now: () => Date
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }
  /** Which stored addresses make a creator (the running provider and the policy): findOrCreateUser. */
  creators: CreatorLookup
}

export interface AuthProvider {
  readonly id: AuthProviderId
  publicConfig(): AuthConfig
  register(app: FastifyInstance, ctx: SignInContext): void
  /**
   * "Sign out everywhere", provider side: ends the person's sessions with the identity provider too,
   * so no device can exchange its way straight back in. Absent = the provider keeps no sessions of
   * its own (dev). Our own sessions are already revoked when this runs; a rejection only means the
   * provider's sessions may still be alive.
   */
  revokeProviderSessions?(db: Queryable, userId: string): Promise<ProviderSessionsRevoked>
  /**
   * Domain access: asks the provider for the user's verified addresses again and stores them
   * (replaceUserEmails, `fetchedAt` read before the call). The network call is made outside any
   * transaction. Never throws for a provider failure: it answers 'unavailable'. Absent = nothing to
   * refresh (the identity service then never refreshes).
   */
  refreshIdentity?(db: Db, userId: string, fetchedAt: Date): Promise<RefreshOutcome>
}
