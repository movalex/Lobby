// RT-03 (realtime audit, wave J3): a dot vote's counts no longer give the ballots away by their timing.
//
// Before, every cast (and every "I'm done") published the vote's new counts to the whole board at once,
// and every read answered the live counts. Next to the cursor stream (whose pointer goes to an object
// and clicks it), "+1 vote cast" a few milliseconds later told every participant who voted for what,
// long before the reveal. Now, while a vote is open, the counts anyone is shown (the board's
// `workshop.vote` event, GET /workshop, the cast and done answers, the past-votes list) are the counts
// as they stood at the last window boundary: windows of VOTE_TALLY_WINDOW_MS on the wall clock (the
// same for every vote and every viewer, never started by a cast), and one event per window that
// changed something, sent at its end. Polling learns nothing more than the event: a read between two
// boundaries answers the same counts. Every ballot change records the counts it left, with a sequence
// taken while the vote's row lock was still held, so the order is the commit order.
//
// What stays (documented, not hidden):
// - a window in which only one person voted still says "this person voted something in these 5 s" to
//   anyone who watched their cursor; which object stays unknown unless their cursor rested on one only
//   (the sync server relays no button and no selection during an anonymous vote: room/presence.ts);
// - the voter's own answers carry their own ballot right away (`myVotes`, `myRemaining`), as before;
// - closing or revealing publishes the final counts at once (casting has stopped);
// - after an api restart the first count anyone sees of a running vote is the live one (this is memory).
//
// The counts are in this process only, like the event hub that sends them (one api instance per board).

import type { Aggregates, SessionRow } from './votes.ts'
import { effectiveStatus } from './votes.ts'

/** The width of a counting window. The facilitator's "N votes cast" lags by at most this much. */
export const VOTE_TALLY_WINDOW_MS = 5_000

/** A tally a ballot change took inside its transaction, while it held the vote's row lock. */
export interface TallyMark {
  readonly seq: number
  readonly at: number
}

interface Change {
  readonly seq: number
  readonly at: number
  readonly agg: Aggregates
}

interface Entry {
  /** what anyone may be shown: the counts as of the last window boundary */
  base: Aggregates
  baseSeq: number
  /** committed changes not shown yet: at most the latest one per window */
  pending: Change[]
  /** the counts the board's event stream was last given */
  published: Aggregates | null
  timer: unknown
  flushing: Promise<void> | null
  /** when the vote ends by itself (its row's ends_at), to forget it */
  endsAt: number | null
}

export interface VoteTallyOptions {
  now: () => Date
  /** The vote as stored now (a flush reads it again: status and end time for the event). */
  load(sessionId: string): Promise<SessionRow | null>
  /** Sends the board's `workshop.vote` event with these counts. */
  publish(row: SessionRow, agg: Aggregates, at: Date): void
  log?: { warn(obj: object, msg: string): void }
  windowMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const same = (a: Aggregates | null, b: Aggregates) =>
  !!a &&
  a.totalVotesCast === b.totalVotesCast &&
  a.participants === b.participants &&
  a.participantsDone === b.participantsDone

const copy = (a: Aggregates): Aggregates => ({
  totalVotesCast: a.totalVotesCast,
  participants: a.participants,
  participantsDone: a.participantsDone,
})

/** More open votes than this in one process are unusual (one per board); past it the oldest are forgotten. */
const MAX_ENTRIES = 5_000
/** Fires a little after the boundary, so the clock has certainly passed it. */
const TIMER_SLACK_MS = 25

export class VoteTally {
  private readonly entries = new Map<string, Entry>()
  private readonly windowMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly inflight = new Set<Promise<void>>()
  private seq = 0
  private lastAt = Number.NEGATIVE_INFINITY
  private closed = false
  private readonly opts: VoteTallyOptions

  constructor(opts: VoteTallyOptions) {
    this.opts = opts
    this.windowMs = Math.max(1, Math.floor(opts.windowMs ?? VOTE_TALLY_WINDOW_MS))
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      })
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** The start of the window `t` is in. */
  private boundary(t: number): number {
    return Math.floor(t / this.windowMs) * this.windowMs
  }

  /**
   * Call INSIDE the transaction of a ballot change, after its counts were read and before it commits
   * (the vote's row lock is held: marks are in commit order).
   */
  mark(): TallyMark {
    const at = Math.max(this.opts.now().getTime(), this.lastAt)
    this.lastAt = at
    return { seq: ++this.seq, at }
  }

  /** A vote just started: its (empty) counts are shown at once, like its start event. */
  started(row: SessionRow, agg: Aggregates): void {
    if (this.closed || this.entries.has(row.id)) return // a cast that raced the start already counted
    this.prune()
    this.entries.set(row.id, {
      base: copy(agg),
      // every later change is newer, also one whose mark was taken before this call
      baseSeq: 0,
      pending: [],
      published: copy(agg),
      timer: null,
      flushing: null,
      endsAt: row.ends_at ? row.ends_at.getTime() : null,
    })
  }

