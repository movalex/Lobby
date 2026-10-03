// Join diagnostics for the long runs (B11): what a headless client's join looked like from the inside, and
// how busy the Node process that hosts the clients was while it waited. Written for the join stall of wave D5
// (the story is at the top of tests/b11-convergence.spec.ts): late in a B11 run a headless rejoin got no frame
// for 30 s or more. A join that stalls is the harness (this process: its event loop, its WebSocket, its
// ticket) or the server; these records tell them apart.
//
//  - `LoopLag`: a 20 ms ticker in this process. The lag of every tick is kept in 5 s windows (max, count over
//    250 ms), with the V8 heap and the collection time of each window, and every tick that ran 1 s late is
//    listed. A process whose loop is blocked for seconds delays every socket event (a welcome, a pong) by the
//    same amount.
//  - `JoinTrace`: one record per `connect()` of a headless client: when the api ticket was fetched, every
//    transport state change (with the close code), every inbound frame type with its time since the join
//    began, the transport's own log (the heartbeat death), the age of the ticket when the welcome came. It
//    also counts the joins in flight (`active`, `hold()`), which the load generator waits for.
//  - `CapturingMeter`: the metered socket of a join, which sees every frame the moment it reaches the socket
//    (the transport hands frames on strictly in order, so a stuck frame hides the ones behind it).
//  - `analyseSnapshot` and `profileTop`: for a join that waits, the snapshot frame taken apart (valid gzip?
//    how long does each stage of the decoder take now, how long does one event-loop turn take) and a CPU
//    profile of the process.

import inspector from 'node:inspector'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { gunzip, gunzipSync } from 'node:zlib'
import { decodeSnapshotFrame } from '../../../packages/canvas-schema/src/protocol.ts'
import { Meter } from '../../load/meter.ts'

const quietly = <T>(fn: () => T): T | null => {
  try {
    return fn()
  } catch {
    return null
  }
}

export interface LagWindow {
  /** ms since the sampler started, at the window's start */
  readonly t: number
  readonly maxMs: number
  readonly over250: number
  /** V8 heap in use at the window's end, MB */
  readonly heapMB: number
  /** garbage collection in the window: total and longest pause, ms */
  readonly gcMs: number
  readonly gcMaxMs: number
}

