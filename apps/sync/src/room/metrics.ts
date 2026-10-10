// GET /internal/metrics (docs/EXCALIDRAW-MIGRATION.md §2.4.6): Prometheus text for the watch after
// cut-over and the load test. Counters and simple histograms (sum, count and fixed buckets), process-wide
// for the ElementRoom service; per-board gauges come from the open rooms when rendered.
//
// F10 (wave L, L6-5): realtime quality, as process-wide aggregates with fixed buckets and no label, so no
// board id, user id or content is ever in them:
//  - lobby_push_to_commit_ms: a push's arrival to the COMMIT of its batch;
//  - lobby_commit_to_fanout_ms: a COMMIT to the end of its fan-out in the room's task (the `changes` frame
//    queued or written for every session, then the acks); a frame of 8 KiB or more is written later by the
//    outbound flusher, and that wait shows in the next two;
//  - lobby_outbound_queue_bytes: each welcomed session's bytes waiting (socket buffer and queue) right after
//    a commit's fan-out (one observation per session per fan-out);
//  - lobby_ack_send_ms: per session, a push's arrival to its ack written to that session's socket (its wait
//    behind frames queued before it included; behind a snapshot still being compressed it can read early);
//  - lobby_reconnects_per_minute: hellos that resume a board state (a reconnect, not a first open) in each
//    minute of the process, one observation per minute (idle minutes count 0), with lobby_reconnects_total.
// The room calls the hooks below; they cost a few array writes per push and per session written to.
//
// Wave M (M7-3, S5): the values outlive a restart. Once an hour (METRICS_SUMMARY_MS) the service logs ONE line,
// `metrics.summary {json}`, so Render's log retention keeps what a deploy's restart erases from these in-memory
// counters: the counters' increase over the hour (summed over their labels, under fixed short names), each F10
// histogram's count with p50/p95 estimated from its buckets (the bucket's upper bound; null above the last one),
// the event-loop delay over the hour, the outbound bytes written and queued, the disk's free share, the rooms
// open, the sessions, and the element counts of the open rooms (max, p50, p95 only). No label, no board id, no
// user id: nothing in the line names anyone or anything. A last line goes out when the service closes (a deploy),
// with `final: true`, covering the part of the hour before it. Also new: lobby_laser_frames_in_total (presence
// messages taken with the laser down; the older name lobby_presence_laser_in_total counts the same and stays for
// wave L's scrape scripts). lobby_follow_pause_total is NOT added: a follow pause is client-local and no presence
// field carries it (a CONTRACTS_REV change, out of wave M), so there is nothing for the server to count.

import { monitorEventLoopDelay } from 'node:perf_hooks'

/** A histogram's cumulative bucket counts, count and sum at one moment (the summary's window deltas). */
interface HistogramSnapshot {
  readonly counts: readonly number[]
  readonly count: number
  readonly sum: number
}

