// Commit pacing of a busy room (docs/EXCALIDRAW-MIGRATION.md §2.4.3 "a busy room commits at most every
// 25 ms", §2.13 "fsync is the unknown", step 1 of the mitigation ladder: "raise the minimum interval between
// a busy room's commits ... (adds ≤ 50 ms to acks)").
//
// What B9 found (B9.md, "The §2.13 mitigation ladder"): the 25 ms floor binds only when a push arrives within
// 25 ms AFTER a commit; at L1's 23 pushes/s on one board the gaps are mostly longer, so the room committed
// once per push (1.3 pushes per commit, about 20 commits/s), and raising the floor to 50 ms changed nothing
// (21/s). Every commit costs an fsync of the board file (5.5 ms of blocked event loop on the NAS disk) and
// one `changes` frame to every session (200 socket writes), so the commit count, not the push count, is
// what the CPU and the event loop pay for.
//
// The pacer holds the FIRST push of a batch for `busyHoldMs` when the room is busy (at least
// `busyCommitsPerSecond` commits in the last second), so the pushes of the next few tens of milliseconds
// share its commit, its fsync and its fan-out. A quiet room (a few people on a board) is never held: its
// pushes drain on setImmediate as before, and the 25 ms floor stays for pushes that follow a commit closely.
// The hold is bounded (≤ busyHoldMs added to an ack) and never applies to the rest of a batch the drain cut
// at its work limit (that part drains after the floor, as before).

export const DRAIN_PACING = {
  /** commits in the last second from which a room counts as busy */
  busyCommitsPerSecond: 4,
  /** how long a busy room's first queued push waits for company (ms) */
  busyHoldMs: 40,
} as const

export class CommitPacer {
  private readonly times: number[] = []
  private readonly windowMs = 1_000
  private readonly busyCommits: number
  private readonly holdMs: number

  constructor(opts: { busyCommitsPerSecond?: number; busyHoldMs?: number } = {}) {
    this.busyCommits = opts.busyCommitsPerSecond ?? DRAIN_PACING.busyCommitsPerSecond
    this.holdMs = opts.busyHoldMs ?? DRAIN_PACING.busyHoldMs
  }

  /** A batch committed at `now`. */
  noteCommit(now: number): void {
    this.times.push(now)
    this.trim(now)
  }

  /** Whether the room committed `busyCommitsPerSecond` times or more in the last second. */
  busy(now: number): boolean {
    this.trim(now)
    return this.times.length >= this.busyCommits
  }

  /** Commits in the last second (metrics, tests). */
  recentCommits(now: number): number {
    this.trim(now)
    return this.times.length
  }

  /**
   * How long the drain of a batch should wait from `now` (0: a setImmediate): the floor since the last
   * commit (`minIntervalMs`), or, for the first entry of an empty queue (`fresh`) in a busy room, the hold.
   */
  delay(now: number, lastCommitAt: number, minIntervalMs: number, fresh: boolean): number {
    const floor = lastCommitAt + minIntervalMs - now
    const hold = fresh && this.busy(now) ? this.holdMs : 0
    return Math.max(0, floor, hold)
  }

  private trim(now: number): void {
    const cut = now - this.windowMs
    while (this.times.length && (this.times[0] as number) <= cut) this.times.shift()
  }
}
