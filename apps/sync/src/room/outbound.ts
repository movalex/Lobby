// One ordered outbound queue per session (docs/EXCALIDRAW-MIGRATION.md §2.4.5 "Outbound"):
//  - frames leave in the order they were queued; an entry may be a promise (the gzip snapshot compressed
//    off the event loop, or a welcome that names its size), and later frames wait behind it, so the
//    prefix invariant (§2.4.3) holds by construction;
//  - above 256 KiB of `bufferedAmount` a session gets no cursor (presence) frames;
//  - above 8 MiB queued (socket buffer plus this queue) it is closed with 4000 RECONNECT and resyncs;
//  - the process-wide budget (wave M, M7-5, CAP-MEM; `OutboundBudget`, checked by the service every 250 ms,
//    index.ts): the per-session queues are capped but their sum was not (a join storm on a big board after a
//    deploy). Above the budget (DRAFTROOM_OUTBOUND_BUDGET_MB, 64 MiB) every session is `congested`: no cursor
//    frames for anyone, as the 256 KiB per-session skip does for one. Above 1.25 times it, the largest queues are
//    closed with 4000 RECONNECT, largest first, until the sum is back under 1.25 times the budget. Nothing else is
//    ever skipped: a `changes` frame, an ack or a welcome is queued or its session is closed (it resyncs), never
//    dropped. Before wave M the service closed the largest buffer above a fixed 64 MiB.
//    Why 64 MiB (a close line of 80 MiB; wave N.1, it was 128 and 160): the sync runs on 0.5c-512mb, 512 MB in all,
//    and the migration queue's runtime gate already treats 440 MB of RSS as the most it may reach (migrate/queue.ts
//    RUNTIME_RSS_LIMIT_MB). Measured: at most 147 MB RSS with 260 sessions, 310 MB while a conversion worker runs (the
//    B9/L1 runs, docs/PROGRESS.md). On top of that, with DRAFTROOM_WS_DEFLATE=on, each socket keeps its deflate
//    context (windowBits 15, memLevel 7: 192 KiB) and an inflate window: about 60 MB at 260 sessions. 310 + 60 + 160
//    MiB of queues is past 512 MB before the budget closes anything; 310 + 60 + 80 MiB (84 MB) is about 455 MB, inside
//    the instance with room for the garbage collector. The sum also counts a frame shared by many sockets (one
//    broadcast string, the one cached snapshot) once per socket, so the bytes really held are at most this, and
//    usually far less: the line is reached on the way to memory trouble, not in it. A larger instance can raise the
//    key; a value only ever needs a restart.
//
// Large frames are written in slices (B9's event-loop tail): a frame of DEFER_ABOVE_BYTES or more (a
// welcome with a 200-entry roster or a catch-up, the gzip snapshot, the `changes` of a 100-note frame drag:
// 101 moves and 180 re-snapped arrows, about 110 KB) is not written inside the task that queued it but by
// the flusher, which writes dirty sessions for at most FLUSH_SLICE_MS per macrotask and then lets the loop
// run. A 110 KB frame to 200 sessions is about 22 MB of socket writes; done in one task on 0.5 CPU it
// blocked the loop for 150-300 ms (the largest stalls of B9's steady state), and under a CPU quota a long
// task is stretched further by the throttle. Per session nothing changes: its queue keeps the order, a
// small frame queued behind a deferred one waits for it, and a writer still gets its `changes` before its
// ack. Small frames (acks, cursors, ordinary `changes`) are still written at once.

import { CLOSE_RECONNECT } from '@draftroom/canvas-schema/protocol'
import type { ElementSocket } from '../engine-switch.ts'

export const OUTBOUND = {
  skipPresenceAbove: 256 * 1024,
  closeAbove: 8 * 1024 * 1024,
  /** the process-wide budget's default (config.ts DEFAULT_OUTBOUND_BUDGET_MB), bytes */
  globalBudget: 64 * 1024 * 1024,
  /** above this times the budget, the largest queues are closed */
  closeFactor: 1.25,
} as const

/** One session as the budget sees it: its bytes waiting, and how to close it (4000 RECONNECT). */
export interface BudgetEntry {
  readonly pending: number
  close(): void
}

/**
 * The process-wide outbound budget (M7-5). `check` (the service's 250 ms timer) sums every session's bytes
 * waiting, sets `over` (every Outbound reads it: congested, no presence) and closes the largest queues above
 * `closeFactor` times the budget. `queued` is the last sum (lobby_outbound_bytes_queued).
 */
export class OutboundBudget {
  /** the budget, bytes */
  readonly bytes: number
  /** the last check found the sum above the budget: presence is skipped for every session */
  over = false
  /** the sum of bytes waiting at the last check (after its closes) */
  queued = 0
  constructor(bytes: number = OUTBOUND.globalBudget) {
    this.bytes = bytes
  }

  /** Sums `entries`, closes the largest above closeFactor times the budget; returns how many it closed. */
  check(entries: Iterable<BudgetEntry>): number {
    const list = [...entries]
    let total = 0
    for (const e of list) total += Math.max(0, e.pending)
    let closed = 0
    const closeAbove = this.bytes * OUTBOUND.closeFactor
    if (total > closeAbove) {
      list.sort((a, b) => b.pending - a.pending)
      for (const e of list) {
        if (total <= closeAbove) break
        const n = Math.max(0, e.pending)
        e.close()
        total -= n
        closed++
      }
    }
    this.queued = total
    this.over = total > this.bytes
    return closed
  }
}

