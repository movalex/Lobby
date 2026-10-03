// PRF-02 / PRF-03 frame rate: panning the heavy board at Lobby's whole-board fit (every item on screen), at
// 0.25 and at 100%, on Lobby's board page. Like the 2026-09-27 review's harness: the pointer rests over the
// canvas, nothing is selected, and a scripted pan moves the camera every animation frame (the board page's
// LobbyCanvas.viewport.set, as a person's pan would; a back-and-forth of 600 CSS px at up to 1,200 px/s,
// half of it vertically) for 3 s, three times per view. Before a view is measured, the images in it are
// loaded (the loader's state) and the level-of-detail pass's bitmaps are ready when it is on.
//   rAF fps   = frames / s from requestAnimationFrame timestamps in the page (+ frame p50/p95/max)
//   trace     = a Chrome performance trace (CDP Tracing) of one more pan: frames the compositor drew
//               (DrawFrame), main-thread busy share, and self time per trace event (script, style,
//               layout, paint...) per frame
//   profile   = optional V8 CPU profile of one more pan: self time per function (use the readable
//               build, --readable, for names), to find hot spots
import { writeFileSync } from 'node:fs'
import type { CDPSession, Page } from '@playwright/test'
import {
  cpuMeter,
  imagesInView,
  median,
  type PerfView,
  type PerfWindow,
  round1,
  setView,
  sleep,
  waitImagesLoaded,
} from './lib.ts'

export type FpsView = PerfView

export interface PanRep {
  fps: number
  p50: number
  p95: number
  max: number
  over50: number
  frames: number
}

export interface TraceSummary {
  windowMs: number
  drawFrames: number
  traceFps: number
  mainBusyPct: number
  /** Self time on the renderer main thread per trace event name, ms per drawn frame (top entries). */
  selfMsPerFrame: Record<string, number>
}

export interface ProfileSummary {
  samplesMs: number
  busyMsPerFrame: number
  /** Self time per function (ms over the run, % of busy time). */
  top: { fn: string; selfMs: number; pct: number }[]
  /** Total time per function including what it called (`selfMs` holds the total here). */
  inclusive: { fn: string; selfMs: number; pct: number }[]
}

export interface FpsResult {
  view: FpsView
  /** pan amplitude, CSS px */
  panPx: number
  zoom: number
  /** items on the board, and those at least partly in view */
  items: number
  visibleItems: number
  /** image elements in view, and how many of them the loader had loaded before the pans */
  imagesInView: number
  imagesLoaded: number
  /** the level-of-detail pass's state after the pans (null: not on this page) */
  lod: unknown
  reps: PanRep[]
  medianFps: number
  minFps: number
  /** whole-machine CPU busy % during the timed pans (this PC is shared) */
  machineBusyPct: number
  trace?: TraceSummary
  profile?: ProfileSummary
}

/** The pan hooks on the board page's camera: start (remember it), move by dx, dy CSS px, end (restore). */
export async function installPanHooks(page: Page) {
  await page.evaluate(() => {
    const c = (window as unknown as PerfWindow).__lobbyBoard?.canvas
    if (!c) throw new Error('no window.__lobbyBoard')
    const w = window as unknown as Record<string, unknown>
    let o = c.viewport.get()
    w.__panStart = () => {
      o = c.viewport.get()
    }
    w.__panBy = (dx: number, dy: number) => c.viewport.set({ x: o.x - dx / o.zoom, y: o.y - dy / o.zoom })
    w.__panEnd = () => c.viewport.set({ x: o.x, y: o.y })
  })
}

