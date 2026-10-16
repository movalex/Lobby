// What a webhook's answer means for a delivery (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4, contracts CHAT_DELIVERY).
// Pure: the delivery loop (deliver.ts) asks, then writes. Codes are short lower-case words only (the 0036 CHECK on
// `last_code` and `last_error_code`): an HTTP status as text, `timeout`, `network`, … — never the receiver's words.
//
//   2xx                      sent (Slack answers `ok`; Teams Workflows answers 202 = queued there: "sent", never "delivered")
//   429                      wait Retry-After (default 30 s, at most 10 min); does not use up a try, until the row is 6 h old
//   408, 425, 5xx, timeout,  back off 30 s, 2 min, 10 min, 30 min, 2 h, then failed (6 tries in all)
//   network, blocked
//   401, 403                 the hook is switched off ("forbidden")
//   404                      the hook is switched off ("not-found")
//   410                      the hook is switched off ("gone")
//   redirect, refused        a webhook never redirects, and a URL the rules no longer allow is retired: switched off
//   anything else (400, …)   failed, no retry: a Lobby bug if it was a 400

import { CHAT_DELIVERY, type ChatHookDisableReason } from '@draftroom/contracts'

export type PostOutcome =
  | { kind: 'status'; status: number; retryAfterMs: number | null }
  | { kind: 'error'; code: 'timeout' | 'network' | 'blocked' | 'refused' | 'redirect' }

export type Decision =
  | { action: 'sent'; code: string }
  | { action: 'retry'; code: string; delayMs: number; spendsTry: boolean }
  | { action: 'fail'; code: string }
  | { action: 'disable'; code: string; reason: ChatHookDisableReason }

/** Past this age a row is not retried again (429s alone would otherwise keep it for ever). */
export const MAX_DELIVERY_AGE_MS = 6 * 3_600_000

/** The codes a stored `last_code` may hold. */
export const CODE_PATTERN = /^[a-z0-9-]{1,32}$/

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** A Retry-After header: whole seconds or an HTTP date; null when it is neither. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d{1,7}$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs)
}

/**
 * `attempts` is this try's number (1 for the first). `ageMs` is how long ago the row was queued.
 */
export function decide(outcome: PostOutcome, attempts: number, ageMs: number): Decision {
  const tooOld = ageMs > MAX_DELIVERY_AGE_MS
  const retryable = (code: string): Decision =>
    attempts <= CHAT_DELIVERY.backoffMs.length && !tooOld
      ? {
          action: 'retry',
          code,
          delayMs: CHAT_DELIVERY.backoffMs[attempts - 1] ?? CHAT_DELIVERY.backoffMs.at(-1) ?? 0,
          spendsTry: true,
        }
      : { action: 'fail', code }
  if (outcome.kind === 'error') {
    if (outcome.code === 'redirect' || outcome.code === 'refused')
      return {
        action: 'disable',
        code: outcome.code,
        reason: outcome.code === 'redirect' ? 'gone' : 'retired',
      }
    return retryable(outcome.code)
  }
  const { status } = outcome
  const code = String(status)
  if (status >= 200 && status < 300) return { action: 'sent', code }
  if (status === 429) {
    if (tooOld) return { action: 'fail', code }
    const wait = clamp(outcome.retryAfterMs ?? 30_000, 1_000, CHAT_DELIVERY.maxRetryAfterMs)
    return { action: 'retry', code, delayMs: wait, spendsTry: false }
  }
  if (status === 401 || status === 403) return { action: 'disable', code, reason: 'forbidden' }
  if (status === 404) return { action: 'disable', code, reason: 'not-found' }
  if (status === 410) return { action: 'disable', code, reason: 'gone' }
  if (status === 408 || status === 425 || status >= 500) return retryable(code)
  return { action: 'fail', code }
}