  /**
   * A ballot change committed, leaving `agg` (read in its transaction, with `mark`). Shown, and sent to
   * the board, once its window is over.
   */
  changed(row: SessionRow, agg: Aggregates, mark: TallyMark): void {
    if (this.closed) return
    let e = this.entries.get(row.id)
    if (!e) {
      // First sight of a running vote (this process restarted): nothing older to show.
      this.prune()
      e = {
        base: copy(agg),
        baseSeq: mark.seq,
        pending: [],
        published: null,
        timer: null,
        flushing: null,
        endsAt: row.ends_at ? row.ends_at.getTime() : null,
      }
      this.entries.set(row.id, e)
      this.arm(row.id, e, mark.at)
      return
    }
    e.endsAt = row.ends_at ? row.ends_at.getTime() : null
    if (mark.seq <= e.baseSeq) return
    const w = this.boundary(mark.at)
    // the latest change of a window is the only one ever shown: drop the earlier ones of that window
    const kept = e.pending.filter((c) => this.boundary(c.at) !== w || c.seq > mark.seq)
    if (!kept.some((c) => this.boundary(c.at) === w))
      kept.push({ seq: mark.seq, at: mark.at, agg: copy(agg) })
    e.pending = kept.sort((a, b) => a.seq - b.seq)
    this.arm(row.id, e, mark.at)
  }

  /**
   * The counts anyone may be shown of `row` at `at`. An open vote: as of the last window boundary
   * (`live` is read only when this process has not seen the vote yet). Any other vote: `live` (its
   * counts are final). A boundary passed since the last look: the new counts are sent to the board
   * before this answers (the timer would have, a moment later).
   */
  async view(row: SessionRow, at: Date, live: () => Promise<Aggregates>): Promise<Aggregates> {
    if (effectiveStatus(row, at) !== 'open') {
      this.forget(row.id)
      return live()
    }
    let e = this.entries.get(row.id)
    if (!e) {
      const agg = await live()
      e = this.entries.get(row.id)
      if (!e) {
        this.prune()
        e = {
          base: copy(agg),
          // a change that committed while `live` was read is recorded after this: it must still count
          baseSeq: 0,
          pending: [],
          published: null,
          timer: null,
          flushing: null,
          endsAt: row.ends_at ? row.ends_at.getTime() : null,
        }
        this.entries.set(row.id, e)
      }
    }
    if (this.promote(e, at.getTime())) await this.flush(row.id, e)
    return copy(e.base)
  }

  /** The vote is no longer open (closed or revealed): its final counts are published by the caller. */
  ended(sessionId: string): void {
    this.forget(sessionId)
  }

  /** Waits for the flushes in flight (app close, tests). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
  }

  close(): void {
    this.closed = true
    for (const id of [...this.entries.keys()]) this.forget(id)
  }

  // ---- internals ------------------------------------------------------------------------------------

  /** Moves the changes of every finished window into `base`. True when `base` changed. */
  private promote(e: Entry, now: number): boolean {
    const edge = this.boundary(now)
    const due = e.pending.filter((c) => c.at < edge)
    if (!due.length) return false
    e.pending = e.pending.filter((c) => c.at >= edge)
    const last = due.reduce((a, b) => (b.seq > a.seq ? b : a))
    if (last.seq <= e.baseSeq) return false
    const changed = !same(e.base, last.agg)
    e.base = copy(last.agg)
    e.baseSeq = last.seq
    return changed
  }

  /** A timer for the end of the window `at` is in (one per vote: later changes end no earlier). */
  private arm(sessionId: string, e: Entry, at: number): void {
    if (e.timer !== null || this.closed) return
    const fireAt = this.boundary(at) + this.windowMs
    const ms = Math.max(0, fireAt - this.opts.now().getTime()) + TIMER_SLACK_MS
    e.timer = this.setTimer(() => {
      e.timer = null
      if (this.entries.get(sessionId) !== e || this.closed) return
      this.promote(e, this.opts.now().getTime())
      const p = this.flush(sessionId, e).finally(() => {
        // changes of a later window (or a clock that has not reached this boundary yet): next window
        const next = e.pending[0]
        if (next && this.entries.get(sessionId) === e) this.arm(sessionId, e, next.at)
      })
      this.track(p)
    }, ms)
  }

  /** Sends `base` to the board when the stream was not given it yet. Never throws. */
  private flush(sessionId: string, e: Entry): Promise<void> {
    if (same(e.published, e.base)) return Promise.resolve()
    if (e.flushing) return e.flushing.then(() => this.flush(sessionId, e))
    const p = (async () => {
      try {
        const row = await this.opts.load(sessionId)
        // ended meanwhile: its own (final) event went out, and this entry is gone
        if (!row || this.entries.get(sessionId) !== e || this.closed) return
        const at = this.opts.now()
        // it ended by its end time: nothing is cast any more, so its last counts are final
        const open = effectiveStatus(row, at) === 'open'
        if (!open) this.promote(e, Number.POSITIVE_INFINITY)
        const agg = copy(e.base)
        if (same(e.published, agg)) return
        e.published = agg
        this.opts.publish(row, agg, at)
        if (!open) this.forget(sessionId)
      } catch (err) {
        this.opts.log?.warn({ err: { name: (err as Error)?.name } }, 'vote counts not published')
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

  private forget(sessionId: string): void {
    const e = this.entries.get(sessionId)
    if (!e) return
    if (e.timer !== null) this.clearTimer(e.timer)
    e.timer = null
    this.entries.delete(sessionId)
  }

  /** Votes that ended by their end time, and the oldest past the cap, are forgotten. */
  private prune(): void {
    const now = this.opts.now().getTime()
    for (const [id, e] of this.entries)
      if (e.endsAt !== null && e.endsAt <= now - this.windowMs && e.timer === null) this.forget(id)
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
  }
}
