// F10 (wave L, L6-5): the realtime-quality aggregates of metrics.ts on a fake clock: push arrival to COMMIT,
// COMMIT to the end of the fan-out, outbound queue depth, ack written per session (at once, or when the
// session's queue writes it), reconnects per minute (idle minutes count 0); the Prometheus text has each as a
// histogram with fixed buckets and no labels. And their cost: the hooks of one batch are a small fraction of a
// group commit (the number is printed for the record).
import { describe, expect, it, vi } from 'vitest'
import { METRICS_MINUTE_MS, METRICS_SUMMARY_MS, RoomMetrics, type SummaryGauges } from './metrics.ts'

const render = (m: RoomMetrics) => m.render({ open: 0, sessionsByRole: {}, boards: [] })
const linesOf = (text: string, name: string) => text.split('\n').filter((l) => l.startsWith(name))
const value = (text: string, line: string) => {
  const hit = text.split('\n').find((l) => l.startsWith(`${line} `))
  return hit ? Number(hit.slice(line.length + 1)) : Number.NaN
}

describe('F10 aggregates (RoomMetrics)', () => {
  it('push to COMMIT, fan-out and queue depth go into fixed buckets', () => {
    let now = 1_000_000
    const m = new RoomMetrics(() => now)
    m.committed([now - 3, now - 30, now - 3000], now)
    m.fanout(0.4)
    m.fanout(12)
    m.queueDepth(0)
    m.queueDepth(300_000)
    const text = render(m)
    expect(value(text, 'lobby_push_to_commit_ms_count')).toBe(3)
    expect(value(text, 'lobby_push_to_commit_ms_bucket{le="5"}')).toBe(1)
    expect(value(text, 'lobby_push_to_commit_ms_bucket{le="50"}')).toBe(2)
    expect(value(text, 'lobby_push_to_commit_ms_bucket{le="+Inf"}')).toBe(3)
    expect(value(text, 'lobby_commit_to_fanout_ms_bucket{le="1"}')).toBe(1)
    expect(value(text, 'lobby_commit_to_fanout_ms_count')).toBe(2)
    expect(value(text, 'lobby_outbound_queue_bytes_bucket{le="0"}')).toBe(1)
    expect(value(text, 'lobby_outbound_queue_bytes_bucket{le="262144"}')).toBe(1)
    expect(value(text, 'lobby_outbound_queue_bytes_bucket{le="1048576"}')).toBe(2)
    now += 1
    m.stop()
  })

  it('an ack written at once is timed at once; one queued behind other frames when its queue writes it', () => {
    let now = 0
    const m = new RoomMetrics(() => now)
    const out = {}
    m.ackQueued(out, 0, 100, 0, 4) // went to the socket in the call
    // queued behind 5 000 bytes (its own 120 included): written once the queue has sent 1 000 + 5 000
    m.ackQueued(out, 5_000, 1_000, 10, 20)
    m.ackFlushed(out, 3_000, 40) // not yet
    expect(value(render(m), 'lobby_ack_send_ms_count')).toBe(1)
    m.ackFlushed(out, 6_000, 400)
    const text = render(m)
    expect(value(text, 'lobby_ack_send_ms_count')).toBe(2)
    expect(value(text, 'lobby_ack_send_ms_bucket{le="5"}')).toBe(1)
    expect(value(text, 'lobby_ack_send_ms_bucket{le="250"}')).toBe(1)
    expect(value(text, 'lobby_ack_send_ms_bucket{le="400"}')).toBe(2)
    // another session's queue is its own
    m.ackFlushed({}, 1e9, 500)
    expect(value(render(m), 'lobby_ack_send_ms_count')).toBe(2)
    now = 1
    m.stop()
  })

  it('reconnects per minute: one observation per minute of the process, idle minutes 0, and a total', () => {
    let now = 0
    const m = new RoomMetrics(() => now)
    m.reconnect(1_000)
    m.reconnect(2_000)
    m.reconnect(59_000)
    now = METRICS_MINUTE_MS + 10
    m.reconnect(now) // the second minute
    now = 3 * METRICS_MINUTE_MS + 5 // two minutes ended: 1 then 0
    const text = render(m)
    expect(value(text, 'lobby_reconnects_per_minute_count')).toBe(3)
    expect(value(text, 'lobby_reconnects_per_minute_bucket{le="0"}')).toBe(1)
    expect(value(text, 'lobby_reconnects_per_minute_bucket{le="1"}')).toBe(2)
    expect(value(text, 'lobby_reconnects_per_minute_bucket{le="5"}')).toBe(3)
    expect(value(text, 'lobby_reconnects_total')).toBe(4)
    // a process idle for days observes at most a day of zeros at once
    now += 10 * 24 * 60 * METRICS_MINUTE_MS
    expect(value(render(m), 'lobby_reconnects_per_minute_count')).toBeLessThanOrEqual(3 + 1_440)
    m.stop()
  })

  it('the Prometheus text: each a histogram with buckets, sum and count, and no labels but le', () => {
    const m = new RoomMetrics(() => 0)
    const text = render(m)
    for (const name of [
      'lobby_push_to_commit_ms',
      'lobby_commit_to_fanout_ms',
      'lobby_outbound_queue_bytes',
      'lobby_ack_send_ms',
      'lobby_reconnects_per_minute',
    ]) {
      expect(text).toContain(`# TYPE ${name} histogram`)
      const lines = linesOf(text, `${name}_`)
      expect(lines.filter((l) => l.startsWith(`${name}_bucket{le=`)).length).toBeGreaterThan(5)
      expect(lines.some((l) => l.startsWith(`${name}_sum `))).toBe(true)
      expect(lines.some((l) => l.startsWith(`${name}_count `))).toBe(true)
      for (const l of lines) expect(l).toMatch(/^[a-z_]+(\{le="[^"]+"\})? [0-9.e+-]+$/)
    }
    m.stop()
  })

  it('cost: the hooks of a batch (16 pushes, 50 sessions) are well under 1% of a group commit', () => {
    let now = 0
    const m = new RoomMetrics(() => now)
    const outs = Array.from({ length: 50 }, () => ({}))
    const received = Array.from({ length: 16 }, (_, i) => i)
    const batch = () => {
      now++
      m.committed(received, now)
      for (let i = 0; i < 16; i++) m.ackQueued(outs[i] as object, 0, 0, i, now)
      m.fanout(0.5)
      for (const o of outs) {
        m.queueDepth(120)
        m.ackFlushed(o, 1000, now)
      }
    }
    for (let i = 0; i < 2_000; i++) batch() // warm up
    const runs = 20_000
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) batch()
    const perBatchMs = (performance.now() - t0) / runs
    // a group commit with synchronous=FULL takes milliseconds (lobby_commit_ms; B9's steady state: about 2 to
    // 10 ms); 1% of 1 ms is 10 µs
    console.log(
      `[F10] metrics hooks per batch of 16 pushes and 50 sessions: ${(perBatchMs * 1000).toFixed(2)} µs`,
    )
    expect(perBatchMs).toBeLessThan(0.01)
    m.stop()
  })
})

// ---- wave M (M7-3, S5): the hourly metrics.summary line --------------------------------------------------

const gauges = (o: Partial<SummaryGauges> = {}): SummaryGauges => ({
  rooms: 2,
  sessions: 5,
  outboundQueued: 1_234,
  diskFree: 0.8312,
  elements: [10, 4_000, 250],
  ...o,
})
const parseSummary = (line: string) => {
  expect(line.startsWith('metrics.summary {')).toBe(true)
  return JSON.parse(line.slice('metrics.summary '.length)) as Record<string, unknown> & {
    counts: Record<string, number>
    hist: Record<string, { n: number; p50?: number | null; p95?: number | null }>
    elements: Record<string, number>
  }
}
/** Nothing in a summary line may name a board, a person or an object: no word, no id, no uuid-like token. */
const NAMES_SOMETHING =
  /board|user|usr_|\bb-[a-z0-9]|ast_|ver_|wsp_|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,}/i

