// F10 (wave L, L6-5): the realtime-quality aggregates of metrics.ts on a fake clock: push arrival to COMMIT,
// COMMIT to the end of the fan-out, outbound queue depth, ack written per session (at once, or when the
// session's queue writes it), reconnects per minute (idle minutes count 0); the Prometheus text has each as a
// histogram with fixed buckets and no labels. And their cost: the hooks of one batch are a small fraction of a
// group commit (the number is printed for the record).
import { describe, expect, it } from 'vitest'
import { METRICS_MINUTE_MS, RoomMetrics } from './metrics.ts'

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
