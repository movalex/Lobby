// Profiling preload for the room's event loop (docs/EXCALIDRAW-MIGRATION.md §2.13, B9's event-loop and CPU
// targets): names the tasks that block sync's event loop, and writes a CPU profile of the first
// TASK_TIMING_PROFILE_MS of the process (default 90 s; 0: none) into TASK_TIMING_DIR, so a SIGKILLed
// process (B9's restart at minute 8) still leaves a profile: `--cpu-prof` writes only at a normal exit.
//
// Every 10 s one JSON line goes to stderr (`[task-timing] {...}`): the event-loop delay of that window
// (monitorEventLoopDelay, reset per window: p50, p99, max, samples over 50 ms), the GC pauses of the window
// (PerformanceObserver 'gc': minor/major/incremental ms), the room's wrapped entry points (count, total ms,
// max ms, calls over 10 and 50 ms) and the process CPU (user+system ms of the window). The wrapped methods
// are the room's own (ElementRoom.prototype): hello, drainBatch, presenceTick, leaseTick, message,
// snapshotFor, rebuildCaches, connect and closed_, plus the hello-queue slice (drainHellos is module-local,
// so the queue's cost shows under hello). Test-only, like the other preloads here: nothing in apps/ changes,
// sync gets it through NODE_OPTIONS=--import=.../e2e/load/task-timing-hook.ts.
import { mkdirSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector'
import { join } from 'node:path'
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks'
import { ElementRoom } from '../../apps/sync/src/room/element-room.ts'

const WINDOW_MS = 10_000
const dir = process.env.TASK_TIMING_DIR ?? '.'
const profileMs = Number(process.env.TASK_TIMING_PROFILE_MS ?? '90000')
const started = Date.now()

interface TaskStat {
  n: number
  ms: number
  max: number
  over10: number
  over50: number
}
const tasks = new Map<string, TaskStat>()
const stat = (name: string): TaskStat => {
  let s = tasks.get(name)
  if (!s) {
    s = { n: 0, ms: 0, max: 0, over10: 0, over50: 0 }
    tasks.set(name, s)
  }
  return s
}
let depth = 0
function wrap(proto: object, name: string): void {
  const p = proto as Record<string, unknown>
  const orig = p[name]
  if (typeof orig !== 'function') {
    process.stderr.write(`[task-timing] no method ${name}\n`)
    return
  }
  p[name] = function (this: unknown, ...args: unknown[]) {
    // nested calls (hello inside message, snapshotFor inside hello) count their own time too; the outermost
    // call is the task the loop waited for
    const t0 = performance.now()
    depth++
    try {
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    } finally {
      depth--
      const ms = performance.now() - t0
      const s = stat(depth === 0 ? name : `${name} (nested)`)
      s.n++
      s.ms += ms
      if (ms > s.max) s.max = ms
      if (ms > 10) s.over10++
      if (ms > 50) s.over50++
    }
  }
}
for (const m of [
  'hello',
  'drainBatch',
  'presenceTick',
  'leaseTick',
  'message',
  'snapshotFor',
  'rebuildCaches',
  'connect',
  'closed_',
  'broadcast',
]) {
  wrap(ElementRoom.prototype, m)
}

const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()
const gc = { minor: 0, major: 0, incremental: 0, weak: 0, count: 0 }
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const kind = (e as { detail?: { kind?: number } }).detail?.kind ?? 0
    gc.count++
    // perf_hooks constants: 1 major, 2 minor, 4 incremental, 8 weak callbacks
    if (kind === 1) gc.major += e.duration
    else if (kind === 2) gc.minor += e.duration
    else if (kind === 4) gc.incremental += e.duration
    else gc.weak += e.duration
  }
})
obs.observe({ entryTypes: ['gc'] })

let lastCpu = process.cpuUsage()
const round = (v: number) => Math.round(v * 10) / 10
const tick = () => {
  const cpu = process.cpuUsage(lastCpu)
  lastCpu = process.cpuUsage()
  const line = {
    t: Date.now() - started,
    loop: {
      p50: round(loop.percentile(50) / 1e6),
      p99: round(loop.percentile(99) / 1e6),
      max: round(loop.max / 1e6),
      samples: loop.count,
      over50: countOver(loop, 50),
    },
    gc: {
      minorMs: round(gc.minor),
      majorMs: round(gc.major),
      incrementalMs: round(gc.incremental),
      weakMs: round(gc.weak),
      count: gc.count,
    },
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    rssMB: Math.round(process.memoryUsage.rss() / 1048576),
    tasks: Object.fromEntries(
      [...tasks]
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([k, v]) => [
          k,
          { n: v.n, ms: round(v.ms), max: round(v.max), over10: v.over10, over50: v.over50 },
        ]),
    ),
  }
  process.stderr.write(`[task-timing] ${JSON.stringify(line)}\n`)
  loop.reset()
  gc.minor = gc.major = gc.incremental = gc.weak = 0
  gc.count = 0
  tasks.clear()
}
/** How many samples of the window were above `ms` (from the histogram's percentiles: an estimate). */
function countOver(h: ReturnType<typeof monitorEventLoopDelay>, ms: number): number {
  if (!h.count) return 0
  // binary search the percentile at which the delay passes `ms`
  let lo = 0
  let hi = 100
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (h.percentile(Math.max(0.001, Math.min(100, mid))) / 1e6 > ms) hi = mid
    else lo = mid
  }
  return Math.round(((100 - hi) / 100) * h.count)
}
const timer = setInterval(tick, WINDOW_MS)
timer.unref()

// the CPU profile of the first `profileMs`, written while the process is alive
if (profileMs > 0) {
  const session = new Session()
  session.connect()
  session.post('Profiler.enable', () => {
    session.post('Profiler.setSamplingInterval', { interval: 500 }, () => {
      session.post('Profiler.start', () => {
        const stop = () => {
          session.post('Profiler.stop', (err, res) => {
            if (err || !res) {
              process.stderr.write(`[task-timing] profile failed: ${String(err)}\n`)
              return
            }
            try {
              mkdirSync(dir, { recursive: true })
              const file = join(dir, `sync-${process.pid}-${started}.cpuprofile`)
              writeFileSync(file, JSON.stringify((res as { profile: unknown }).profile))
              process.stderr.write(`[task-timing] cpu profile written ${file}\n`)
            } catch (e) {
              process.stderr.write(`[task-timing] profile write failed: ${String(e)}\n`)
            }
            session.disconnect()
          })
        }
        const t = setTimeout(stop, profileMs)
        t.unref()
      })
    })
  })
}
process.stderr.write(`[task-timing] on: window ${WINDOW_MS} ms, profile ${profileMs} ms into ${dir}\n`)
