// A fake Clerk Backend API for the domain-access tests. A test file replaces the SDK with it:
//
//   vi.mock('@clerk/backend', async () => (await import('./clerk-fake.ts')).clerkBackendModule)
//
// so the real adapter code (auth/clerk.ts defaultDeps.profile: users.getUser, the 10 s timeout,
// verifiedProfileEmails) runs against it. Token verification is faked through the provider's `deps`
// (a token `token-<sub>` verifies as <sub>). Errors are the SDK's own ClerkAPIResponseError (from
// '@clerk/backend/errors', which is not replaced), like email-invites.test.ts.

import { ClerkAPIResponseError } from '@clerk/backend/errors'
import type { Db } from '@draftroom/db'
import type { LightMyRequestResponse } from 'fastify'
import { createClerkAuthProvider } from '../../../src/auth/clerk.ts'
import { type Client, createTestApi, ORIGIN, type TestApi } from '../../helpers.ts'

export interface FakeEmailAddress {
  id: string
  emailAddress: string
  verification: { status: string; strategy: string } | null
}

export interface FakeClerkUser {
  id: string
  fullName: string | null
  username: string | null
  imageUrl: string
  primaryEmailAddressId: string | null
  primaryEmailAddress: FakeEmailAddress | null
  emailAddresses: FakeEmailAddress[]
  banned: boolean
  locked: boolean
}

type Failure = () => unknown

export const fakeClerk = {
  users: new Map<string, FakeClerkUser>(),
  /** Every users.getUser call, in order (the refresh tests count them). */
  calls: [] as string[],
  /** Per Clerk user id: the next calls fail with this (until cleared). */
  failures: new Map<string, Failure>(),
  /** When set, every getUser waits for it (single-flight and ordering tests). */
  gate: null as Promise<void> | null,
  /** Invitation emails Clerk was asked to send (invite by email). */
  invitations: [] as Record<string, unknown>[],
  reset() {
    this.users.clear()
    this.calls = []
    this.failures.clear()
    this.gate = null
    this.invitations = []
  },
}

export const clerkError = (status: number, code: string, message = 'Clerk says pat@client.example.test') =>
  new ClerkAPIResponseError(message, {
    status,
    clerkTraceId: 'trace-da',
    data: [{ code, message, long_message: `${message} (long)`, meta: {} }],
  })

export const notFound = () => clerkError(404, 'resource_not_found', 'No user pat@client.example.test')

/** The module that replaces '@clerk/backend'. */
export const clerkBackendModule = {
  createClerkClient: () => ({
    users: {
      getUser: async (id: string) => {
        fakeClerk.calls.push(id)
        if (fakeClerk.gate) await fakeClerk.gate
        const fail = fakeClerk.failures.get(id)
        if (fail) throw fail()
        const u = fakeClerk.users.get(id)
        if (!u) throw notFound()
        return u
      },
      // Like Clerk: an exact (case-insensitive) address filter, verified or not.
      getUserList: async (params: { emailAddress?: string[] }) => {
        const wanted = new Set((params.emailAddress ?? []).map((e) => e.toLowerCase()))
        const data = [...fakeClerk.users.values()].filter((u) =>
          u.emailAddresses.some((a) => wanted.has(a.emailAddress.toLowerCase())),
        )
        return { data, totalCount: data.length }
      },
    },
    invitations: {
      createInvitation: async (params: Record<string, unknown>) => {
        fakeClerk.invitations.push(params)
        return { id: 'inv_clerk_fake' }
      },
    },
    sessions: {
      getSessionList: async () => ({ data: [] }),
      revokeSession: async () => ({}),
    },
  }),
}

type EmailSpec = string | { email: string; status?: string | null; strategy?: string }

/** A Clerk user; the first address is the primary one; addresses are verified unless said otherwise. */
export function clerkUser(
  id: string,
  emails: EmailSpec[],
  opts: { name?: string; banned?: boolean; locked?: boolean; primary?: number } = {},
): FakeClerkUser {
  const addresses: FakeEmailAddress[] = emails.map((spec, i) => {
    const s = typeof spec === 'string' ? { email: spec } : spec
    const status = s.status === undefined ? 'verified' : s.status
    return {
      id: `idn_${id}_${i}`,
      emailAddress: s.email,
      verification: status === null ? null : { status, strategy: s.strategy ?? 'email_code' },
    }
  })
  const primary = addresses[opts.primary ?? 0] ?? null
  const user: FakeClerkUser = {
    id,
    fullName: opts.name ?? `Name of ${id}`,
    username: null,
    imageUrl: '',
    primaryEmailAddressId: primary?.id ?? null,
    primaryEmailAddress: primary,
    emailAddresses: addresses,
    banned: opts.banned ?? false,
    locked: opts.locked ?? false,
  }
  fakeClerk.users.set(id, user)
  return user
}

