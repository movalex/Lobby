// Helpers shared by the dashboard-share routes (ids, rate limiting, events, savepoints).

import type { Queryable } from '@draftroom/db'
import type { FeatureContext } from '../context.ts'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `acr_` + 20 base62 characters (same generator shape as @draftroom/db newId). */
export function newAccessRequestId(): string {
  const limit = 256 - (256 % BASE62.length)
  let out = ''
  while (out.length < 20) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= limit) continue
      out += BASE62[b % BASE62.length]
      if (out.length === 20) break
    }
  }
  return `acr_${out}`
}

/**
 * Sliding-window limiter keyed by user id, in process memory (one API instance; docs/DEPLOY.md).
 * `hit` records an attempt and answers whether it is within the limit.
 */
export class UserRateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number
  constructor(opts: { max: number; windowMs: number; now: () => number }) {
    this.max = opts.max
    this.windowMs = opts.windowMs
    this.now = opts.now
  }

  hit(key: string): boolean {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(t)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) this.prune(t)
    return true
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k)
  }
}

/**
 * Tells every open board stream that sharing changed (visibility, links, requests, grants). The
 * payload carries no identities: it is a hint, and clients that may see details refetch them.
 * Call only after the transaction committed.
 */
export function publishSharingChanged(ctx: FeatureContext, boardId: string, reason: string) {
  ctx.events.publish(boardId, { type: 'sharing.changed', data: { reason } })
}

let savepointSeq = 0

/**
 * Runs `fn` inside a SAVEPOINT: a failure rolls back only `fn`'s statements and resolves to null,
 * leaving the surrounding transaction usable. For best-effort side effects (notifications).
 */
export async function trySavepoint<T>(tx: Queryable, fn: () => Promise<T>): Promise<T | null> {
  const name = `dr_dash_${++savepointSeq}`
  await tx.query(`SAVEPOINT ${name}`)
  try {
    const out = await fn()
    await tx.query(`RELEASE SAVEPOINT ${name}`)
    return out
  } catch {
    await tx.query(`ROLLBACK TO SAVEPOINT ${name}`)
    return null
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000
