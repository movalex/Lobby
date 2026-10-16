// One POST to a hook's URL through the egress module (wave R, WS2; AGENTS.md "Server egress exception: chat
// notifications"): the provider's rule, the address vetted and pinned, redirects refused, 5 s for the whole request,
// at most 4 KiB of the answer read (and dropped: only the status and Retry-After are used). The URL is wrapped as a
// RedactedSecret while it is in play, so nothing that goes wrong can carry it out; a failure is a code, nothing else.

import { CHAT_HOOK_LIMITS } from '@draftroom/contracts'
import type { ApiConfig } from '../../config.ts'
import {
  CHAT_HOOK_EGRESS_USER_AGENT,
  chatHookEgressPolicy,
  type EgressDeps,
  EgressError,
  egressDeps,
  egressOpen,
  RedactedSecret,
  readBody,
  withSecrets,
} from '../../egress/index.ts'
import { type PostOutcome, parseRetryAfter } from './policy.ts'

/** Posts `payload` (JSON) to `url`; resolves to what happened, never throws. */
export type PostFn = (url: string, payload: Record<string, unknown>) => Promise<PostOutcome>

/** The real poster for this api's config (the fake receiver's origins only behind the local-dev guard). */
export function createPoster(
  test: ApiConfig['chatHookTestOrigins'],
  opts: Partial<Pick<EgressDeps, 'lookup' | 'request' | 'now'>> = {},
): PostFn {
  const deps = egressDeps(chatHookEgressPolicy(test), CHAT_HOOK_EGRESS_USER_AGENT, opts)
  return async (url, payload) => {
    const secret = new RedactedSecret(url)
    const now = opts.now ?? Date.now
    try {
      return await withSecrets([secret], async () => {
        const answer = await egressOpen(deps, {
          method: 'POST',
          url,
          contentType: 'application/json',
          body: JSON.stringify(payload),
          timeoutMs: CHAT_HOOK_LIMITS.requestTimeoutMs,
          maxBytes: CHAT_HOOK_LIMITS.answerBytes,
        })
        // read what little there is so the connection ends cleanly; the words are never kept
        await readBody(answer.body).catch(() => Buffer.alloc(0))
        return {
          kind: 'status' as const,
          status: answer.status,
          retryAfterMs: parseRetryAfter(answer.headers['retry-after'], now()),
        }
      })
    } catch (e) {
      // a failure is its kind and nothing else (EgressError holds no URL, header or body)
      if (e instanceof EgressError)
        return { kind: 'error', code: e.reason === 'too-large' ? 'network' : e.reason }
      return { kind: 'error', code: 'network' }
    }
  }
}
