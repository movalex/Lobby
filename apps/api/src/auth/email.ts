// Open email sign-in (docs/OPEN-SIGNIN.md): anyone can sign in with any address and a display name.
// Nothing is verified, so whoever types an address IS that account. Only for a server with nothing
// private on it (the theater instance): constructed only for AUTH_PROVIDER=email, which config.ts
// accepts only together with DRAFTROOM_OPEN_SIGNIN=1.
//
// Everyone who signs in is a creator (creator-sql.ts: the open policy) and joins the one shared
// workspace (shared-workspace.ts) as a member. Nobody gets a personal workspace.

import { EmailLoginInput } from '@draftroom/contracts'
import { parse } from '../errors.ts'
import type { AuthProvider } from './provider.ts'
import { joinSharedWorkspace } from './shared-workspace.ts'
import { findOrCreateUser, stampIdentityChecked } from './users.ts'

export const EMAIL_LOGIN_PATH = '/api/auth/email/login'

export interface EmailProviderOptions {
  /** DRAFTROOM_SHARED_WORKSPACE_NAME. */
  workspaceName: string
}

export function createEmailAuthProvider(opts: EmailProviderOptions): AuthProvider {
  let clock: () => Date = () => new Date()
  return {
    id: 'email',
    personalWorkspaces: false,
    publicConfig: () => ({ providers: ['email'], sharedWorkspaceName: opts.workspaceName }),
    register(app, ctx) {
      clock = ctx.now
      app.post(EMAIL_LOGIN_PATH, { config: { rateLimit: ctx.rateLimit } }, async (req, reply) => {
        const input = parse(EmailLoginInput, req.body)
        return ctx.signIn(req, reply, async (tx, now) => {
          // The shared workspace first: it is then listed before anything the person creates.
          const { user } = await findOrCreateUser(
            tx,
            {
              provider: 'email',
              subject: input.email,
              name: input.name,
              handle: null,
              avatarUrl: null,
              // Each sign-in may change the display name (people share a computer at the theater).
              refreshProfile: true,
              emails: [{ email: input.email, isPrimary: true, strategy: null }],
              fetchedAt: now,
              authoritative: true,
              personalWorkspace: false,
            },
            now,
            ctx.creators,
          )
          await joinSharedWorkspace(tx, opts.workspaceName, user.id, now)
          return user
        })
      })
    },
    // Never a network call: there is nobody to ask. Stamps identity_checked_at so an account never turns
    // 'unconfirmed' (and so never stops being a creator) between sign-ins.
    async refreshIdentity(db, userId, fetchedAt) {
      await db.transaction((tx) => stampIdentityChecked(tx, userId, fetchedAt, { now: clock() }))
      return 'ok'
    },
  }
}