describe('M7-3: the metrics.summary line', () => {
  it('is logged once an hour (fake timers), and a last one, final, when the service stops', async () => {
    vi.useFakeTimers()
    try {
      const m = new RoomMetrics(() => Date.now())
      const lines: string[] = []
      const stop = m.startSummary(
        () => gauges(),
        (l) => lines.push(l),
      )
      await vi.advanceTimersByTimeAsync(METRICS_SUMMARY_MS - 1)
      expect(lines).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(lines).toHaveLength(1)
      expect(parseSummary(lines[0] as string)).toMatchObject({ windowS: 3_600, uptimeS: 3_600 })
      await vi.advanceTimersByTimeAsync(METRICS_SUMMARY_MS)
      expect(lines).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      stop(true)
      expect(lines).toHaveLength(3)
      expect(parseSummary(lines[2] as string)).toMatchObject({ final: true, windowS: 600, uptimeS: 7_800 })
      stop(true) // once only
      await vi.advanceTimersByTimeAsync(5 * METRICS_SUMMARY_MS)
      expect(lines).toHaveLength(3)
      m.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries the hour’s counts, F10 p50/p95 from the buckets, the gauges and the element shape, and names nothing', () => {
    let now = 1_000_000
    const m = new RoomMetrics(() => now)
    // labels that hold what must never reach a log line: they are dropped (counts are summed over labels)
    const secret = 'b-k3x9q2abcd usr_ABCDEFGHIJ0123 123e4567-e89b-12d3-a456-426614174000 Halden'
    m.inc('lobby_closes_total', { code: '4099', reason: secret })
    m.inc('lobby_closes_total', { code: '4000', reason: 'RECONNECT' })
    m.inc('lobby_pushes_received_total', {}, 30)
    m.inc('lobby_laser_frames_in_total', {}, 7)
    m.inc('lobby_outbound_bytes_total', {}, 5_000)
    m.inc('lobby_unknown_board_thing_total', { board: 'b-k3x9q2abcd' }) // not listed: not in the line
    for (let i = 0; i < 18; i++) m.committed([now - 3], now) // 3 ms: the 5 bucket
    m.committed([now - 40, now - 3_000], now) // the 50 bucket, and above the last bucket
    now += METRICS_SUMMARY_MS
    const line = m.summaryLine(gauges({ elements: [4_000, 10, 250, 90] }))
    expect(line).not.toMatch(NAMES_SOMETHING)
    expect(line).not.toContain('Halden')
    const s = parseSummary(line)
    expect(s.counts).toMatchObject({ closes: 2, pushes: 30, laserFramesIn: 7, joins: 0 })
    expect(s).toMatchObject({ outBytes: 5_000, outQueued: 1_234, diskFree: 0.8312, rooms: 2, sessions: 5 })
    expect(s.hist.pushToCommitMs).toEqual({ n: 20, p50: 5, p95: 50 })
    expect(s.hist.ackSendMs).toEqual({ n: 0 })
    expect(s.elements).toEqual({ n: 4, max: 4_000, p50: 90, p95: 4_000 })
    expect(Object.keys(s.counts)).not.toContain('unknownBoardThing')

    // the next hour counts only what happened in it
    m.inc('lobby_pushes_received_total', {}, 4)
    m.committed([now - 1_000], now)
    now += METRICS_SUMMARY_MS
    const next = parseSummary(m.summaryLine(gauges({ elements: [], diskFree: null })))
    expect(next.counts).toMatchObject({ closes: 0, pushes: 4, laserFramesIn: 0 })
    expect(next.outBytes).toBe(0)
    expect(next.hist.pushToCommitMs).toEqual({ n: 1, p50: 1_000, p95: 1_000 })
    expect(next.elements).toEqual({ n: 0 })
    expect(next.diskFree).toBeNull()
    // above the last bucket: null, never a made-up number
    m.committed([now - 9_999], now)
    now += 1
    expect(parseSummary(m.summaryLine(gauges())).hist.pushToCommitMs).toEqual({ n: 1, p50: null, p95: null })
    m.stop()
  })
})
