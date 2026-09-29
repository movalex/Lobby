// Inbound op and byte budgets per session (docs/EXCALIDRAW-MIGRATION.md §2.4.5; the message budget,
// 4099 RATE_LIMITED, is app.ts's). Token buckets with the plan's numbers (limits.ts RATES; guests get
// half of each).
//
// How a push over budget is treated (a stated deviation, see docs/research/excalidraw/spike-b/
// O1-room.md): a push that the bucket cannot pay now WAITS in the session's stage-0 FIFO until it can
// (keeping the session's order), as long as the ops and bytes waiting in that FIFO stay within one burst.
// Beyond that, a push is answered `RATE` for every op, with a `SLOW_DOWN` notice, and never closes the
// session. So a legitimate burst (a 2,500-element paste, the C0 arrow tests' 3,000-op bursts) is slowed,
// not refused, and a flood is refused.

import { GUEST_RATE_FACTOR, RATES } from '@draftroom/canvas-schema/limits'

export class Bucket {
  private tokens: number
  private last: number
  readonly burst: number
  readonly perSecond: number
  constructor(burst: number, perSecond: number, now: number) {
    this.burst = burst
    this.perSecond = perSecond
    this.tokens = burst
    this.last = now
  }
  private refill(now: number): void {
    if (now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond)
      this.last = now
    }
  }
  /** Takes `n` if available now. */
  tryTake(n: number, now: number): boolean {
    this.refill(now)
    if (this.tokens + 1e-9 >= n) {
      this.tokens -= n
      return true
    }
    return false
  }
  /** Milliseconds until `n` tokens are available (0 if now). `n` above the burst is capped to the burst. */
  waitMs(n: number, now: number): number {
    this.refill(now)
    const need = Math.min(n, this.burst) - this.tokens
    return need <= 0 ? 0 : Math.ceil((need / this.perSecond) * 1000)
  }
  /** Takes `n` (capped to the burst) even if that empties the bucket. */
  take(n: number, now: number): void {
    this.refill(now)
    this.tokens = Math.max(0, this.tokens - Math.min(n, this.burst))
  }
}

export interface SessionBudgets {
  readonly ops: Bucket
  readonly bytes: Bucket
}

export function sessionBudgets(guest: boolean, now: number): SessionBudgets {
  const f = guest ? GUEST_RATE_FACTOR : 1
  return {
    ops: new Bucket(RATES.ops.burst * f, RATES.ops.perSecond * f, now),
    bytes: new Bucket(RATES.bytes.burst * f, RATES.bytes.perSecond * f, now),
  }
}
