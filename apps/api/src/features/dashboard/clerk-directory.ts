// The two Clerk Backend API calls that invite-by-email makes, behind a small interface.
//
// UNVERIFIED against a live Clerk instance: typechecked against @clerk/backend 3.20.1
// (`createClerkClient().users.getUserList`, `.invitations.createInvitation`) and exercised with a fake
// client in apps/api/test/features/dashboard/email-invites.test.ts. The SDK is loaded lazily, like
// auth/clerk.ts does, so development servers and tests never load it unless they use Clerk.

import type { ClerkClient } from '@clerk/backend'
import type { EmailInviteFallbackReason } from '@draftroom/contracts'

export interface ClerkDirectory {
  /** Clerk user ids that have `email` (lowercased) as a VERIFIED address. */
  verifiedUserIds(email: string): Promise<string[]>
  /** Sends Clerk's invitation email; the link in it ends at `redirectUrl` once the person signs up. */
  sendInvitation(input: { email: string; redirectUrl: string; expiresInDays: number }): Promise<void>
}

/** A Clerk call slower than this counts as failed (the inviter gets the link instead). */
const CLERK_TIMEOUT_MS = 10_000
/** More accounts than this for one address would be odd; only the first few are considered. */
const MAX_MATCHES = 10

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('Clerk call timed out'), { name: 'TimeoutError' })),
      ms,
    )
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export function createClerkDirectory(keys: { secretKey: string; publishableKey: string }): ClerkDirectory {
  let client: Promise<ClerkClient> | null = null
  const load = () => {
    client ??= import('@clerk/backend').then(({ createClerkClient }) =>
      createClerkClient({ secretKey: keys.secretKey, publishableKey: keys.publishableKey }),
    )
    return client
  }
  return {
    async verifiedUserIds(email) {
      const clerk = await load()
      const { data } = await withTimeout(
        clerk.users.getUserList({ emailAddress: [email], limit: MAX_MATCHES }),
        CLERK_TIMEOUT_MS,
      )
      // Checked here as well: only a verified address proves the account is that person's.
      return data
        .filter((u) =>
          u.emailAddresses.some(
            (a) => a.emailAddress.toLowerCase() === email && a.verification?.status === 'verified',
          ),
        )
        .map((u) => u.id)
    },
    async sendInvitation({ email, redirectUrl, expiresInDays }) {
      const clerk = await load()
      await withTimeout(
        clerk.invitations.createInvitation({
          emailAddress: email,
          redirectUrl,
          notify: true,
          // Also when an earlier invitation to this address is still pending (another board, say):
          // each board's email carries its own link.
          ignoreExisting: true,
          expiresInDays,
        }),
        CLERK_TIMEOUT_MS,
      )
    },
  }
}

export interface ClerkFailure {
  reason: Exclude<EmailInviteFallbackReason, 'email_not_configured'>
  /** For the server log only: HTTP status, Clerk error codes and trace id, never messages (they can quote the address). */
  status: number | null
  codes: string[]
  traceId: string | null
}

interface ClerkErrorLike {
  name?: unknown
  status?: unknown
  clerkTraceId?: unknown
  errors?: { code?: unknown; meta?: { paramName?: unknown } }[]
}

const RATE_LIMIT_CODES = new Set(['too_many_requests', 'rate_limit_exceeded', 'quota_exceeded'])
const EXISTS_CODES = new Set(['form_identifier_exists'])

/**
 * Maps a failed Clerk call (a ClerkAPIResponseError: `status`, `errors[].code`, `errors[].meta`) to
 * what the inviter is told. Anything unrecognised (network errors, timeouts, 5xx) is `provider_error`.
 */
export function classifyClerkError(e: unknown): ClerkFailure {
  const err = (typeof e === 'object' && e !== null ? e : {}) as ClerkErrorLike
  const status = typeof err.status === 'number' ? err.status : null
  const list = Array.isArray(err.errors) ? err.errors : []
  const codes = list
    .map((x) => (typeof x?.code === 'string' ? x.code.slice(0, 64) : ''))
    .filter(Boolean)
    .slice(0, 5)
  const traceId = typeof err.clerkTraceId === 'string' ? err.clerkTraceId.slice(0, 64) : null
  const aboutEmail = list.some((x) => x?.meta?.paramName === 'email_address')
  let reason: ClerkFailure['reason'] = 'provider_error'
  if (status === 429 || codes.some((c) => RATE_LIMIT_CODES.has(c))) reason = 'rate_limited'
  else if (codes.some((c) => EXISTS_CODES.has(c))) reason = 'existing_account'
  else if (aboutEmail && status !== null && status >= 400 && status < 500) reason = 'invalid_email'
  return { reason, status, codes, traceId }
}
