// Frame-rate measurement shared by the A14 specs (render-a14-heavy for Excalidraw, render-a14-tldraw for
// today's tldraw board), so both engines are measured the same way, in the same browser, on the same
// machine. The method is e2e/perf/fps.ts's (the 2026-09-27 review's): the pointer rests over the canvas,
// nothing is selected, a scripted pan moves the camera every animation frame for 3 s (a 600 CSS px sine
// sideways at up to 1,200 px/s, half of it vertically), three times per view; fps = rAF callbacks per
// second; plus one traced pan: frames the compositor drew (DrawFrame) and main-thread busy share.
import type { Browser, CDPSession, Page } from '@playwright/test'
import { chromium } from '@playwright/test'
import { summarizeTrace, type TraceSummary } from '../../perf/fps.ts'
import { cpuMeter, median, round1 } from '../../perf/lib.ts'

export const VIEWPORT = { width: 1536, height: 864 } // e2e/perf/lib.ts: the review's 1920x1080 panel at 125%
export const DPR = 1.25
/** e2e/perf/lib.ts launchBrowser('chrome')'s flags, on Playwright's headless shell (not the user's Chrome). */
export const GPU_ARGS = [
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--use-angle=d3d11',
  '--enable-precise-memory-info',
]

export async function launchGpuShell(): Promise<Browser> {
  return chromium.launch({ headless: true, args: GPU_ARGS })
}

export interface GpuInfo {
  browser: string
  renderer: string
  canvas2d: string
  gpuCompositing: string
  devices: string[]
}

/** Which GPU the browser really used (WebGL renderer string and Chromium's feature status). */
export async function gpuInfo(browser: Browser, page: Page): Promise<GpuInfo> {
  const cdp = await browser.newBrowserCDPSession()
  const info = (await cdp.send('SystemInfo.getInfo')) as unknown as {
    gpu: { devices: { deviceString: string }[]; featureStatus: Record<string, string> }
  }
  await cdp.detach()
  const renderer = await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl')
    const d = g?.getExtension('WEBGL_debug_renderer_info')
    return d && g ? String(g.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'none'
  })
  return {
    browser: browser.version(),
    renderer,
    canvas2d: info.gpu.featureStatus['2d_canvas'] ?? '?',
    gpuCompositing: info.gpu.featureStatus.gpu_compositing ?? '?',
    devices: info.gpu.devices.map((d) => d.deviceString),
  }
}

export interface PanRep {
  fps: number
  p50: number
  p95: number
  max: number
  over50: number
  frames: number
}

export function repStats(times: number[]): PanRep {
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

/**
 * One scripted pan. The page must define `window.__panStart()` (remember the camera) and
 * `window.__panBy(dx, dy)` (camera = start moved by dx, dy CSS px) and `window.__panEnd()`.
 */
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

export async function traced<T>(
  cdp: CDPSession,
  fn: () => Promise<T>,
): Promise<{ value: T; summary?: TraceSummary }> {
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
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])
  return { value, summary: summarizeTrace(events as never) }
}

export interface ViewResult {
  view: string
  zoom: number
  reps: PanRep[]
  medianFps: number
  minFps: number
  machineBusyPct: number
  trace?: TraceSummary
  extra?: Record<string, unknown>
}

/** 3 pans of 3 s (the review's method) and one traced pan, for the view the page is in now. */
export async function measureView(
  page: Page,
  cdp: CDPSession,
  view: string,
  zoom: number,
  opts: { reps?: number; durationMs?: number; amplitude?: number } = {},
): Promise<ViewResult> {
  const reps: PanRep[] = []
  const machine = cpuMeter()
  for (let i = 0; i < (opts.reps ?? 3); i++) {
    reps.push(repStats(await pan(page, opts.durationMs ?? 3000, opts.amplitude ?? 600)))
    await page.waitForTimeout(400)
  }
  const machineBusyPct = machine()
  const { summary } = await traced(cdp, () => pan(page, opts.durationMs ?? 3000, opts.amplitude ?? 600))
  await page.waitForTimeout(400)
  const list = reps.map((r) => r.fps)
  return {
    view,
    zoom,
    reps,
    medianFps: median(list),
    minFps: Math.min(...list),
    machineBusyPct,
    trace: summary,
  }
}
