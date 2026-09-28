// In-memory rate limits keyed on what a route knows AFTER authentication (a user id, a link token's
// hash, a Clerk subject), where @fastify/rate-limit's onRequest hook only knows the client IP. One
// API instance (docs/DEPLOY.md): several instances would each keep their own windows, which can only
// let a key through more often, never block anyone else.

import { ApiError } from './errors.ts'

export interface RouteRateLimit {
  max: number
  timeWindow: number
}

/**
 * At most `max` takes per key within any `windowMs` (a sliding window over the last `max` accepted
 * timestamps). Refused takes do not count. Bounded: past `maxKeys` keys the least recently used one
 * is forgotten (which can only let that key through early, never block anyone).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly maxKeys: number

  constructor(max: number, windowMs: number, maxKeys = 10_000) {
    this.max = max
    this.windowMs = windowMs
    this.maxKeys = maxKeys
  }

  /** Records a take at `atMs` if the key is under its limit; returns whether it was allowed. */
  take(key: string, atMs: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(atMs)
    // Re-insert so the Map's order is least-recently-used first.
    this.hits.delete(key)
    this.hits.set(key, list)
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value
      if (oldest === undefined) break
      this.hits.delete(oldest)
    }
    return true
  }

  /** How long until `key` may take again (0 = now). Does not count anything. */
  retryAfterMs(key: string, atMs: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs)
    if (list.length < this.max) return 0
    const first = list[0] ?? atMs
    return Math.max(0, first + this.windowMs - atMs)
  }
}

export const RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.'

/** 429 with Retry-After (whole seconds, at least 1). */
export function rateLimited(retryAfterMs: number, message = RATE_LIMITED_MESSAGE): ApiError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new ApiError(429, 'RATE_LIMITED', message, { 'retry-after': String(seconds) })
}

/** A limiter bound to a clock: `take` counts and throws a 429 when the key is over its limit. */
export interface KeyedLimit {
  /** Counts one event for `key`; throws rateLimited() (not counted) when the key is at its limit. */
  take(key: string): void
  /** Throws rateLimited() when the key is at its limit, without counting anything. */
  check(key: string): void
  /** Counts one event for `key` without throwing (e.g. a failed verification); saturates at the limit. */
  record(key: string): void
}

export function keyedLimit(limit: RouteRateLimit, now: () => Date, message?: string): KeyedLimit {
  const window = new SlidingWindowLimiter(limit.max, limit.timeWindow)
  const at = () => now().getTime()
  const check = (key: string) => {
    const wait = window.retryAfterMs(key, at())
    if (wait > 0) throw rateLimited(wait, message)
  }
  return {
    take(key) {
      const t = at()
      if (!window.take(key, t)) throw rateLimited(window.retryAfterMs(key, t), message)
    },
    check,
    record(key) {
      window.take(key, at())
    },
  }
}