/** A ticker that measures how late the event loop runs it. */
export class LoopLag {
  private readonly start = Date.now()
  private expected = Date.now() + 20
  private timer: ReturnType<typeof setInterval> | null = null
  private win = { t: 0, maxMs: 0, over250: 0, gcMs: 0, gcMaxMs: 0 }
  private readonly gc = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      this.win.gcMs += e.duration
      if (e.duration > this.win.gcMaxMs) this.win.gcMaxMs = e.duration
    }
  })
  readonly windows: LagWindow[] = []
  /** every tick that ran 1 s or more late: [wall clock, ms late] */
  readonly stalls: [number, number][] = []
  readonly histogram = monitorEventLoopDelay({ resolution: 10 })
  /** the largest lag in the last `ms` (from the windows still open and the last ones) */
  private recent: [number, number][] = []

  begin(): this {
    this.histogram.enable()
    this.gc.observe({ entryTypes: ['gc'] })
    this.timer = setInterval(() => {
      const now = Date.now()
      const lag = Math.max(0, now - this.expected)
      this.expected = now + 20
      if (lag > this.win.maxMs) this.win.maxMs = lag
      if (lag > 250) this.win.over250++
      if (lag >= 1_000) this.stalls.push([now, lag])
      if (lag >= 100) this.recent.push([now, lag])
      if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200)
      if (now - this.start >= (this.windows.length + 1) * 5_000) {
        this.windows.push({
          t: this.windows.length * 5_000,
          maxMs: this.win.maxMs,
          over250: this.win.over250,
          heapMB: Math.round(getHeapStatistics().used_heap_size / 1e6),
          gcMs: Math.round(this.win.gcMs),
          gcMaxMs: Math.round(this.win.gcMaxMs),
        })
        this.win = { t: 0, maxMs: 0, over250: 0, gcMs: 0, gcMaxMs: 0 }
      }
    }, 20)
    return this
  }

  /** the worst lag in the last `ms` milliseconds (0 when the loop ran on time) */
  worstSince(ms: number): number {
    const from = Date.now() - ms
    return this.recent.reduce((m, [at, lag]) => (at >= from && lag > m ? lag : m), 0)
  }

  end(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.histogram.disable()
    this.gc.disconnect()
  }

  /** the heap, the pauses and the lag now: what a stalled join was waiting in */
  now() {
    const h = getHeapStatistics()
    const last = this.windows.slice(-2)
    return {
      heapUsedMB: Math.round(h.used_heap_size / 1e6),
      heapLimitMB: Math.round(h.heap_size_limit / 1e6),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      gcMsLast10s: last.reduce((n, w) => n + w.gcMs, 0),
      gcMaxMsLast10s: last.reduce((n, w) => Math.max(n, w.gcMaxMs), 0),
      tickLagMaxLast10s: this.worstSince(10_000),
    }
  }

  summary() {
    const h = this.histogram
    const worst = this.windows.reduce((m, w) => Math.max(m, w.maxMs), 0)
    return {
      windows: this.windows.length,
      worstTickLagMs: worst,
      windowsWithTickOver250ms: this.windows.filter((w) => w.over250 > 0).length,
      heapLimitMB: Math.round(getHeapStatistics().heap_size_limit / 1e6),
      gcTotalMs: this.windows.reduce((n, w) => n + w.gcMs, 0),
      // one window in six (30 s): the heap and the collection time as the run went on
      timeline: this.windows
        .filter((_, i) => i % 6 === 5)
        .map((w) => [Math.round(w.t / 1000), w.heapMB, w.gcMs, w.gcMaxMs]),
      stallsOver1s: this.stalls.length,
      stalls: this.stalls.slice(0, 40),
      loopDelayMs: h.count
        ? { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 }
        : null,
      // the windows that were not quiet, for the timeline
      busyWindows: this.windows.filter((w) => w.maxMs >= 100).slice(0, 120),
    }
  }
}

/** the metered socket of each join: what reached it, whatever the client did with it */
const meterOfJoin = new WeakMap<object, CapturingMeter>()
export const attachMeter = (rec: object, meter: CapturingMeter): void => void meterOfJoin.set(rec, meter)
export const meterOf = (rec: object): CapturingMeter | undefined => meterOfJoin.get(rec)

export interface JoinRecord {
  readonly name: string
  /** which connect of this participant (1 = the first join) */
  readonly n: number
  /** why: the first join, a chaos rejoin, or the replacement after the sync kill */
  readonly why: string
  /** wall clock the connect began */
  readonly startedAt: number
  /** ms spent fetching the api ticket */
  ticketMs: number | null
  /** [ms since the connect began, transport state, close code] */
  readonly states: [number, string, number?][]
  /** [ms since the connect began, frame type]; the first 12 */
  readonly frames: [number, string][]
  /** transport log events with their time (the heartbeat death, a failed url) */
  readonly events: [number, string, unknown?][]
  /** ms from the connect's start to the welcome, or null while waiting / when it failed */
  welcomeMs: number | null
  /** the ticket's age when the welcome came: the 60 s lifetime counts from the api's mint */
  ticketAgeAtWelcomeMs: number | null
  /** sockets the transport opened for it */
  attempts: number
  failed: string | null
}

/**
 * What reached the socket, whatever the client did with it (the transport hands frames on strictly in order,
 * so a frame stuck in the middle of its chain hides the ones behind it): the metered socket sees every
 * frame the moment it arrives. Keeps the last binary frame (the gzip snapshot) for `analyseSnapshot`.
 */