/** One scripted pan (`amplitude` CSS px sideways, half that vertically); resolves with the rAF timestamps. */
export const pan = (page: Page, durationMs: number, amplitude = 600) =>
  page.evaluate(
    ({ durationMs, amplitude }) =>
      new Promise<number[]>((resolve) => {
        const w = window as unknown as {
          __panStart(): void
          __panBy(dx: number, dy: number): void
          __panEnd(): void
        }
        w.__panStart()
        const out: number[] = []
        let t0: number | null = null
        performance.mark('perf-pan-start')
        const step = (t: number) => {
          if (t0 === null) t0 = t
          const e = t - t0
          out.push(t)
          if (e > durationMs) {
            w.__panEnd()
            performance.mark('perf-pan-end')
            resolve(out)
            return
          }
          w.__panBy(amplitude * Math.sin((e / 1000) * 2), (amplitude / 2) * Math.sin((e / 1000) * 3))
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    { durationMs, amplitude },
  )

/** Waits until the level-of-detail pass has no stale or rendering bitmap (immediately when it is off or absent). */
export async function lodReady(page: Page, timeoutMs = 120_000): Promise<number> {
  const t0 = Date.now()
  await page.waitForFunction(
    () => {
      const s = (window as unknown as PerfWindow).__lobbyLod?.state()
      return !s?.active || (s.stale === 0 && s.rendering === 0)
    },
    undefined,
    { timeout: timeoutMs, polling: 100 },
  )
  return Date.now() - t0
}

function repStats(times: number[]): PanRep {
  const d: number[] = []
  for (let i = 1; i < times.length; i++) d.push((times[i] ?? 0) - (times[i - 1] ?? 0))
  const s = [...d].sort((a, b) => a - b)
  const q = (p: number) => round1(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0)
  const span = (times.at(-1) ?? 0) - (times[0] ?? 0)
  return {
    fps: round1(span > 0 ? d.length / (span / 1000) : 0),
    p50: q(0.5),
    p95: q(0.95),
    max: round1(s.at(-1) ?? 0),
    over50: d.filter((x) => x > 50).length,
    frames: d.length,
  }
}

// ---- trace ------------------------------------------------------------------------------------------

interface TraceEvent {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: { name?: string }
}

const TRACE_CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'v8',
]

async function traced<T>(cdp: CDPSession, fn: () => Promise<T>): Promise<{ value: T; events: TraceEvent[] }> {
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { includedCategories: TRACE_CATEGORIES, excludedCategories: ['*'] },
  })
  const value = await fn()
  const complete = new Promise<string>((resolve) =>
    cdp.once('Tracing.tracingComplete', (e) => resolve(e.stream ?? '')),
  )
  await cdp.send('Tracing.end')
  const stream = await complete
  let text = ''
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 4 * 1024 * 1024 })
    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: stream })
  const parsed = JSON.parse(text) as { traceEvents?: TraceEvent[] } | TraceEvent[]
  return { value, events: Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []) }
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary | undefined {
  const start = events.find((e) => e.name === 'perf-pan-start')
  const end = events.find((e) => e.name === 'perf-pan-end')
  if (!start || !end) return undefined
  const pid = start.pid
  const mains = new Set(
    events
      .filter(
        (e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === pid && e.args?.name === 'CrRendererMain',
      )
      .map((e) => e.tid),
  )
  const from = start.ts
  const to = end.ts
  const inWindow = (e: TraceEvent) => e.ts >= from && e.ts <= to
  const drawFrames = events.filter((e) => e.pid === pid && e.name === 'DrawFrame' && inWindow(e)).length
  // Complete events on the main thread, nested: self time = duration minus direct children.
  const main = events
    .filter((e) => e.ph === 'X' && e.dur !== undefined && e.pid === pid && mains.has(e.tid) && inWindow(e))
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
  const self = new Map<string, number>()
  let busy = 0
  const stack: { end: number; name: string; child: number; dur: number }[] = []
  const pop = () => {
    const top = stack.pop()
    if (top) self.set(top.name, (self.get(top.name) ?? 0) + Math.max(0, top.dur - top.child))
  }
  for (const e of main) {
    const dur = e.dur ?? 0
    while (stack.length && (stack.at(-1)?.end ?? 0) <= e.ts) pop()
    const parent = stack.at(-1)
    if (parent) parent.child += dur
    else busy += dur
    stack.push({ end: e.ts + dur, name: e.name, child: 0, dur })
  }
  while (stack.length) pop()
  const windowMs = (to - from) / 1000
  const perFrame = Math.max(1, drawFrames)
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  return {
    windowMs: round1(windowMs),
    drawFrames,
    traceFps: round1(drawFrames / (windowMs / 1000)),
    mainBusyPct: round1((busy / 1000 / windowMs) * 100),
    selfMsPerFrame: Object.fromEntries(top.map(([k, v]) => [k, round1(v / 1000 / perFrame)])),
  }
}

// ---- CPU profile ----------------------------------------------------------------------------------

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }
  children?: number[]
}

