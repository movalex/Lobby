// OWNER: WS1 (wave V). The tally window of a live activity (docs/WAVE-V-CONTRACTS.md §2.2 rule 2): WS1's own copy of
// the dot vote's RT-03 design (../workshops/vote-tally.ts, which stays exactly as it is), adapted to an activity.
//
// While an activity is open, what anyone is shown of its answers (the board's `workshop.activity` event, GET
// …/activity, the answer response's `answered`, live results, the past list) is the answers as they stood at the
// last wall-clock boundary of its window: `activityTallyWindowMs` = 1 s only for a NAMED activity whose results are
// not live, else 5 s (an anonymous answer, or one everyone sees counted live, must not be tied to a person by its
// timing). The windows are the same for every activity and every viewer (never started by an answer), and one event
// goes out per window that changed something, at its end. Polling learns nothing more than the event: a read between
// two boundaries answers the same thing. Every answer records the answers it left (a snapshot: the answers alone, in
// a canonical order, with no person attached) with a mark taken while the activity's row lock was still held, so the
// order is the commit order.
//
// What a snapshot is NOT: per-person. It holds the answers of everyone as a multiset (sorted by their JSON), so even
// this process's memory keeps no tie from a person to an answer once the window is over; the results the api builds
// from it are aggregates only (contracts tallyPoll, tallyScale, tallyWords).
//
// What stays (documented, as for the dot vote): a window in which only one person answered still says "someone
// answered in these 5 s" to anyone watching the counts; the answerer's own response carries their own answer at
// once; closing, revealing and cancelling publish at once (answering has stopped); after an api restart the first
// thing anyone sees of a running activity is the live state (this is memory, one api instance per board).

import { type ActivityAnswer, activityTallyWindowMs } from '@draftroom/contracts'

/** The answers of an activity at one moment: a multiset, no person attached. */
export interface Snapshot {
  readonly answers: readonly ActivityAnswer[]
  /** equal for equal multisets (the answers' JSON, sorted, joined) */
  readonly digest: string
}

/** The snapshot of `answers` (any order in, a canonical order out). */
export function snapshotOf(answers: readonly ActivityAnswer[]): Snapshot {
  const keyed = answers.map((a) => ({ a, k: JSON.stringify(a) }))
  keyed.sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
  return { answers: keyed.map((x) => x.a), digest: keyed.map((x) => x.k).join('\n') }
}

export const EMPTY_SNAPSHOT: Snapshot = snapshotOf([])

/** What the tally needs of an activity row. */
export interface TallyRow {
  readonly id: string
  readonly anonymous: boolean
  readonly results_live: boolean
  readonly status: string
  readonly ends_at: Date | null
}

/** An open activity past its end time counts as closed (no scheduler: every read and write applies this). */
export const isOpenAt = (row: Pick<TallyRow, 'status' | 'ends_at'>, at: Date): boolean =>
  row.status === 'open' && !(row.ends_at && row.ends_at.getTime() <= at.getTime())

/** A mark an answer took inside its transaction, while it held the activity's row lock. */
export interface TallyMark {
  readonly seq: number
  readonly at: number
}

interface Change {
  readonly seq: number
  readonly at: number
  readonly snap: Snapshot
}

interface Entry {
  readonly windowMs: number
  /** what anyone may be shown: the answers as of the last window boundary */
  base: Snapshot
  baseSeq: number
  /** committed changes not shown yet: at most the latest one per window */
  pending: Change[]
  /** the snapshot the board's event stream was last given */
  published: Snapshot | null
  timer: unknown
  flushing: Promise<void> | null
  /** when the activity ends by itself (its row's ends_at), to forget it */
  endsAt: number | null
}

export interface ActivityTallyOptions<R extends TallyRow> {
  now: () => Date
  /** The activity as stored now (a flush reads it again: status, end time and hidden words for the event). */
  load(activityId: string): Promise<R | null>
  /** Sends the board's `workshop.activity` event for these answers. */
  publish(row: R, snap: Snapshot, at: Date): void
  log?: { warn(obj: object, msg: string): void }
  /** For tests: one window width for every activity (default activityTallyWindowMs of each). */
  windowMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** More open activities than this in one process are unusual (one per board); past it the oldest are forgotten. */
const MAX_ENTRIES = 5_000
/** Fires a little after the boundary, so the clock has certainly passed it. */
const TIMER_SLACK_MS = 25

export class ActivityTally<R extends TallyRow = TallyRow> {
  private readonly entries = new Map<string, Entry>()
  /** activities this process ended (`ended`), with the last mark handed out then: oldest first, capped */
  private readonly over = new Map<string, number>()
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly inflight = new Set<Promise<void>>()
  private seq = 0
  private lastAt = Number.NEGATIVE_INFINITY
  private closed = false
  private readonly opts: ActivityTallyOptions<R>