class Histogram {
  private readonly counts: number[]
  sum = 0
  count = 0
  readonly buckets: readonly number[]
  constructor(buckets: readonly number[]) {
    this.buckets = buckets
    this.counts = buckets.map(() => 0)
  }
  observe(v: number): void {
    this.sum += v
    this.count++
    for (let i = 0; i < this.buckets.length; i++)
      if (v <= (this.buckets[i] as number)) this.counts[i] = (this.counts[i] ?? 0) + 1
  }
  snapshot(): HistogramSnapshot {
    return { counts: [...this.counts], count: this.count, sum: this.sum }
  }
  render(name: string, help: string): string {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`]
    this.buckets.forEach((b, i) => {
      lines.push(`${name}_bucket{le="${b}"} ${this.counts[i]}`)
    })
    lines.push(
      `${name}_bucket{le="+Inf"} ${this.count}`,
      `${name}_sum ${this.sum}`,
      `${name}_count ${this.count}`,
    )
    return lines.join('\n')
  }
}

const MS_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 150, 250, 400, 1000, 2500] as const
/** Outbound bytes waiting: nothing, a frame, a few, the 256 KiB presence skip, 1 MiB, the 8 MiB close. */
const QUEUE_BYTES_BUCKETS = [0, 1024, 8192, 65_536, 262_144, 1_048_576, 8_388_608] as const
/** Reconnects in one minute of the process. */
const PER_MINUTE_BUCKETS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500] as const
/** A minute, ms (the reconnect rate's window). */
export const METRICS_MINUTE_MS = 60_000
/** The most idle minutes one roll observes (a process idle for longer counts at most a day of zeros at once). */
const MAX_MINUTES_PER_ROLL = 1_440
/** The most acks one session may have waiting for their write (beyond it the oldest are dropped, unmeasured). */
const MAX_ACK_WAITS = 256
/** M7-3: how often the service logs its metrics.summary line (an hour). */
export const METRICS_SUMMARY_MS = 60 * 60_000

/**
 * M7-3: the counters the summary carries, under short names that name nothing (no "board", no "user"); each is
 * the counter's increase over the window, summed over its labels. A counter not listed here is not in the line.
 */
const SUMMARY_COUNTERS: Readonly<Record<string, string>> = {
  lobby_joins_total: 'joins',
  lobby_resets_total: 'resets',
  lobby_reconnects_total: 'reconnects',
  lobby_pushes_received_total: 'pushes',
  lobby_ops_total: 'ops',
  lobby_commit_failures_total: 'commitFailures',
  lobby_closes_total: 'closes',
  lobby_presence_in_total: 'presenceIn',
  lobby_presence_out_total: 'presenceOut',
  lobby_laser_frames_in_total: 'laserFramesIn',
  lobby_lease_total: 'leases',
  lobby_file_refs_total: 'fileRefs',
  lobby_file_refs_failures_total: 'fileRefFailures',
  lobby_board_prepare_total: 'prepares',
  lobby_receipts_unrecorded_total: 'receiptsUnrecorded',
}

/** The gauges the service adds to a summary (index.ts). */
export interface SummaryGauges {
  readonly rooms: number
  readonly sessions: number
  /** every session's bytes waiting (lobby_outbound_bytes_queued) */
  readonly outboundQueued: number
  /** the data disk's free share (null: unreadable) */
  readonly diskFree: number | null
  /** the element count of each open room */
  readonly elements: readonly number[]
}

/** The q-quantile (nearest rank) of sorted numbers; null for none. */
const nearestRank = (sorted: readonly number[], q: number): number | null =>
  sorted.length
    ? (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number)
    : null

/**
 * The q-quantile of a window of a histogram, estimated from its cumulative buckets: the upper bound of the first
 * bucket that holds the rank; null when the rank is above the last bucket.
 */
function bucketQuantile(
  buckets: readonly number[],
  counts: readonly number[],
  n: number,
  q: number,
): number | null {
  const rank = Math.max(1, Math.ceil(q * n))
  for (let i = 0; i < buckets.length; i++) if ((counts[i] ?? 0) >= rank) return buckets[i] as number
  return null
}

const round1 = (v: number) => Math.round(v * 10) / 10
const counterName = (key: string) => key.replace(/\{.*$/, '')

interface AckWait {
  /** the session's `sentBytes` once its ack has been written */
  readonly target: number
  readonly receivedAt: number
}

export interface BoardGauges {
  readonly boardId: string
  readonly sessions: number
  readonly elements: number
  readonly tombstones: number
  readonly dbBytes: number
}

export class RoomMetrics {
  readonly counters = new Map<string, number>()
  readonly commitMs = new Histogram(MS_BUCKETS)
  readonly pushesPerCommit = new Histogram([1, 2, 4, 8, 16, 32, 64])
  readonly ackMs = new Histogram(MS_BUCKETS)
  readonly fsyncMs = new Histogram(MS_BUCKETS)
  // F10 (L6-5, the header)
  readonly pushToCommitMs = new Histogram(MS_BUCKETS)
  readonly fanoutMs = new Histogram(MS_BUCKETS)
  readonly outboundQueueBytes = new Histogram(QUEUE_BYTES_BUCKETS)
  readonly ackSendMs = new Histogram(MS_BUCKETS)
  readonly reconnectsPerMinute = new Histogram(PER_MINUTE_BUCKETS)
  /** per session (its outbound queue object), the acks queued and not written yet, in order */
  private readonly ackWaits = new WeakMap<object, AckWait[]>()
  private minuteStart: number
  private minuteCount = 0
  private readonly loop = monitorEventLoopDelay({ resolution: 10 })
  /** M7-3: the event-loop delay since the last summary (reset by each) */
  private readonly loopWindow = monitorEventLoopDelay({ resolution: 10 })
  private readonly now: () => number
  private readonly startedAt: number
  /** M7-3: what the last summary saw (its window starts there) */
  private lastSummary: {
    at: number
    counters: Map<string, number>
    hists: Record<string, HistogramSnapshot>
  }

  constructor(now: () => number = Date.now) {
    this.now = now
    this.minuteStart = now()
    this.startedAt = now()
    this.loop.enable()
    this.loopWindow.enable()
    this.lastSummary = { at: this.startedAt, counters: new Map(), hists: {} }
  }

  /** The F10 histograms (and the group commit's) by their summary names. */
  private summaryHistograms(): Record<string, Histogram> {
    return {
      pushToCommitMs: this.pushToCommitMs,
      commitToFanoutMs: this.fanoutMs,
      outboundQueueBytes: this.outboundQueueBytes,
      ackSendMs: this.ackSendMs,
      reconnectsPerMinute: this.reconnectsPerMinute,
      commitMs: this.commitMs,
    }
  }

  /**
   * M7-3: the summary of the window since the last one (the first: since the process started), as one log line,
   * `metrics.summary {json}`; the next window starts now. `final`: the service is closing (a deploy).
   */
  summaryLine(g: SummaryGauges, opts: { final?: boolean } = {}): string {
    const at = this.now()
    this.rollMinutes(at)
    const totals = new Map<string, number>()
    for (const [key, v] of this.counters) {
      const name = counterName(key)
      const short = name === 'lobby_outbound_bytes_total' ? 'outBytes' : SUMMARY_COUNTERS[name]
      if (short) totals.set(short, (totals.get(short) ?? 0) + v)
    }
    const delta = (k: string) => (totals.get(k) ?? 0) - (this.lastSummary.counters.get(k) ?? 0)
    const counts: Record<string, number> = {}
    for (const short of Object.values(SUMMARY_COUNTERS)) counts[short] = delta(short)
    const hist: Record<string, { n: number; p50?: number | null; p95?: number | null }> = {}
    const snaps: Record<string, HistogramSnapshot> = {}
    for (const [name, h] of Object.entries(this.summaryHistograms())) {
      const snap = h.snapshot()
      snaps[name] = snap
      const before = this.lastSummary.hists[name]
      const n = snap.count - (before?.count ?? 0)
      if (n <= 0) {
        hist[name] = { n: 0 }
        continue
      }
      const window = snap.counts.map((c, i) => c - (before?.counts[i] ?? 0))
      hist[name] = {
        n,
        p50: bucketQuantile(h.buckets, window, n, 0.5),
        p95: bucketQuantile(h.buckets, window, n, 0.95),
      }
    }
    const loop = this.loopWindow.count
      ? {
          p50: round1(this.loopWindow.percentile(50) / 1e6),
          p99: round1(this.loopWindow.percentile(99) / 1e6),
          max: round1(this.loopWindow.max / 1e6),
        }
      : { n: 0 }
    const sizes = [...g.elements].sort((a, b) => a - b)
    const line = {
      ...(opts.final ? { final: true } : {}),
      windowS: Math.round((at - this.lastSummary.at) / 1000),
      uptimeS: Math.round((at - this.startedAt) / 1000),
      rooms: g.rooms,
      sessions: g.sessions,
      counts,
      outBytes: delta('outBytes'),
      outQueued: g.outboundQueued,
      diskFree: g.diskFree === null ? null : Number(g.diskFree.toFixed(4)),
      hist,
      loopMs: loop,
      elements: sizes.length
        ? { n: sizes.length, max: sizes.at(-1), p50: nearestRank(sizes, 0.5), p95: nearestRank(sizes, 0.95) }
        : { n: 0 },
    }
    this.lastSummary = { at, counters: totals, hists: snaps }
    this.loopWindow.reset()
    return `metrics.summary ${JSON.stringify(line)}`
  }

  /**
   * M7-3: logs a summary line every `everyMs` (an hour) with the gauges `gauges()` gives; returns the stop
   * function, which logs one last line (`final`) when `flush` is set (the service closing: a deploy).
   */
  startSummary(
    gauges: () => SummaryGauges,
    log: (line: string) => void,
    everyMs: number = METRICS_SUMMARY_MS,
  ): (flush?: boolean) => void {
    const emit = (final: boolean) => {
      try {
        log(this.summaryLine(gauges(), final ? { final } : {}))
      } catch {
        // a summary must never take the server down
      }
    }
    const timer = setInterval(() => emit(false), everyMs)
    timer.unref?.()
    let stopped = false
    return (flush = false) => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      if (flush) emit(true)
    }
  }

  // ---- F10 hooks (L6-5) ------------------------------------------------------------------------------

  /** A batch committed at `now` (ms, the room's clock): `receivedAt` is each of its pushes' arrival. */
  committed(receivedAt: Iterable<number>, now: number): void {
    for (const at of receivedAt) this.pushToCommitMs.observe(Math.max(0, now - at))
  }

  /** The room's fan-out after a COMMIT took `ms`. */
  fanout(ms: number): void {
    this.fanoutMs.observe(Math.max(0, ms))
  }

  /** One session's outbound bytes waiting right after a fan-out. */
  queueDepth(bytes: number): void {
    this.outboundQueueBytes.observe(Math.max(0, bytes))
  }

  /**
   * An ack was handed to a session's outbound queue `out` (any object that stands for it): `queuedBytes` are
   * the bytes still in that queue now (the ack's included; 0 when it went to the socket at once), `sentBytes`
   * what the queue has written so far, `receivedAt` the push's arrival.
   */
  ackQueued(out: object, queuedBytes: number, sentBytes: number, receivedAt: number, now: number): void {
    if (queuedBytes <= 0) {
      this.ackSendMs.observe(Math.max(0, now - receivedAt))
      return
    }
    let list = this.ackWaits.get(out)
    if (!list) {
      list = []
      this.ackWaits.set(out, list)
    }
    list.push({ target: sentBytes + queuedBytes, receivedAt })
    if (list.length > MAX_ACK_WAITS) list.splice(0, list.length - MAX_ACK_WAITS)
  }

  /** The session's queue `out` wrote to its socket: `sentBytes` written so far. Its acks written by now are timed. */
  ackFlushed(out: object, sentBytes: number, now: number): void {
    const list = this.ackWaits.get(out)
    if (!list?.length) return
    let n = 0
    while (n < list.length && (list[n] as AckWait).target <= sentBytes) {
      this.ackSendMs.observe(Math.max(0, now - (list[n] as AckWait).receivedAt))
      n++
    }
    if (n) list.splice(0, n)
  }

  /** A hello that resumes a board state (a reconnect, not a first open) at `now` (ms). */
  reconnect(now: number = this.now()): void {
    this.rollMinutes(now)
    this.minuteCount++
    this.inc('lobby_reconnects_total')
  }

  /** Observes every minute that ended by `now` (its reconnects; idle minutes 0). */
  private rollMinutes(now: number): void {
    let rolled = 0
    while (now - this.minuteStart >= METRICS_MINUTE_MS) {
      if (rolled >= MAX_MINUTES_PER_ROLL) {
        // a long idle stretch: the minutes past a day of zeros are skipped, not observed
        this.minuteStart += Math.floor((now - this.minuteStart) / METRICS_MINUTE_MS) * METRICS_MINUTE_MS
        this.minuteCount = 0
        break
      }
      this.reconnectsPerMinute.observe(this.minuteCount)
      this.minuteCount = 0
      this.minuteStart += METRICS_MINUTE_MS
      rolled++
    }
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${labelText(labels)}`
    this.counters.set(key, (this.counters.get(key) ?? 0) + by)
  }