export interface CpuProfile {
  nodes: ProfileNode[]
  samples?: number[]
  timeDeltas?: number[]
}

export async function startProfile(cdp: CDPSession) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
}

export async function stopProfile(cdp: CDPSession, out?: string): Promise<CpuProfile> {
  const { profile } = await cdp.send('Profiler.stop')
  await cdp.send('Profiler.disable')
  if (out) writeFileSync(out, JSON.stringify(profile))
  return profile as CpuProfile
}

const frameKey = (n: ProfileNode) => {
  const name = n.callFrame.functionName || '(anonymous)'
  const file = n.callFrame.url.split('/').pop()?.split('?')[0] ?? ''
  return file ? `${name} ${file}:${n.callFrame.lineNumber + 1}` : name
}

/** Self and total (inclusive) time per function, busy ms per frame. */
export function summarizeProfile(profile: CpuProfile, frameCount: number): ProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const self = new Map<string, number>()
  const total = new Map<string, number>()
  let all = 0
  let idle = 0
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  samples.forEach((id, i) => {
    const dt = deltas[i] ?? 0
    all += dt
    const n = byId.get(id)
    if (!n) return
    if (n.callFrame.functionName === '(idle)') {
      idle += dt
      return
    }
    const key = frameKey(n)
    self.set(key, (self.get(key) ?? 0) + dt)
    const seen = new Set<string>()
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const node = byId.get(cur)
      if (!node) break
      const k = frameKey(node)
      if (seen.has(k) || k === '(root)') continue
      seen.add(k)
      total.set(k, (total.get(k) ?? 0) + dt)
    }
  })
  const busy = all - idle
  const rows = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([fn, us]) => ({ fn, selfMs: round1(us / 1000), pct: round1((us / Math.max(1, busy)) * 100) }))
  return {
    samplesMs: round1(all / 1000),
    busyMsPerFrame: round1(busy / 1000 / Math.max(1, frameCount)),
    top: rows(self),
    inclusive: rows(total),
  }
}

export function logProfile(log: (s: string) => void, label: string, s: ProfileSummary, rows = 25) {
  log(`  ${label}: ${s.busyMsPerFrame} ms busy per frame; top self time:`)
  for (const f of s.top.slice(0, rows))
    log(`    ${f.selfMs.toFixed(1).padStart(8)} ms ${f.pct.toFixed(1).padStart(5)}%  ${f.fn}`)
  log(`  ${label}: top total (inclusive) time:`)
  for (const f of s.inclusive.slice(0, rows + 10))
    log(`    ${f.selfMs.toFixed(1).padStart(8)} ms ${f.pct.toFixed(1).padStart(5)}%  ${f.fn}`)
}

// ---- the measurement ------------------------------------------------------------------------------

/** The budget key of a result: the view, plus the amplitude when it is not the standard 600 px pan. */
export const fpsKey = (r: Pick<FpsResult, 'view' | 'panPx'>) =>
  r.panPx === STANDARD_PAN_PX ? r.view : `${r.view}@${r.panPx}`

export const STANDARD_PAN_PX = 600

