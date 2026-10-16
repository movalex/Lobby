// The api's shared outbound-request module (wave R foundation; AGENTS.md "Server egress exception: Miro import" and
// "…: chat notifications"). OWNER: the lead; WS1 (Miro import) and WS2 (chat notifications) use it and do not edit it.
//
//   policy.ts  which requests a rule allows (exact host, https:443, paths, methods, Bearer, a URL check; the seam)
//   rules.ts   the two exceptions' rules and policies, built from the contracts (MIRO_*, CHAT_HOOK_RULES)
//   fetch.ts   the request: vetted and pinned address, no redirects, one deadline, a byte cap, kept headers only
//   secret.ts  RedactedSecret (a token in memory that prints as [redacted]) and redact()
//   here       withSecrets (whatever a step throws leaves without a secret) and errorFacts (what a log may say)
//
// Link previews keep their own fetch (features/link-preview: http allowed, redirects followed and re-checked); this
// module shares their address rules and DNS lookup. Nothing here logs.

import { ApiError } from '../errors.ts'
import { makeSystemLookup } from '../features/link-preview/dns.ts'
import { EgressError, type EgressDeps } from './fetch.ts'
import type { EgressPolicy } from './policy.ts'
import { REDACTED, type RedactedSecret, redact } from './secret.ts'

export {
  EGRESS_RESPONSE_HEADERS,
  type EgressAnswer,
  type EgressDeps,
  EgressError,
  type EgressReason,
  type EgressRequest,
  type EgressResponse,
  type EgressStream,
  egressFetch,
  egressOpen,
  readBody,
} from './fetch.ts'
export {
  checkTarget,
  type EgressMethod,
  type EgressPolicy,
  type EgressTarget,
  type HostRule,
  makeEgressPolicy,
  type PolicyRefusal,
} from './policy.ts'
export {
  CHAT_HOOK_EGRESS_USER_AGENT,
  chatHookEgressPolicy,
  MIRO_API_RULE,
  MIRO_EGRESS_USER_AGENT,
  MIRO_FILE_RULE,
  miroEgressPolicy,
  SLACK_HOOK_RULE,
  signedUrlLive,
  TEAMS_HOOK_RULE,
} from './rules.ts'
export { REDACTED, RedactedSecret, redact } from './secret.ts'

/** Egress dependencies for a policy (the system lookup unless a test gives one). */
export function egressDeps(
  policy: EgressPolicy,
  userAgent: string,
  opts: Partial<Pick<EgressDeps, 'lookup' | 'request' | 'now' | 'lookupTimeoutMs'>> = {},
): EgressDeps {
  return { policy, userAgent, lookup: opts.lookup ?? makeSystemLookup(), ...opts }
}

/** An error from a step that ran with secrets, rebuilt so it holds none: its class name and a code only. */
export class SecretSafeError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`failed: ${code}`)
    this.name = 'SecretSafeError'
    this.code = code
  }
  toJSON() {
    return { name: this.name, code: this.code }
  }
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * Runs `fn` with `secrets` in play (a Miro token, a hook's opened URL). Whatever it throws leaves as an error that
 * cannot carry one: an EgressError as it is (it never holds one), an ApiError with its message scrubbed (its code
 * and status kept), anything else as a SecretSafeError holding only an upper-case code (the error's own `code` when
 * it has one of that shape, else INTERNAL). A foreign error's message, stack and cause are dropped: another service's
 * answer, a URL or a header could be quoted in any of them.
 */
export async function withSecrets<T>(
  secrets: readonly RedactedSecret[],
  fn: () => Promise<T>,
  /** errors of the caller's own classes that carry codes only (the runner's stop and failure): kept as they are */
  keep: (e: unknown) => boolean = () => false,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw keep(e) ? e : secretSafe(e, secrets)
  }
}

/** The error `withSecrets` throws for `e`. */
export function secretSafe(e: unknown, secrets: readonly RedactedSecret[]): Error {
  if (e instanceof EgressError || e instanceof SecretSafeError) return e
  if (e instanceof ApiError) {
    const message = redact(e.message, secrets)
    return message === e.message && !secrets.some((s) => s.isIn(e.code))
      ? e
      : new ApiError(e.status, CODE_RE.test(e.code) ? e.code : 'INTERNAL', message, { ...e.headers })
  }
  const code = (e as { code?: unknown } | null)?.code
  return new SecretSafeError(typeof code === 'string' && CODE_RE.test(code) ? code : 'INTERNAL')
}

/** What a log line may say about an error from an outbound step: its kind and codes, never a message. */
export function errorFacts(e: unknown): Record<string, string | number | null> {
  if (e instanceof EgressError) return { name: e.name, reason: e.reason, status: e.status, detail: e.detail }
  if (e instanceof ApiError) return { name: e.name, code: e.code, status: e.status }
  if (e instanceof SecretSafeError) return { name: e.name, code: e.code }
  const name = (e as { name?: unknown } | null)?.name
  return { name: typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : REDACTED }
}
