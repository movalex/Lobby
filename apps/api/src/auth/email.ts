// Open sign-in (docs/OPEN-SIGNIN.md): a server with nothing private on it (the theater instance), where
// anyone may come in. Constructed only for AUTH_PROVIDER=email, which config.ts accepts only together with
// DRAFTROOM_OPEN_SIGNIN=1. DRAFTROOM_OPEN_SIGNIN_METHODS chooses the ways in:
//
//   - email:  POST /api/auth/email/login {email, name}. Nothing is verified, so whoever types an address IS
//             that account.
//   - google: POST /api/auth/google/login {credential}: "Sign in with Google" (Google Identity Services).
//             The address is the one Google verified (google-id-token.ts); any Google account, any domain.
//
// Either way the account is keyed by the lowercase address (identities provider 'email'), so the same
// person lands in the same account whichever way they came in. Everyone who signs in is a creator
// (creator-sql.ts: the open policy) and joins the one shared workspace (shared-workspace.ts) as a member.
// Nobody gets a personal workspace.

import { cleanDisplayText, EmailLoginInput, GoogleLoginInput } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { OpenSigninMethod } from '../config.ts'
import { ApiError, parse } from '../errors.ts'
import { normalizeEmail } from './creators.ts'
import { createGoogleVerifier, type GoogleIdentity, GoogleTokenError } from './google-id-token.ts'
import type { AuthProvider, SignInContext } from './provider.ts'
import type { SessionUser } from './session.ts'
import { joinSharedWorkspace } from './shared-workspace.ts'
import { findOrCreateUser, stampIdentityChecked } from './users.ts'

export const EMAIL_LOGIN_PATH = '/api/auth/email/login'
export const GOOGLE_LOGIN_PATH = '/api/auth/google/login'

export interface EmailProviderOptions {
  /** DRAFTROOM_SHARED_WORKSPACE_NAME. */
  workspaceName: string
  /** DRAFTROOM_OPEN_SIGNIN_METHODS (default email). */
  methods?: readonly OpenSigninMethod[]
  /** DRAFTROOM_GOOGLE_CLIENT_ID: required when methods include google. */
  googleClientId?: string | null
  /** Test seam: verifies a Google ID token (default: google-id-token.ts against Google's keys). */
  verifyGoogle?: (credential: string) => Promise<GoogleIdentity>
}

const googleRefused = () =>
  new ApiError(401, 'GOOGLE_SIGN_IN_FAILED', 'Google sign-in did not go through. Try again.')

export function createEmailAuthProvider(opts: EmailProviderOptions): AuthProvider {
  const methods = opts.methods?.length ? [...opts.methods] : (['email'] as OpenSigninMethod[])
  const google = methods.includes('google')
  if (google && !opts.googleClientId && !opts.verifyGoogle)
    throw new Error('open sign-in with google needs DRAFTROOM_GOOGLE_CLIENT_ID')
  const verifyGoogle =
    opts.verifyGoogle ?? (google ? createGoogleVerifier({ clientId: opts.googleClientId as string }) : null)
  let clock: () => Date = () => new Date()

  /** Provisions the account for a (normalised) address and joins the shared workspace. */
  const provision =
    (ctx: SignInContext, email: string, name: string) =>
    async (tx: Queryable, now: Date): Promise<SessionUser> => {
      const { user } = await findOrCreateUser(
        tx,
        {
          provider: 'email',
          subject: email,
          name,
          handle: null,
          avatarUrl: null,
          // Each sign-in may change the display name (people share a computer at the theater).
          refreshProfile: true,
          emails: [{ email, isPrimary: true, strategy: null }],
          fetchedAt: now,
          authoritative: true,
          personalWorkspace: false,
        },
        now,
        ctx.creators,
      )
      await joinSharedWorkspace(tx, opts.workspaceName, user.id, now)
      return user
    }

  return {
    id: 'email',
    personalWorkspaces: false,
    publicConfig: () => ({
      providers: ['email'],
      sharedWorkspaceName: opts.workspaceName,
      openSigninMethods: methods,
      ...(google && opts.googleClientId ? { googleClientId: opts.googleClientId } : {}),
    }),
    register(app, ctx) {
      clock = ctx.now
      if (methods.includes('email'))
        app.post(EMAIL_LOGIN_PATH, { config: { rateLimit: ctx.rateLimit } }, async (req, reply) => {
          const input = parse(EmailLoginInput, req.body)
          return ctx.signIn(req, reply, provision(ctx, input.email, input.name))
        })
      if (verifyGoogle)
        app.post(GOOGLE_LOGIN_PATH, { config: { rateLimit: ctx.rateLimit } }, async (req, reply) => {
          const { credential } = parse(GoogleLoginInput, req.body)
          let identity: GoogleIdentity
          try {
            identity = await verifyGoogle(credential)
          } catch (e) {
            // The reason is logged without the token; the page only learns that it did not work.
            ctx.log.warn(
              { evt: 'google.signin_refused', reason: e instanceof GoogleTokenError ? e.message : 'error' },
              'google sign-in refused',
            )
            throw googleRefused()
          }
          const email = normalizeEmail(identity.email)
          if (!email) throw googleRefused()
          // Wave J: the profile name without control, bidi or zero-width characters, like a typed one.
          const name = (cleanDisplayText(identity.name ?? '') || email.slice(0, email.indexOf('@'))).slice(
            0,
            80,
          )
          return ctx.signIn(req, reply, provision(ctx, email, name))
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
