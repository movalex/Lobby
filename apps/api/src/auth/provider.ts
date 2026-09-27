// Sign-in providers. A provider only proves who the caller is (dev handle, Clerk token) and then
// hands off to `ctx.signIn`, which provisions the internal user and issues the one session type the
// rest of the API understands (the `dr_session` cookie).

import type { AuthConfig, Me } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthProviderId } from '../config.ts'
import type { SessionUser } from './session.ts'

export interface RouteRateLimit {
  max: number
  timeWindow: number
}

export interface SignInContext {
  /** Rate limit for sign-in routes (applied through @fastify/rate-limit route config). */
  rateLimit: RouteRateLimit
  /**
   * Runs `provision` and session creation in one transaction (retried once on a concurrent first
   * sign-in), revokes the session this browser had before, sets the new session cookie and returns
   * the signed-in user's `Me`.
   */
  signIn(
    req: FastifyRequest,
    reply: FastifyReply,
    provision: (tx: Queryable, now: Date) => Promise<SessionUser>,
  ): Promise<Me>
  log: { warn(obj: object, msg: string): void }
}

export interface AuthProvider {
  readonly id: AuthProviderId
  publicConfig(): AuthConfig
  register(app: FastifyInstance, ctx: SignInContext): void
}