  stop(): void {
    this.loop.disable()
    this.loopWindow.disable()
  }

  render(rooms: {
    open: number
    sessionsByRole: Record<string, number>
    boards: BoardGauges[]
    /** M7-5: the process-wide outbound queue (every session's bytes waiting) and its budget */
    outbound?: { queuedBytes: number; budgetBytes: number; over: boolean }
    /** M7-4: the free share of the data dir's disk (null: unreadable; the line is left out) */
    diskFreeRatio?: number | null
  }): string {
    const out: string[] = []
    out.push('# TYPE lobby_rooms_open gauge', `lobby_rooms_open ${rooms.open}`)
    if (rooms.outbound)
      out.push(
        '# HELP lobby_outbound_bytes_queued Bytes waiting to be written, every session together (socket buffers and queues).',
        '# TYPE lobby_outbound_bytes_queued gauge',
        `lobby_outbound_bytes_queued ${rooms.outbound.queuedBytes}`,
        '# TYPE lobby_outbound_budget_bytes gauge',
        `lobby_outbound_budget_bytes ${rooms.outbound.budgetBytes}`,
        '# TYPE lobby_outbound_over_budget gauge',
        `lobby_outbound_over_budget ${rooms.outbound.over ? 1 : 0}`,
      )
    if (typeof rooms.diskFreeRatio === 'number')
      out.push(
        '# HELP lobby_disk_free_ratio Free share of the data disk (rooms and backups).',
        '# TYPE lobby_disk_free_ratio gauge',
        `lobby_disk_free_ratio ${Number(rooms.diskFreeRatio.toFixed(4))}`,
      )
    out.push('# TYPE lobby_sessions gauge')
    for (const [role, n] of Object.entries(rooms.sessionsByRole))
      out.push(`lobby_sessions{role="${role}"} ${n}`)
    const byName = new Map<string, string[]>()
    for (const [key, v] of [...this.counters].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const name = key.replace(/\{.*$/, '')
      const list = byName.get(name) ?? []
      list.push(`${key} ${v}`)
      byName.set(name, list)
    }
    for (const [name, lines] of byName) out.push(`# TYPE ${name} counter`, ...lines)
    out.push(this.commitMs.render('lobby_commit_ms', 'Milliseconds per group commit (BEGIN to COMMIT).'))
    out.push(
      this.fsyncMs.render(
        'lobby_fsync_ms',
        'Milliseconds of the COMMIT statement (fsync with synchronous=FULL).',
      ),
    )
    out.push(this.pushesPerCommit.render('lobby_pushes_per_commit', 'Pushes in one group commit.'))
    out.push(this.ackMs.render('lobby_receive_to_ack_ms', 'Milliseconds from a push arriving to its ack.'))
    // F10 (L6-5): aggregates only, no labels
    this.rollMinutes(this.now())
    out.push(
      this.pushToCommitMs.render(
        'lobby_push_to_commit_ms',
        'Milliseconds from a push arriving to the COMMIT of its batch.',
      ),
      this.fanoutMs.render(
        'lobby_commit_to_fanout_ms',
        'Milliseconds from a COMMIT to the end of its fan-out (changes to every session, then the acks).',
      ),
      this.outboundQueueBytes.render(
        'lobby_outbound_queue_bytes',
        'Bytes waiting per welcomed session (socket buffer and queue) right after a commit fan-out.',
      ),
      this.ackSendMs.render(
        'lobby_ack_send_ms',
        'Milliseconds from a push arriving to its ack written to its own session socket.',
      ),
      this.reconnectsPerMinute.render(
        'lobby_reconnects_per_minute',
        'Reconnects (a hello resuming a board state) in each minute of the process.',
      ),
    )
    const p = (q: number) => (this.loop.count ? this.loop.percentile(q) / 1e6 : 0)
    out.push(
      '# TYPE lobby_event_loop_delay_ms gauge',
      `lobby_event_loop_delay_ms{quantile="0.5"} ${p(50)}`,
      `lobby_event_loop_delay_ms{quantile="0.99"} ${p(99)}`,
      `lobby_event_loop_delay_ms{quantile="1"} ${this.loop.count ? this.loop.max / 1e6 : 0}`,
    )
    out.push('# TYPE lobby_board_elements gauge')
    for (const b of rooms.boards) out.push(`lobby_board_elements{board="${b.boardId}"} ${b.elements}`)
    out.push('# TYPE lobby_board_tombstones gauge')
    for (const b of rooms.boards) out.push(`lobby_board_tombstones{board="${b.boardId}"} ${b.tombstones}`)
    out.push('# TYPE lobby_board_db_bytes gauge')
    for (const b of rooms.boards) out.push(`lobby_board_db_bytes{board="${b.boardId}"} ${b.dbBytes}`)
    out.push('# TYPE lobby_board_sessions gauge')
    for (const b of rooms.boards) out.push(`lobby_board_sessions{board="${b.boardId}"} ${b.sessions}`)
    return `${out.join('\n')}\n`
  }
}

function labelText(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ''
  return `{${keys.map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',')}}`
}
