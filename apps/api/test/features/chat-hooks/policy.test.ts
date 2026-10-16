// What a webhook's answer means for a delivery (wave R, WS2; src/features/chat-hooks/policy.ts, contracts CHAT_DELIVERY).

import { CHAT_DELIVERY } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  CODE_PATTERN,
  decide,
  MAX_DELIVERY_AGE_MS,
  type PostOutcome,
  parseRetryAfter,
} from '../../../src/features/chat-hooks/policy.ts'

const status = (s: number, retryAfterMs: number | null = null): PostOutcome => ({
  kind: 'status',
  status: s,
  retryAfterMs,
})
const failure = (code: 'timeout' | 'network' | 'blocked' | 'refused' | 'redirect'): PostOutcome => ({
  kind: 'error',
  code,
})

describe('decide', () => {
  it('2xx is sent (Slack 200, Teams 202 = queued there)', () => {
    expect(decide(status(200), 1, 0)).toEqual({ action: 'sent', code: '200' })
    expect(decide(status(202), 3, 0)).toEqual({ action: 'sent', code: '202' })
  })

  it('5xx, 408, 425, a timeout and a network error back off 30 s, 2 min, 10 min, 30 min, 2 h, then fail', () => {
    const retryable = [
      status(500),
      status(503),
      status(408),
      status(425),
      failure('timeout'),
      failure('network'),
      failure('blocked'),
    ]
    for (const outcome of retryable) {
      for (let attempts = 1; attempts <= CHAT_DELIVERY.backoffMs.length; attempts++)
        expect(decide(outcome, attempts, 1_000)).toMatchObject({
          action: 'retry',
          delayMs: CHAT_DELIVERY.backoffMs[attempts - 1],
          spendsTry: true,
        })
      expect(decide(outcome, CHAT_DELIVERY.backoffMs.length + 1, 1_000).action).toBe('fail')
    }
    expect(CHAT_DELIVERY.backoffMs).toEqual([30_000, 120_000, 600_000, 1_800_000, 7_200_000])
  })

  it('429 waits Retry-After (default 30 s, at least 1 s, at most 10 min) and spends no try', () => {
    expect(decide(status(429, 90_000), 1, 0)).toEqual({
      action: 'retry',
      code: '429',
      delayMs: 90_000,
      spendsTry: false,
    })
    expect(decide(status(429), 1, 0)).toMatchObject({ delayMs: 30_000 })
    expect(decide(status(429, 0), 1, 0)).toMatchObject({ delayMs: 1_000 })
    expect(decide(status(429, 86_400_000), 4, 0)).toMatchObject({ delayMs: CHAT_DELIVERY.maxRetryAfterMs })
  })

  it('a row older than six hours is not retried again, whatever the reason', () => {
    expect(decide(status(429, 1_000), 1, MAX_DELIVERY_AGE_MS + 1)).toEqual({ action: 'fail', code: '429' })
    expect(decide(status(500), 1, MAX_DELIVERY_AGE_MS + 1)).toEqual({ action: 'fail', code: '500' })
  })

  it('401 and 403 switch the hook off (forbidden), 404 (not-found), 410 (gone)', () => {
    expect(decide(status(401), 1, 0)).toEqual({ action: 'disable', code: '401', reason: 'forbidden' })
    expect(decide(status(403), 1, 0)).toEqual({ action: 'disable', code: '403', reason: 'forbidden' })
    expect(decide(status(404), 1, 0)).toEqual({ action: 'disable', code: '404', reason: 'not-found' })
    expect(decide(status(410), 1, 0)).toEqual({ action: 'disable', code: '410', reason: 'gone' })
  })

  it('a redirect (gone) or a URL the rules refuse (retired) switches the hook off; 400 and other 4xx fail at once', () => {
    expect(decide(failure('redirect'), 1, 0)).toMatchObject({ action: 'disable', reason: 'gone' })
    expect(decide(failure('refused'), 1, 0)).toMatchObject({ action: 'disable', reason: 'retired' })
    for (const s of [400, 405, 413, 422])
      expect(decide(status(s), 1, 0)).toEqual({ action: 'fail', code: String(s) })
  })

  it('every code it can produce fits the 0036 CHECK on last_code', () => {
    const outcomes: PostOutcome[] = [200, 202, 400, 401, 403, 404, 410, 429, 500, 503, 599].map((s) =>
      status(s),
    )
    for (const code of ['timeout', 'network', 'blocked', 'refused', 'redirect'] as const)
      outcomes.push(failure(code))
    for (const o of outcomes) expect(decide(o, 1, 0).code).toMatch(CODE_PATTERN)
  })
})

describe('parseRetryAfter', () => {
  it('reads whole seconds and HTTP dates; anything else is nothing', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000)
    expect(parseRetryAfter(' 5 ', 0)).toBe(5_000)
    const date = 'Wed, 21 Oct 2026 07:28:30 GMT'
    expect(parseRetryAfter(date, Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(30_000)
    expect(parseRetryAfter(date, Date.parse('Thu, 22 Oct 2026 07:28:00 GMT'))).toBe(0)
    for (const bad of [undefined, '', 'soon', '-5', '1.5', '99999999'])
      expect(parseRetryAfter(bad, 0)).toBeNull()
  })
})