export async function measureFps(opts: {
  page: Page
  cdp: CDPSession
  views: FpsView[]
  /** frame 0's id (the 0.25 and 100% views) */
  frame0: string
  reps: number
  durationMs: number
  /**
   * Pan amplitudes in CSS px, each measured separately per view (default [600]: the review's harness,
   * up to 1,200 px/s). `fitPans` adds amplitudes for the fit view only.
   */
  panPx?: number[]
  fitPans?: number[]
  trace: boolean
  profile: boolean
  /** Where to save each view's raw CPU profile (a DevTools .cpuprofile), when profiling. */
  profileOut?: (key: string) => string
  log: (s: string) => void
}): Promise<FpsResult[]> {
  const { page, cdp } = opts
  const results: FpsResult[] = []
  const vp = page.viewportSize() ?? { width: 1536, height: 864 }
  await page.mouse.move(vp.width / 2, vp.height / 2)
  await installPanHooks(page)
  for (const view of opts.views) {
    const cam = await setView(page, view, opts.frame0)
    // settle: the images in view loaded, the level-of-detail bitmaps ready, then the engine's idle repaint
    await sleep(2500)
    const inView = await imagesInView(page)
    const imgs = await waitImagesLoaded(page, 60_000, inView)
    const lodMs = await lodReady(page)
    await sleep(500)
    if (imgs.loaded < imgs.total)
      opts.log(
        `fps ${view}: only ${imgs.loaded}/${imgs.total} images in view loaded after ${imgs.ms} ms (measuring anyway)`,
      )
    else if (imgs.total)
      opts.log(
        `fps ${view}: ${imgs.total} images in view loaded (${imgs.ms} ms after the settle); lod ready ${lodMs} ms`,
      )
    const amplitudes = [...(opts.panPx ?? [STANDARD_PAN_PX]), ...(view === 'fit' ? (opts.fitPans ?? []) : [])]
    for (const panPx of amplitudes) {
      const reps: PanRep[] = []
      const machine = cpuMeter()
      for (let i = 0; i < opts.reps; i++) {
        reps.push(repStats(await pan(page, opts.durationMs, panPx)))
        await page.waitForTimeout(400)
      }
      const fpsList = reps.map((r) => r.fps)
      const result: FpsResult = {
        view,
        panPx,
        zoom: Math.round(cam.zoom * 10_000) / 10_000,
        items: cam.total,
        visibleItems: cam.visible,
        imagesInView: imgs.total,
        imagesLoaded: imgs.loaded,
        lod: await page.evaluate(() => (window as unknown as PerfWindow).__lobbyLod?.state() ?? null),
        reps,
        medianFps: median(fpsList),
        minFps: Math.min(...fpsList),
        machineBusyPct: machine(),
      }
      const key = fpsKey(result)
      if (opts.trace) {
        const { events } = await traced(cdp, () => pan(page, opts.durationMs, panPx))
        result.trace = summarizeTrace(events)
        await page.waitForTimeout(400)
      }
      if (opts.profile) {
        await startProfile(cdp)
        const times = await pan(page, opts.durationMs, panPx)
        const profile = await stopProfile(cdp, opts.profileOut?.(key.replace('@', '-')))
        result.profile = summarizeProfile(profile, times.length - 1)
        await page.waitForTimeout(400)
      }
      results.push(result)
      const t = result.trace
      opts.log(
        `fps ${key} (zoom ${result.zoom}, ${cam.visible}/${cam.total} items in view, ${imgs.loaded}/${imgs.total} images loaded, ${panPx} px pan): pan ${fpsList.join(' / ')} fps ` +
          `(median ${result.medianFps}; frame p95 ${reps.map((r) => r.p95).join('/')} ms; machine ${result.machineBusyPct}% busy)` +
          (t
            ? `; trace ${t.traceFps} fps drawn, main thread ${t.mainBusyPct}% busy, per frame ${Object.entries(
                t.selfMsPerFrame,
              )
                .slice(0, 6)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')} ms`
            : ''),
      )
      if (result.profile) logProfile(opts.log, `pan profile ${key}`, result.profile)
    }
  }
  return results
}