export const CLERK_KEYS = { secretKey: 'sk_test_domain_access_0123456789', publishableKey: 'pk_test_da' }

/**
 * Fixer round 4 (docs/DOMAIN-ACCESS-CONTRACTS.md §22): PGlite behaving like a connection pool for one
 * read. The next `api.db.query` whose SQL matches first waits for every identity refresh already
 * running to finish, as if that refresh's write had committed on another pooled connection before the
 * read. (PGlite runs every statement on one connection in order, which hid a response that mixed stored
 * and refreshed data; on a real Postgres with the fake Clerk answering at once the refresh often won.)
 * A refresh that has not started yet is not waited for. Returns the undo.
 */
export function refreshCommitsBefore(api: TestApi, sql: RegExp): () => void {
  const db = api.db
  const original = db.query
  let armed = true
  db.query = (async (text: string, params?: readonly unknown[]) => {
    if (armed && sql.test(text)) {
      armed = false
      // Bounded, so a mistake in the pattern (a read the refresh itself makes) fails instead of hanging.
      await Promise.race([api.identity.settled(), new Promise((r) => setTimeout(r, 5_000))])
    }
    return original(text, params)
  }) as typeof db.query
  return () => {
    db.query = original
  }
}

/** The stored-address read of identity.status (GET /api/me `access`). */
export const STATUS_READ = /FROM user_emails WHERE user_id = \$1 AND source = \$2/
/** The creator read of isCreatorUser / canOwnAmong (the Share dialog's lists). */
export const CREATOR_READ = /FROM users u WHERE u\.id = ANY\(\$1::text\[\]\)/

export interface ClerkWorld {
  api: TestApi
  logs: string[]
  /** POST /api/auth/clerk/session for this Clerk user id. */
  exchange(sub: string): Promise<LightMyRequestResponse>
  /** Signs in (must answer 200) and returns a client with that session. */
  signIn(sub: string): Promise<Client>
}

export async function clerkWorld(
  opts: {
    env?: Record<string, string>
    domainAccessGuard?: boolean
    /** Another api over this (migrated) database: a second process, e.g. a deploy overlap. */
    db?: Db
  } = {},
) {
  const logs: string[] = []
  const api = await createTestApi({
    env: {
      AUTH_PROVIDER: 'clerk',
      CLERK_SECRET_KEY: CLERK_KEYS.secretKey,
      CLERK_PUBLISHABLE_KEY: CLERK_KEYS.publishableKey,
      ...opts.env,
    },
    ...(opts.domainAccessGuard === false ? { domainAccessGuard: false } : {}),
    ...(opts.db ? { db: opts.db } : {}),
    deps: {
      logger: { level: 'debug', stream: { write: (line: string) => void logs.push(line) } },
      authProvider: createClerkAuthProvider({
        ...CLERK_KEYS,
        publicOrigin: ORIGIN,
        deps: {
          verify: async (token) => {
            if (!token.startsWith('token-')) throw new Error('invalid')
            return { sub: token.slice('token-'.length) }
          },
        },
      }),
    },
  })
  const exchange = (sub: string) =>
    api.anon('POST', '/api/auth/clerk/session', undefined, { authorization: `Bearer token-${sub}` })
  const signIn = async (sub: string): Promise<Client> => {
    const res = await exchange(sub)
    if (res.statusCode !== 200) throw new Error(`clerk sign-in ${sub}: ${res.statusCode} ${res.body}`)
    const cookie = res.cookies.find((c) => c.name === 'dr_session')
    if (!cookie) throw new Error('no session cookie')
    const me = res.json() as Client['me']
    const personal = me.workspaces.find((w) => w.name.endsWith("'s workspace") && w.role === 'owner')
    return {
      me,
      userId: me.user.id,
      personalWorkspaceId: personal?.id ?? '',
      cookie: `dr_session=${cookie.value}`,
      req: (method, url, body, headers = {}) =>
        api.app.inject({
          method,
          url,
          ...(body === undefined ? {} : { payload: body as object }),
          headers: { origin: ORIGIN, cookie: `dr_session=${cookie.value}`, ...headers },
        }),
    }
  }
  const world: ClerkWorld = { api, logs, exchange, signIn }
  return world
}
