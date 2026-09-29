// Session routes shared by every sign-in provider: config, me, logout, sign out everywhere.
//
// Revocation (docs/SECURITY-REVIEW-2026-09-27.md SCA-2, SCA-4):
// - Logout is never rate limited: a 429 there used to leave the session valid. It revokes this
//   browser's session and clears the cookie whatever happens; when the revocation itself fails
//   (database down) the answer is a 503 LOGOUT_INCOMPLETE so the web app can say so instead of
//   showing a signed-out screen over a session that still works.
// - POST /api/auth/sessions/revoke-all ends every session of the signed-in person (all devices,
//   this one included), their board event streams (via the session store's onRevoked hook), and
//   the identity provider's sessions (Clerk: auth/clerk.ts), so another device cannot silently
//   exchange a live Clerk session for a new dr_session.
//
// Future work (not built): Clerk webhooks. A Svix-verified POST /api/webhooks/clerk handling
// `session.revoked` / `session.ended` (revoke the dr_sessions whose clerk_session_id matches) and
// `user.deleted` / `user.banned` (revoke every session of that identity's user) would make revocation
// in the Clerk dashboard take effect here within seconds. Until then an operator offboards someone
// with "sign out everywhere" on their behalf or SQL (docs/SECURITY-REVIEW-2026-09-27.md §6 item 6).

import type { Me, MeKind, RevokeAllSessionsResponse } from '@draftroom/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthProvider } from '../auth/provider.ts'
import type { SessionUser } from '../auth/session.ts'
import { listUserWorkspaces } from '../auth/users.ts'
import type { AppContext } from '../context.ts'
import { ApiError } from '../errors.ts'
import { keyedLimit } from '../rate-limit.ts'
import { sessionUserToUser } from '../serialize.ts'

export const REVOKE_ALL_PATH = '/api/auth/sessions/revoke-all'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, provider: AuthProvider): void {
  const { db, sessions } = ctx
  const revokeAllLimit = keyedLimit(ctx.limits.revokeAll, ctx.now)

  app.get('/api/auth/config', async () => provider.publicConfig())

  /**
   * `kind` (wave 3, guests): 'guest' for a name-only guest, 'account' otherwise (contracts MeKind).
   * `access` (domain access, docs/DOMAIN-ACCESS-CONTRACTS.md §8): the identity is confirmed with the
   * provider first when the stored addresses are unknown or older than 24 h (a failure keeps the stored
   * data: 'unconfirmed', still 200) and refreshed in the background when older than 1 h; a creator
   * without a personal workspace gets one. An awaited refresh that finds the account gone or banned
   * ends its sessions: 401.
   */
  const meOf = async (req: FastifyRequest, signedIn: SessionUser): Promise<Me & MeKind> => {
    const user = await ctx.identity.freshen(req, signedIn, 'me')
    await ctx.identity.ensurePersonalWorkspace(user)
    const [workspaces, access] = await Promise.all([
      listUserWorkspaces(db, user.id),
      ctx.identity.status(user),
    ])
    return { user: sessionUserToUser(user), workspaces, kind: user.kind, access }
  }

  app.get('/api/me', async (req): Promise<Me & MeKind> => meOf(req, await ctx.requireUser(req)))

  // A11Y-17: the web app's session check when a page loads. Signed out is an expected answer there, so
  // it is 204 No Content instead of a 401 that every browser logs as an error (the sign-in page's
  // console stays clean). Same body as /api/me when signed in; /api/me itself is unchanged.
  app.get('/api/auth/me', async (req, reply): Promise<(Me & MeKind) | undefined> => {
    const user = await sessions.user(req)
    if (!user) return reply.code(204).send()
    return meOf(req, user)
  })

  // Always 204, signed in or not: logging out twice (or from a stale tab) is not an error.
  app.post('/api/auth/logout', async (req, reply) => {
    let failed = false
    try {
      await sessions.revoke(req)
    } catch (e) {
      failed = true
      const err = e as { name?: unknown; message?: unknown }
      req.log.error(
        { err: { name: err?.name, message: err?.message } },
        'logout could not revoke the session',
      )
    }
    sessions.clearCookie(reply)
    if (failed)
      throw new ApiError(
        503,
        'LOGOUT_INCOMPLETE',
        'You are signed out in this browser, but the server could not end your session. Use "Sign out everywhere" or try again later.',
      )
    return reply.code(204).send()
  })

  app.post(REVOKE_ALL_PATH, async (req, reply): Promise<RevokeAllSessionsResponse> => {
    const user = await ctx.requireUser(req)
    revokeAllLimit.take(user.id)
    const revoked = await sessions.revokeAll(user.id)
    sessions.clearCookie(reply)
    let result: RevokeAllSessionsResponse['provider'] = { status: 'none', revoked: 0 }
    if (provider.revokeProviderSessions) {
      try {
        result = await provider.revokeProviderSessions(db, user.id)
      } catch (e) {
        const err = e as { name?: unknown }
        req.log.warn({ reason: err?.name ?? 'error' }, 'identity provider sessions not revoked')
        result = { status: 'failed', revoked: 0 }
      }
    }
    return { revoked: revoked.length, provider: result }
  })
}
