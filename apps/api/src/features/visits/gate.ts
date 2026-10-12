// The write interval of the visit routes (docs/WAVE-N: 1 write per VISIT_WRITE_MIN_INTERVAL_MS per (person, board)),
// in process memory like the other per-person limits (one api instance: docs/DEPLOY.md; with several, each keeps
// its own, which can only let a write through sooner, never block anyone).
//
// A call inside the interval writes nothing. When the call before it was a visit, that visit's ANSWER is kept for
// the interval and handed to the later call, so two tabs opened together (or a quick reload) read the same
// previous time as the first one did, even while the first write is still in flight (the promise is shared).
// The key is the person's own id and the board: nothing here is ever looked up by anyone else.

import type { VisitAnswer } from '@draftroom/contracts'

interface Entry {
  at: number
  /** the visit write's answer, shared; null when the last write was a "seen" */
  answer: Promise<VisitAnswer> | null
}

export class VisitWriteGate {
  private readonly entries = new Map<string, Entry>()
  private readonly intervalMs: number
  private readonly maxKeys: number

  constructor(intervalMs: number, maxKeys = 20_000) {
    this.intervalMs = intervalMs
    this.maxKeys = maxKeys
  }

  static key(userId: string, boardId: string): string {
    return `${userId}\u0000${boardId}`
  }

  /** The last write of this key when it is inside the interval at `atMs`, else null (a write may go ahead). */
  recent(key: string, atMs: number): Entry | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (atMs - e.at >= this.intervalMs || atMs < e.at) {
      this.entries.delete(key)
      return null
    }
    return e
  }

  /** Notes a write at `atMs` (a visit with its answer, or a seen with none). The oldest keys are forgotten past the cap. */
  note(key: string, atMs: number, answer: Promise<VisitAnswer> | null): Entry {
    const e: Entry = { at: atMs, answer }
    this.entries.delete(key)
    this.entries.set(key, e)
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return e
  }

  /** A write that failed is not a write: the next call may try again. */
  forget(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}
