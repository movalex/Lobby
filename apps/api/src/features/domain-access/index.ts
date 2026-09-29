// Feature module: domain access (docs/DOMAIN-ACCESS-CONTRACTS.md). Only creators (a verified address at
// a creator domain, or on the exceptions list) create workspaces, projects and boards and hand out
// access; everyone else gets only what they are invited to.
//
// - guard.ts: the root guard over CREATOR_ROUTES (registered right after the guest guard).
//
// Elsewhere (the API owner's files): the policy (auth/creators.ts), creator status and identity
// freshness (auth/creator-sql.ts, auth/identity.ts), the addresses stored at sign-in (auth/users.ts,
// auth/dev.ts, auth/clerk.ts), the in-route creator checks (routes/*, features/dashboard/*,
// features/history/*), the invitation email lock (routes/invitations.ts) and Me.access (routes/auth.ts).
import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { registerDomainAccessGuard } from './guard.ts'

export interface DomainAccessOptions {
  /** TEST-ONLY seam (creation matrix): false leaves the root guard out. */
  guard: boolean
}

export async function registerDomainAccess(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: DomainAccessOptions,
): Promise<void> {
  if (opts.guard) registerDomainAccessGuard(app, ctx)
}