  constructor(opts: ActivityTallyOptions<R>) {
    this.opts = opts
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      })
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** The window width of `row` (fixed for its life: `anonymous` and `resultsLive` never change). */
  windowOf(row: Pick<TallyRow, 'anonymous' | 'results_live'>): number {
    const ms =
      this.opts.windowMs ?? activityTallyWindowMs({ anonymous: row.anonymous, resultsLive: row.results_live })
    return Math.max(1, Math.floor(ms))
  }

  /** The start of the window `t` is in. */
  private boundary(t: number, windowMs: number): number {
    return Math.floor(t / windowMs) * windowMs
  }

  private entry(row: R, base: Snapshot, baseSeq: number, published: Snapshot | null): Entry {
    return {
      windowMs: this.windowOf(row),
      base,
      baseSeq,
      pending: [],
      published,
      timer: null,
      flushing: null,
      endsAt: row.ends_at ? row.ends_at.getTime() : null,
    }
  }

  /**
   * Call INSIDE the transaction of an answer, after its snapshot was read and before it commits (the activity's row
   * lock is held: marks are in commit order).
   */
  mark(): TallyMark {
    const at = Math.max(this.opts.now().getTime(), this.lastAt)
    this.lastAt = at
    return { seq: ++this.seq, at }
  }

  /** An activity just started: its (empty) answers are shown at once, like its start event. */
  started(row: R, snap: Snapshot = EMPTY_SNAPSHOT): void {
    if (this.closed || this.entries.has(row.id)) return // an answer that raced the start already counted
    this.prune()
    // every later change is newer, also one whose mark was taken before this call
    this.entries.set(row.id, this.entry(row, snap, 0, snap))
  }

  /** An answer committed, leaving `snap` (read in its transaction, with `mark`). Shown once its window is over. */
  changed(row: R, snap: Snapshot, mark: TallyMark): void {
    if (this.closed) return
    const endSeq = this.over.get(row.id)
    if (endSeq !== undefined && mark.seq <= endSeq) return // committed before its end; the final event is out
    let e = this.entries.get(row.id)
    if (!e) {
      // First sight of a running activity (this process restarted): nothing older to show.
      this.prune()
      e = this.entry(row, snap, mark.seq, null)
      this.entries.set(row.id, e)
      this.arm(row.id, e, this.shownFrom(mark.at, e.windowMs))
      return
    }
    e.endsAt = row.ends_at ? row.ends_at.getTime() : null
    if (mark.seq <= e.baseSeq) return
    const at = this.shownFrom(mark.at, e.windowMs)
    const w = this.boundary(at, e.windowMs)
    // the latest change of a window is the only one ever shown: drop the earlier ones of that window
    const kept = e.pending.filter((c) => this.boundary(c.at, e.windowMs) !== w || c.seq > mark.seq)
    if (!kept.some((c) => this.boundary(c.at, e.windowMs) === w)) kept.push({ seq: mark.seq, at, snap })
    e.pending = kept.sort((a, b) => a.seq - b.seq)
    this.arm(row.id, e, at)
  }

  /**
   * The moment a change counts from: its mark's, unless the window of its mark ended before the change got here (a
   * COMMIT slower than the rest of its window). Then now, so it waits for the NEXT boundary and goes out with that
   * window's other answers. Without this, the passed boundary had already been sent, a timer for the past window fired
   * a moment later, and the board was sent that one answer's count alone, off the grid (wave V review m1).
   */
  private shownFrom(markAt: number, windowMs: number): number {
    const now = this.opts.now().getTime()
    return this.boundary(now, windowMs) > this.boundary(markAt, windowMs) ? now : markAt
  }

  /**
   * What anyone may be shown of `row` at `at`. An open activity: its answers as of the last window boundary (`live`
   * is read only when this process has not seen it yet). Any other: `live` (its answers are final). A boundary
   * passed since the last look: the board is sent the new state before this answers (the timer would have, a moment
   * later).
   */
  async view(row: R, at: Date, live: () => Promise<Snapshot>): Promise<Snapshot> {
    if (!isOpenAt(row, at)) {
      this.forget(row.id)
      return live()
    }
    let e = this.entries.get(row.id)
    if (!e) {
      const snap = await live()
      e = this.entries.get(row.id)
      if (!e) {
        this.prune()
        // a change that committed while `live` was read is recorded after this: it must still count
        e = this.entry(row, snap, 0, null)
        this.entries.set(row.id, e)
      }
    }
    if (this.promote(e, at.getTime())) await this.flush(row.id, e)
    return e.base
  }

