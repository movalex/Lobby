// GET /internal/metrics (docs/EXCALIDRAW-MIGRATION.md §2.4.6): Prometheus text for the watch after
// cut-over and the load test. Counters and simple histograms (sum, count and fixed buckets), process-wide
// for the ElementRoom service; per-board gauges come from the open rooms when rendered.

import { monitorEventLoopDelay } from 'node:perf_hooks'

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
  private readonly loop = monitorEventLoopDelay({ resolution: 10 })

  constructor() {
    this.loop.enable()
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${labelText(labels)}`
    this.counters.set(key, (this.counters.get(key) ?? 0) + by)
  }

  stop(): void {
    this.loop.disable()
  }

  render(rooms: { open: number; sessionsByRole: Record<string, number>; boards: BoardGauges[] }): string {
    const out: string[] = []
    out.push('# TYPE lobby_rooms_open gauge', `lobby_rooms_open ${rooms.open}`)
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
