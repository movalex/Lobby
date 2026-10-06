// Who reads the feedback inbox (wave J5): accounts whose stored VERIFIED address, for the sign-in provider
// the api RUNS, is in DRAFTROOM_FEEDBACK_ADMINS (./admins.ts). The same trust as the creator rule
// (docs/DOMAIN-ACCESS-CONTRACTS.md): the addresses come from user_emails, which only the provider's
// verified addresses ever reach; a name-only guest has none; and the person's identity must have been
// confirmed with the provider within the grace window (auth/creator-sql.ts IDENTITY_GRACE_MS), else it is
// confirmed first (an awaited refresh; 503 when the provider cannot be reached: fails closed, never open).
//
// A person whose stored addresses do not match costs nothing but one query: no provider call is made for
// them, so the inbox probe (GET /api/feedback/access, asked once per page load) cannot be used to make the
// api call the provider.

import type { FastifyRequest } from 'fastify'
import { isConfirmed } from '../../auth/creator-sql.ts'
import type { SessionUser } from '../../auth/session.ts'
import { storedEmails } from '../../auth/users.ts'
import type { AppContext } from '../../context.ts'

export type AdminCheck = (req: FastifyRequest, user: SessionUser) => Promise<boolean>

export function createAdminCheck(ctx: AppContext): AdminCheck {
  // Never under open email sign-in, whose addresses are typed, not verified (config.ts refuses the pair).
  const admins = new Set(ctx.identity.lookup.source === 'email' ? [] : ctx.config.feedbackAdmins)
  const listed = async (user: SessionUser) =>
    (await storedEmails(ctx.db, user.id, ctx.identity.lookup.source)).some((e) => admins.has(e))

  return async (req, user) => {
    if (user.kind !== 'account' || admins.size === 0) return false
    if (!(await listed(user))) return false
    if (isConfirmed(user.identityCheckedAt, ctx.now())) return true
    // Listed, but not confirmed lately: confirm with the provider, then decide on the new stored state.
    const fresh = await ctx.identity.freshen(req, user, 'confirm', { strict: true })
    return isConfirmed(fresh.identityCheckedAt, ctx.now()) && (await listed(fresh))
  }
}