export class CapturingMeter extends Meter {
  frames = 0
  /** wall clock of the last frame of any kind */
  lastAt: number | null = null
  readonly byType: Record<string, number> = {}
  /** [wall clock, bytes] of every binary frame */
  readonly binary: [number, number][] = []
  lastBinary: Uint8Array | null = null
  override received(data: unknown, at = Date.now()): void {
    this.frames++
    this.lastAt = at
    if (typeof data === 'string') {
      const m = /"type"s*:s*"([a-z.]{1,32})"/.exec(data.slice(0, 120))
      const type = m?.[1] ?? 'unknown'
      this.byType[type] = (this.byType[type] ?? 0) + 1
    } else {
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null
      this.byType.binary = (this.byType.binary ?? 0) + 1
      if (view) {
        this.binary.push([at, view.byteLength])
        this.lastBinary = view.slice()
      }
    }
    super.received(data, at)
  }
  rawSummary(now = Date.now()) {
    return {
      frames: this.frames,
      sinceLastFrameMs: this.lastAt === null ? null : now - this.lastAt,
      byType: this.byType,
      binary: this.binary,
    }
  }
}

/** Runs `fn`, answering with how long it took, or "PENDING" when it has not finished in `timeoutMs`. */
async function timed(
  fn: () => Promise<unknown>,
  timeoutMs: number,
): Promise<{ verdict: string; ms: number }> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  const verdict = await Promise.race([
    fn().then(
      () => 'done',
      (e) => `rejected: ${String(e).slice(0, 160)}`,
    ),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('PENDING'), timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  return { verdict, ms: Date.now() - t0 }
}

/** How long `n` event-loop turns (setImmediate) take in a row: the cost of each hop a stream makes through the loop. */
export async function turnCost(n = 20): Promise<{ turns: number; totalMs: number; perTurnMs: number }> {
  const t0 = Date.now()
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve))
  const totalMs = Date.now() - t0
  return { turns: n, totalMs, perTurnMs: totalMs / n }
}

/**
 * Takes the snapshot frame the socket received apart, outside the client, with the loop as busy as it is:
 * is it a complete gzip (node:zlib, synchronously), and how long does each stage of the protocol's decoder
 * (`decodeSnapshotFrame`: a Blob stream through a `DecompressionStream`, read by a `Response`, then JSON and
 * zod) take here, now. `report` gets each answer as it comes (a stage that never finishes is "PENDING").
 */