/** The budget an Outbound reads when it is given none (tests; a room outside the service): never over. */
const NO_BUDGET = new OutboundBudget(Number.POSITIVE_INFINITY)

/** A frame of at least this size (or a frame whose size is not known yet: a promise) is written by the flusher. */
export const DEFER_ABOVE_BYTES = 8 * 1024
/** Socket writes per macrotask of the flusher, at most (plus the frame that crosses the line). */
export const FLUSH_SLICE_MS = 5

/** The send option of a frame that is compressed already (the gzip snapshot; app.ts WS_DEFLATE_OPTIONS). */
export const NO_COMPRESS = Object.freeze({ compress: false })

type Frame = string | Uint8Array
type Entry = Frame | Promise<Frame | null>

const sizeOf = (f: Frame) => (typeof f === 'string' ? f.length : f.byteLength)

/** The process-wide flusher of deferred sessions: dirty sessions written in slices, in the order they were marked. */
class Flusher {
  private readonly dirty = new Set<Outbound>()
  private timer: ReturnType<typeof setImmediate> | null = null
  /** slices run (tests, metrics) */
  slices = 0

  add(o: Outbound): void {
    this.dirty.add(o)
    if (!this.timer) this.timer = setImmediate(() => this.run())
  }

  private run(): void {
    this.timer = null
    this.slices++
    const t0 = performance.now()
    for (const o of this.dirty) {
      this.dirty.delete(o)
      o.flushDeferred()
      if (performance.now() - t0 >= FLUSH_SLICE_MS) break
    }
    if (this.dirty.size) this.timer = setImmediate(() => this.run())
  }

  get size(): number {
    return this.dirty.size
  }
}
export const flusher = new Flusher()

export class Outbound {
  private readonly queue: Entry[] = []
  private queuedBytes = 0
  private flushing = false
  /** a large frame is queued and the flusher will write this session's queue */
  private deferred = false
  closed = false
  /** bytes handed to the socket (metrics) */
  sentBytes = 0

  private readonly socket: ElementSocket
  private readonly onOverflow: () => void
  private readonly onSent: (bytes: number) => void
  private readonly budget: OutboundBudget
  constructor(
    socket: ElementSocket,
    onOverflow: () => void,
    onSent: (bytes: number) => void = () => {},
    budget: OutboundBudget = NO_BUDGET,
  ) {
    this.socket = socket
    this.onOverflow = onOverflow
    this.onSent = onSent
    this.budget = budget
  }

  /** Bytes waiting: the socket's buffer plus this queue. */
  get pending(): number {
    return (this.socket.bufferedAmount ?? 0) + this.queuedBytes
  }

  /** Whether cursor frames should be skipped (backpressure: this session's, or the process's budget, M7-5). */
  get congested(): boolean {
    return this.budget.over || this.pending > OUTBOUND.skipPresenceAbove
  }

  send(entry: Entry): void {
    if (this.closed) return
    const known = typeof entry === 'string' || entry instanceof Uint8Array
    if (known) this.queuedBytes += sizeOf(entry)
    this.queue.push(entry)
    if (this.deferred) return
    if (!known || sizeOf(entry) >= DEFER_ABOVE_BYTES) {
      this.deferred = true
      flusher.add(this)
      return
    }
    this.flush()
  }

  /** The flusher's turn: writes what is queued (the deferred frame and everything behind it). */
  flushDeferred(): void {
    this.deferred = false
    this.flush()
  }

  private flush(): void {
    if (this.flushing || this.closed) return
    while (this.queue.length) {
      const head = this.queue[0] as Entry
      if (head instanceof Promise) {
        this.flushing = true
        head.then(
          (f) => {
            this.flushing = false
            this.queue[0] = f ?? ''
            if (f) this.queuedBytes += sizeOf(f)
            this.flush()
          },
          () => {
            this.flushing = false
            this.queue.shift()
            this.flush()
          },
        )
        return
      }
      this.queue.shift()
      const n = sizeOf(head)
      this.queuedBytes -= n
      if (n === 0) continue
      if (this.socket.readyState !== 1) continue
      try {
        // M7-2: the one binary frame is the gzip snapshot: deflating it again costs CPU and saves nothing
        if (typeof head === 'string') this.socket.send(head)
        else this.socket.send(head, NO_COMPRESS)
        this.sentBytes += n
        this.onSent(n)
      } catch {
        // a socket that failed mid-send is closing; its close handler cleans up
      }
    }
    if (this.pending > OUTBOUND.closeAbove) this.overflow()
  }

  /** Closes the session for backpressure (4000 RECONNECT: the client resyncs). */
  overflow(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.queuedBytes = 0
    try {
      this.socket.close(CLOSE_RECONNECT, 'RECONNECT')
    } catch {
      // already closed
    }
    this.onOverflow()
  }

  close(): void {
    this.closed = true
    this.queue.length = 0
    this.queuedBytes = 0
  }
}