  /**
   * The activity is no longer open (closed, revealed or cancelled): its final state is published by the caller. Every
   * answer it took marked before this (its mark was taken under the row lock, before the close's transaction got it),
   * so a change whose mark is no newer is one that committed before the end and reached `changed` late: it is dropped,
   * not made into a new entry that would publish its older snapshot after the final event (wave V gate, review u3).
   */
  ended(activityId: string): void {
    this.forget(activityId)
    this.over.delete(activityId)
    this.over.set(activityId, this.seq)
    while (this.over.size > MAX_ENTRIES) {
      const oldest = this.over.keys().next().value
      if (oldest === undefined) break
      this.over.delete(oldest)
    }
  }

  /** Waits for the flushes in flight (app close, tests). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
  }

  close(): void {
    this.closed = true
    for (const id of [...this.entries.keys()]) this.forget(id)
  }

  /** Activities this tally holds (tests). */
  get size(): number {
    return this.entries.size
  }

  // ---- internals ------------------------------------------------------------------------------------

  /** Moves the changes of every finished window into `base`. True when `base` changed. */
  private promote(e: Entry, now: number): boolean {
    const edge = Number.isFinite(now) ? this.boundary(now, e.windowMs) : now
    const due = e.pending.filter((c) => c.at < edge)
    if (!due.length) return false
    e.pending = e.pending.filter((c) => c.at >= edge)
    const last = due.reduce((a, b) => (b.seq > a.seq ? b : a))
    if (last.seq <= e.baseSeq) return false
    const changed = e.base.digest !== last.snap.digest
    e.base = last.snap
    e.baseSeq = last.seq
    return changed
  }

  /** A timer for the end of the window `at` is in (one per activity: later changes end no earlier). */
  private arm(activityId: string, e: Entry, at: number): void {
    if (e.timer !== null || this.closed) return
    const fireAt = this.boundary(at, e.windowMs) + e.windowMs
    const ms = Math.max(0, fireAt - this.opts.now().getTime()) + TIMER_SLACK_MS
    e.timer = this.setTimer(() => {
      e.timer = null
      if (this.entries.get(activityId) !== e || this.closed) return
      this.promote(e, this.opts.now().getTime())
      const p = this.flush(activityId, e).finally(() => {
        // changes of a later window (or a clock that has not reached this boundary yet): next window
        const next = e.pending[0]
        if (next && this.entries.get(activityId) === e) this.arm(activityId, e, next.at)
      })
      this.track(p)
    }, ms)
  }

  /** Sends `base` to the board when the stream was not given it yet. Never throws. */
  private flush(activityId: string, e: Entry): Promise<void> {
    if (e.published?.digest === e.base.digest) return Promise.resolve()
    if (e.flushing) return e.flushing.then(() => this.flush(activityId, e))
    const p = (async () => {
      try {
        const row = await this.opts.load(activityId)
        // ended meanwhile: its own (final) event went out, and this entry is gone
        if (!row || this.entries.get(activityId) !== e || this.closed) return
        const at = this.opts.now()
        // it ended by its end time: nothing is answered any more, so its last answers are final
        const open = isOpenAt(row, at)
        if (!open) this.promote(e, Number.POSITIVE_INFINITY)
        const snap = e.base
        if (e.published?.digest === snap.digest) return
        e.published = snap
        this.opts.publish(row, snap, at)
        if (!open) this.forget(activityId)
      } catch (err) {
        this.opts.log?.warn({ err: { name: (err as Error)?.name } }, 'activity counts not published')
      } finally {
        e.flushing = null
      }
    })()
    e.flushing = p
    this.track(p)
    return p
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }

  private forget(activityId: string): void {
    const e = this.entries.get(activityId)
    if (!e) return
    if (e.timer !== null) this.clearTimer(e.timer)
    e.timer = null
    this.entries.delete(activityId)
  }

  /** Activities that ended by their end time, and the oldest past the cap, are forgotten. */
  private prune(): void {
    const now = this.opts.now().getTime()
    for (const [id, e] of this.entries)
      if (e.endsAt !== null && e.endsAt <= now - e.windowMs && e.timer === null) this.forget(id)
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
  }
}