export async function analyseSnapshot(
  meter: CapturingMeter,
  report: (what: string, detail: unknown) => void,
  timeoutMs = 170_000,
): Promise<void> {
  const bytes = meter.lastBinary
  if (!bytes) return report('no binary frame', {})
  const head = Array.from(bytes.subarray(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  try {
    const t0 = Date.now()
    const text = gunzipSync(bytes).toString('utf8')
    let json: unknown = true
    try {
      JSON.parse(text)
    } catch (e) {
      json = String(e).slice(0, 120)
    }
    report('gunzipSync (the main thread)', {
      bytes: bytes.byteLength,
      head,
      ms: Date.now() - t0,
      jsonBytes: text.length,
      jsonParses: json,
    })
  } catch (e) {
    report('gunzipSync (the main thread)', { ok: false, error: String(e).slice(0, 200) })
  }
  report('event-loop turn cost now', await turnCost())
  const stages: [string, () => Promise<unknown>][] = [
    [
      'zlib.gunzip (callback, the thread pool)',
      () => new Promise((res, rej) => gunzip(bytes, (e, o) => (e ? rej(e) : res(o)))),
    ],
    [
      'Blob stream read by a Response (no decompression)',
      () => new Response(new Blob([bytes.slice()]).stream()).arrayBuffer(),
    ],
    [
      'Blob stream through DecompressionStream, read by a Response',
      () =>
        new Response(
          new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer(),
    ],
    ['decodeSnapshotFrame (the whole decoder)', () => decodeSnapshotFrame(bytes.slice())],
  ]
  await Promise.all(stages.map(async ([name, fn]) => report(name, await timed(fn, timeoutMs))))
  report('event-loop turn cost after', await turnCost())
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
  samples: number[]
  timeDeltas: number[]
}

/**
 * A CPU profile of this process for `ms`: the functions with the most self time, as `name file:line ms`.
 * What a saturated loop is spending its time on.
 */
export async function profileTop(ms = 10_000, top = 25): Promise<string[]> {
  const session = new inspector.Session()
  session.connect()
  const post = (method: string, params?: object) =>
    new Promise<{ profile: CpuProfile }>((resolve, reject) =>
      session.post(method, params as never, (e: Error | null, r?: unknown) =>
        e ? reject(e) : resolve(r as { profile: CpuProfile }),
      ),
    )
  await post('Profiler.enable')
  await post('Profiler.start')
  await new Promise((r) => setTimeout(r, ms))
  const { profile } = await post('Profiler.stop')
  session.disconnect()
  const self = new Map<number, number>()
  const deltas: number[] = profile.timeDeltas
  for (const [i, id] of (profile.samples as number[]).entries())
    self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0))
  const byName = new Map<string, number>()
  for (const node of profile.nodes as {
    id: number
    callFrame: { functionName: string; url: string; lineNumber: number }
  }[]) {
    const t = self.get(node.id) ?? 0
    if (!t) continue
    const f = node.callFrame
    const where = f.url.replace(/^.*[/](apps|packages|e2e|node_modules)[/]/, '$1/')
    const key = `${f.functionName || '(anonymous)'} ${where}:${f.lineNumber + 1}`
    byName.set(key, (byName.get(key) ?? 0) + t)
  }
  return [...byName.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, top)
    .map(([k, us]) => `${(us / 1000).toFixed(0)} ms  ${k}`)
}

/** Reports a join that has no welcome yet. */
export type StallReport = (rec: JoinRecord, waitedMs: number, lag: LoopLag) => void

export class JoinTrace {
  readonly records: JoinRecord[] = []
  /** joins that have begun and not finished (welcomed, failed or given up) */
  active = 0
  private readonly lag: LoopLag
  private readonly onStall: StallReport
  private readonly afterMs: number
  constructor(lag: LoopLag, onStall: StallReport, afterMs = 8_000) {
    this.lag = lag
    this.onStall = onStall
    this.afterMs = afterMs
  }

  begin(name: string, n: number, why: string): JoinRecord {
    const rec: JoinRecord = {
      name,
      n,
      why,
      startedAt: Date.now(),
      ticketMs: null,
      states: [],
      frames: [],
      events: [],
      welcomeMs: null,
      ticketAgeAtWelcomeMs: null,
      attempts: 0,
      failed: null,
    }
    this.records.push(rec)
    return rec
  }

  /** Counts as a join in flight until the returned function is called (a run of joins with gaps between them). */
  hold(): () => void {
    this.active++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.active--
    }
  }

  /** Watches a join until it ends; `done()` must be called when it does. */
  watch(rec: JoinRecord): () => void {
    let waited = this.afterMs
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      timer = setTimeout(() => {
        quietly(() => this.onStall(rec, Date.now() - rec.startedAt, this.lag))
        waited = Math.min(waited * 2, 30_000)
        arm()
      }, waited)
    }
    arm()
    this.active++
    return () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      this.active--
    }
  }

  summary() {
    const done = this.records.filter((r) => r.welcomeMs !== null)
    const ms = done.map((r) => r.welcomeMs as number).sort((a, b) => a - b)
    const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? null
    return {
      joins: this.records.length,
      welcomed: done.length,
      failed: this.records.filter((r) => r.failed !== null).length,
      welcomeMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: ms[ms.length - 1] ?? null },
      // every join that took more than 5 s, or failed, in full
      slow: this.records
        .filter((r) => r.failed !== null || (r.welcomeMs ?? Number.POSITIVE_INFINITY) > 5_000)
        .slice(0, 30)
        .map((r) => ({ ...r, socket: meterOf(r)?.rawSummary() })),
    }
  }
}
