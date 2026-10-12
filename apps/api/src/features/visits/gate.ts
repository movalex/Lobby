// The write interval of the visit routes (docs/WAVE-N: 1 write per VISIT_WRITE_MIN_INTERVAL_MS per (person, board)),
// in process memory like the other per-person limits (one api instance: docs/DEPLOY.md; with several, each keeps
// its own, which can only let a write through sooner, never block anyone).
//
// A call inside the interval writes nothing at once. When the call before it was a visit, that visit's ANSWER is kept
// for the interval and handed to the later call, so two tabs opened together (or a quick reload) read the same
// previous time as the first one did, even while the first write is still in flight (the promise is shared).
//
// Wave N.1 (wave N follow-up 5): a "seen" inside the interval (Mark all seen, or the leave beacon of a short stay) is
// not dropped: its time is KEPT (the latest one) and written once the interval has ended, so the server holds it, not
// only the tab that sent it. It is written by whichever comes first: the gate's tick (`flushDue`, every
// VISIT_TRAIL_TICK_MS), the next call for the same key once the interval is over (`settle`: a visit must read it as
// its previous time), the key being forgotten past the cap, or the api closing (`flushAll`). That write does not begin
// an interval of its own: the intervals stay those of the calls (so a Mark all seen just after it is written at once,
// and a call inside an interval answers as before wave N.1), which allows at most two writes in any 10 s. A visit inside
// an interval answers as before (the earlier visit's answer, else the stored time), not the kept time: tabs opened
// together agree, and the tab that marked it seen remembers so (web visits/ack.ts); every open after the interval reads
// it. seen_at never moves back (GREATEST), so a late or repeated write changes nothing.
// The key is the person's own id and the board: nothing here is ever looked up by anyone else.

import type { VisitAnswer } from '@draftroom/contracts'

/** How often the gate looks for kept "seen" times whose interval has ended (ms; real time, read against `now`). */
export const VISIT_TRAIL_TICK_MS = 1_000

/** Stores a kept "seen" time: the route's own write of the session's row (./index.ts). */
export type SeenWriter = (at: Date) => Promise<void>

/** A "seen" kept for the end of its interval: the time to store, and how. */
interface Trail {
  at: number
  readonly write: SeenWriter
}

interface Entry {
  at: number
  /** the visit write's answer, shared; null when the last write was a "seen" */
  answer: Promise<VisitAnswer> | null
  /** the latest "seen" inside this interval, written when it ends; null when none */
  trail: Trail | null
  /** that write while it is in flight (the next visit waits for it) */
  writing: Promise<void> | null
}

export class VisitWriteGate {
  private readonly entries = new Map<string, Entry>()
  /** the keys with a kept "seen" (the tick looks at these only) */
  private readonly trails = new Set<string>()
  /** kept writes in flight, whichever entry they came from (the close waits for every one) */
  private readonly inflight = new Set<Promise<void>>()
  private readonly intervalMs: number
  private readonly maxKeys: number

  constructor(intervalMs: number, maxKeys = 20_000) {
    this.intervalMs = intervalMs
    this.maxKeys = maxKeys
  }

  static key(userId: string, boardId: string): string {
    return `${userId}\u0000${boardId}`
  }

  private ended(e: Entry, atMs: number): boolean {
    return atMs - e.at >= this.intervalMs || atMs < e.at
  }

  /**
   * The last write of this key when it is inside the interval at `atMs`, else null (a write may go ahead). Call
   * `settle` first: an ended entry that still has a kept "seen" stays for it (and for the tick).
   */
  recent(key: string, atMs: number): Entry | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (this.ended(e, atMs)) {
      if (!e.trail && !e.writing) this.entries.delete(key)
      return null
    }
    return e
  }

  /**
   * Before a call of this key at `atMs` (both routes, before `recent`): the kept "seen" of an interval that has ended
   * is written now, and a kept write in flight is waited for, so a visit's previous time includes it. The caller's own
   * write then follows as usual. Never rejects (a failed kept write is dropped).
   */
  async settle(key: string, atMs: number): Promise<void> {
    const e = this.entries.get(key)
    if (!e) return
    if (e.trail && this.ended(e, atMs)) this.flush(key, e)
    await e.writing
  }

  /** Notes a write at `atMs` (a visit with its answer, or a seen with none). The oldest keys are forgotten past the cap. */
  note(key: string, atMs: number, answer: Promise<VisitAnswer> | null): Entry {
    const prev = this.entries.get(key)
    // a kept "seen" of the entry this one replaces is written, never dropped (an older time changes nothing: GREATEST)
    if (prev?.trail) this.flush(key, prev)
    const e: Entry = { at: atMs, answer, trail: null, writing: null }
    this.entries.delete(key)
    this.entries.set(key, e)
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      const gone = this.entries.get(oldest)
      if (gone?.trail) this.flush(oldest, gone)
      this.entries.delete(oldest)
    }
    return e
  }

  /**
   * Keeps a "seen" at `atMs` inside the interval of `key`'s last write (the latest time wins), for when it ends;
   * `write` stores it (the same person's row: the key is theirs).
   */
  keep(key: string, atMs: number, write: SeenWriter): void {
    const e = this.entries.get(key)
    if (!e) return
    if (!e.trail) e.trail = { at: atMs, write }
    else e.trail.at = Math.max(e.trail.at, atMs)
    this.trails.add(key)
  }

  /** A write that failed is not a write: the next call may try again. */
  forget(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry && !entry.trail && !entry.writing) this.entries.delete(key)
    else if (this.entries.get(key) === entry) entry.at = Number.NEGATIVE_INFINITY // ended: the next call writes
  }

  /** The tick: writes every kept "seen" whose interval has ended at `atMs`. */
  flushDue(atMs: number): void {
    for (const key of [...this.trails]) {
      const e = this.entries.get(key)
      if (!e?.trail) {
        this.trails.delete(key)
        continue
      }
      if (this.ended(e, atMs)) this.flush(key, e)
    }
  }

  /** The api is closing: every kept "seen" is written now, whatever its interval; resolves when all are. */
  async flushAll(): Promise<void> {
    for (const key of [...this.trails]) {
      const e = this.entries.get(key)
      if (e?.trail) this.flush(key, e)
      else this.trails.delete(key)
    }
    await Promise.all([...this.inflight])
  }

  /** Writes `e`'s kept "seen" (taken from it at once); the entry's interval is left as it is. */
  private flush(key: string, e: Entry): void {
    const t = e.trail
    if (!t) return
    e.trail = null
    this.trails.delete(key)
    const w = t
      .write(new Date(t.at))
      .catch(() => {}) // a lost kept "seen" only means the next visit shows a little more (nothing is logged)
      .finally(() => {
        if (e.writing === w) e.writing = null
        this.inflight.delete(w)
      })
    e.writing = w
    this.inflight.add(w)
  }

  get size(): number {
    return this.entries.size
  }

  /** Kept "seen" times not written yet (tests). */
  get kept(): number {
    return this.trails.size
  }
}
