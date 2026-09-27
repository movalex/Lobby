// Clerk sign-in adapter. UNVERIFIED: no Clerk keys exist yet, so this has only been typechecked
// against @clerk/backend 3.20.1 (verifyToken, createClerkClient().users.getUser) and exercised with
// injected fakes; it has never talked to Clerk. Verify end to end before relying on it.
//
// Flow: the web app signs in with @clerk/react, then POSTs its Clerk session JWT to
// /api/auth/clerk/session (Authorization: Bearer <token>). We verify it (issuer keys fetched with the
// secret key; `azp` must be PUBLIC_ORIGIN), map the Clerk user id (`sub`) to an identities row,
// auto-provision the internal user on first sign-in, and issue our own `dr_session` cookie. Clerk's
// token is never stored or logged.

import { unauthenticated } from '../errors.ts'
import type { AuthProvider } from './provider.ts'
import { findOrCreateUser } from './users.ts'

export const CLERK_EXCHANGE_PATH = '/api/auth/clerk/session'

export interface ClerkProfile {
  name: string
  avatarUrl: string | null
}

export interface ClerkDeps {
  /** Verifies a Clerk session token; resolves with its subject (Clerk user id) or rejects. */
  verify(token: string): Promise<{ sub: string }>
  profile(sub: string): Promise<ClerkProfile>
}

export interface ClerkProviderOptions {
  secretKey: string
  publishableKey: string
  publicOrigin: string
  /** Test seam; defaults call Clerk. */
  deps?: Partial<ClerkDeps>
}

const MAX_TOKEN_LENGTH = 8192

function defaultDeps(opts: ClerkProviderOptions): ClerkDeps {
  // Loaded lazily: dev-provider runs (and tests with fakes) never load the Clerk SDK.
  let sdk: Promise<typeof import('@clerk/backend')> | null = null
  const load = () => {
    sdk ??= import('@clerk/backend')
    return sdk
  }
  return {
    async verify(token) {
      const { verifyToken } = await load()
      const payload = await verifyToken(token, {
        secretKey: opts.secretKey,
        authorizedParties: [opts.publicOrigin],
      })
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject')
      return { sub: payload.sub }
    },
    async profile(sub) {
      const { createClerkClient } = await load()
      const clerk = createClerkClient({ secretKey: opts.secretKey, publishableKey: opts.publishableKey })
      const u = await clerk.users.getUser(sub)
      const email = u.primaryEmailAddress?.emailAddress
      const name = u.fullName ?? u.username ?? (email ? email.split('@')[0] : null) ?? 'Clerk user'
      return { name: name.slice(0, 200) || 'Clerk user', avatarUrl: u.imageUrl || null }
    },
  }
}

export function createClerkAuthProvider(opts: ClerkProviderOptions): AuthProvider {
  const deps: ClerkDeps = { ...defaultDeps(opts), ...opts.deps }
  return {
    id: 'clerk',
    publicConfig: () => ({ providers: ['clerk'], clerkPublishableKey: opts.publishableKey }),
    register(app, ctx) {
      app.post(CLERK_EXCHANGE_PATH, { config: { rateLimit: ctx.rateLimit } }, async (req, reply) => {
        const header = req.headers.authorization
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
        if (!token || token.length > MAX_TOKEN_LENGTH) throw unauthenticated()
        let sub: string
        try {
          ;({ sub } = await deps.verify(token))
        } catch (e) {
          // The reason class only: never the token or its claims.
          ctx.log.warn({ reason: (e as Error)?.name ?? 'error' }, 'clerk token rejected')
          throw unauthenticated()
        }
        let profile: ClerkProfile | null = null
        try {
          profile = await deps.profile(sub)
        } catch (e) {
          // Sign-in still works without a profile; name and avatar are refreshed on the next sign-in.
          ctx.log.warn({ reason: (e as Error)?.name ?? 'error' }, 'clerk profile unavailable')
        }
        return ctx.signIn(req, reply, async (tx, now) => {
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
        })
      })
    },
  }
}
