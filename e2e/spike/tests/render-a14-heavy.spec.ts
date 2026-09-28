import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, expect, type Page, test } from '@playwright/test'
import { median } from '../../perf/lib.ts'
import { type FilesServer, startFilesServer } from '../fixtures/files-server.ts'
import {
  DPR,
  type GpuInfo,
  gpuInfo,
  launchGpuShell,
  measureView,
  repStats,
  VIEWPORT,
  type ViewResult,
} from '../fixtures/perf-kit.ts'
import type { LoaderLike, OverridesLike } from '../fixtures/render-types.ts'
import { blockForeignRequests, waitSpikeReady } from '../support/page.ts'
import { SPIKE_API_ORIGIN, SPIKE_RUN_TAG, SPIKE_WEB_URL } from '../support/ports.ts'
import type { SpikeApi } from '../support/spike-global.ts'

// A14 (docs/EXCALIDRAW-MIGRATION.md §8.2, §8.4): render performance of the heavy perf board in Excalidraw.
// The board of e2e/perf/seed.ts (20 frames, 4,500 sticky notes each with a bound label, 200 images) is
// built in the page (render-heavy.tsx), stored on the fixture server and opened like a board: fetch the
// scene, apply it (captureUpdate NEVER), fit, paint; images come through Lobby's loader (small PNGs,
// same-origin). Frame rate with e2e/perf's method (fixtures/perf-kit.ts): views fit (Excalidraw's own
// fit, clamped to its minimum zoom), the true fit (below the minimum), 0.25 and 1; plus a 100-note drag
// preview through RenderOverrides at zoom 1.
// Browser: Playwright's headless shell with e2e/perf's GPU flags, 1536x864 at DPR 1.25 (e2e/perf).
// Opt-in (SPIKE_A14=1): it takes about 2 minutes. Reported, not gated (the gate is §8.5).

test.skip(!process.env.SPIKE_A14, 'set SPIKE_A14=1 to run the heavy-board render check')
test.setTimeout(15 * 60_000)

const SPEC = { frames: 20, notes: 4_500, images: 200 }
const OPENS = 3
let files: FilesServer
let browser: Browser

test.beforeAll(async () => {
  files = await startFilesServer(Number(new URL(SPIKE_API_ORIGIN).port))
  browser = await launchGpuShell()
})
test.afterAll(async () => {
  await browser?.close()
  await files?.close()
})

interface HeavyExtra {
  timing: Record<string, number>
  loader: LoaderLike
  overrides: OverridesLike
  generate(spec: typeof SPEC): { json: string; count: number; ms: number }
  syncImages(): void
  visibleFileIds(): string[]
  sceneBytes: number
  sceneCount: number
}

const newPage = async () => {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    baseURL: SPIKE_WEB_URL,
  })
  const page = await context.newPage()
  await blockForeignRequests(page)
  return { context, page }
}

/** Opens the heavy board cold (new context: empty HTTP cache) and waits for the first paint + fonts. */
async function openHeavy(page: Page) {
  const t0 = Date.now()
  await page.goto('/spike/render-heavy?scene=/files/__spike/heavy.json')
  await waitSpikeReady(page, 120_000)
  await page.waitForFunction(
    () => ((window.__lobbySpike as { extra: unknown }).extra as HeavyExtra).timing.fonts !== undefined,
    null,
    { timeout: 120_000 },
  )
  const wallMs = Date.now() - t0
  const t = await page.evaluate(
    () => ((window.__lobbySpike as { extra: unknown }).extra as HeavyExtra).timing,
  )
  // then the visible images through the loader
  const t1 = Date.now()
  await page.waitForFunction(
    () => {
      const x = (window.__lobbySpike as { extra: unknown }).extra as HeavyExtra
      const s = x.loader.states()
      return s.loaded + s.failed >= x.visibleFileIds().length && s.loading === 0
    },
    null,
    { timeout: 60_000, polling: 50 },
  )
  return { wallMs, visibleImagesMs: Date.now() - t1, timing: t }
}

/** The page's camera controls for perf-kit's pan, and the views. */
async function installCamera(page: Page) {
  await page.evaluate(() => {
    const api = window.__lobbySpike?.api as SpikeApi
    const w = window as unknown as Record<string, unknown>
    let o = { x: 0, y: 0, z: 1 }
    w.__panStart = () => {
      const s = api.getAppState()
      o = { x: s.scrollX, y: s.scrollY, z: s.zoom.value }
    }
    w.__panBy = (dx: number, dy: number) =>
      api.updateScene({ appState: { scrollX: o.x - dx / o.z, scrollY: o.y - dy / o.z } })
    w.__panEnd = () => api.updateScene({ appState: { scrollX: o.x, scrollY: o.y } })
  })
}

type View = 'fit' | 'fit-true' | '0.25' | '1'

async function setView(page: Page, view: View) {
  return page.evaluate(async (view) => {
    const spike = window.__lobbySpike
    const api = spike?.api as SpikeApi & { setViewport(o: Record<string, unknown>): void }
    const x = spike?.extra as unknown as HeavyExtra
    const els = api.getSceneElements()
    const s = api.getAppState()
    const f0 = els.find((e) => e.id === 'perf-f0')
    if (!f0) throw new Error('no frame 0')
    const [minX, minY, maxX, maxY] = (
      (spike as { extra: unknown }).extra as { engine: { getCommonBounds(e: unknown[]): number[] } }
    ).engine
      .getCommonBounds(els as unknown[])
      .map(Number) as [number, number, number, number]
    const W = s.width as number
    const H = s.height as number
    const trueFit = Math.min(W / (maxX - minX), H / (maxY - minY)) * 0.95
    if (view === 'fit') api.setViewport({ target: els, fit: 'contain' })
    else if (view === 'fit-true') {
      const z = trueFit
      api.updateScene({
        appState: {
          zoom: { value: z },
          scrollX: W / 2 / z - (minX + maxX) / 2,
          scrollY: H / 2 / z - (minY + maxY) / 2,
          selectedElementIds: {},
        },
      })
    } else if (view === '0.25') {
      const z = 0.25
      api.updateScene({
        appState: {
          zoom: { value: z },
          scrollX: W / 2 / z - (f0.x + f0.width / 2),
          scrollY: H / 2 / z - (f0.y + f0.height / 2),
          selectedElementIds: {},
        },
      })
    } else {
      api.updateScene({
        appState: { zoom: { value: 1 }, scrollX: -f0.x + 20, scrollY: -f0.y + 20, selectedElementIds: {} },
      })
    }
    // updateScene / setViewport apply on the next render: read the camera two frames later
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const after = api.getAppState()
    const z = after.zoom.value
    const vx1 = -after.scrollX
    const vy1 = -after.scrollY
    const vx2 = vx1 + W / z
    const vy2 = vy1 + H / z
    const visible = els.filter(
      (e) => e.x + e.width >= vx1 && e.x <= vx2 && e.y + e.height >= vy1 && e.y <= vy2,
    ).length
    x.syncImages()
    return {
      zoom: z,
      trueFit,
      visible,
      total: els.length,
      boardInView: vx1 <= minX && vy1 <= minY && vx2 >= maxX && vy2 >= maxY,
    }
  }, view)
}

/** A 100-note drag preview (render offsets change every frame) at zoom 1, camera still. */
const dragPreview = (page: Page, durationMs: number) =>
  page.evaluate(
    (durationMs) =>
      new Promise<{ times: number[]; updates: number }>((resolve) => {
        const x = (window.__lobbySpike as { extra: unknown }).extra as HeavyExtra
        const ids = Array.from({ length: 100 }, (_, k) => `perf-n0-${k}`)
        const out: number[] = []
        let t0: number | null = null
        let updates = 0
        const step = (t: number) => {
          if (t0 === null) t0 = t
          const e = t - t0
          out.push(t)
          if (e > durationMs) {
            x.overrides.setDrag('peer-bob', null)
            resolve({ times: out, updates })
            return
          }
          const dx = 120 * Math.sin((e / 1000) * 2)
          const dy = 60 * Math.sin((e / 1000) * 3)
          x.overrides.setDrag('peer-bob', new Map(ids.map((id) => [id, { x: dx, y: dy }])))
          updates++
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    durationMs,
  )

test('A14: heavy board (20 frames, 4,500 notes with labels, 200 images) open time and pan fps', async () => {
  const run = process.env.SPIKE_A14_RUN ?? '0'
  const log = (s: string) => console.log(`[A14 run ${run}] ${s}`)
  // 1. build the scene in the page and store it on the fixture server
  const gen = await newPage()
  await gen.page.goto('/spike/render-heavy')
  await waitSpikeReady(gen.page)
  const gpu: GpuInfo = await gpuInfo(browser, gen.page)
  const built = await gen.page.evaluate(
    (spec) => ((window.__lobbySpike as { extra: unknown }).extra as HeavyExtra).generate(spec),
    SPEC,
  )
  files.put('heavy.json', built.json, 'application/json')
  await gen.context.close()
  log(
    `scene: ${built.count} elements, ${(built.json.length / 1e6).toFixed(1)} MB JSON, built in ${built.ms} ms; GPU ${gpu.renderer}, canvas2d ${gpu.canvas2d}`,
  )

  // 2. cold opens (a fresh context each: empty HTTP cache)
  const opens: Awaited<ReturnType<typeof openHeavy>>[] = []
  for (let i = 0; i < OPENS; i++) {
    const o = await newPage()
    opens.push(await openHeavy(o.page))
    await o.context.close()
    log(
      `open ${i + 1}: ${opens.at(-1)?.wallMs} ms wall (painted ${Math.round(opens.at(-1)?.timing.painted ?? 0)} ms after navigation start)`,
    )
  }

  // 3. frame rate in a fresh tab
  files.resetStats()
  const { context, page } = await newPage()
  const open = await openHeavy(page)
  const cdp = await context.newCDPSession(page)
  await installCamera(page)
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await page.waitForTimeout(3000)
  const results: (ViewResult & { visible: number; boardInView: boolean })[] = []
  for (const view of ['fit', 'fit-true', '0.25', '1'] as View[]) {
    const v = await setView(page, view)
    await page.waitForTimeout(2500)
    await page
      .waitForFunction(
        () => {
          const x = (window.__lobbySpike as { extra: unknown }).extra as HeavyExtra
          return x.loader.states().loading === 0 && x.loader.states().queued === 0
        },
        null,
        { timeout: 30_000 },
      )
      .catch(() => {})
    const r = await measureView(page, cdp, view, v.zoom)
    results.push({
      ...r,
      visible: v.visible,
      boardInView: v.boardInView,
      extra: { trueFit: v.trueFit, total: v.total },
    })
    log(
      `fps ${view} (zoom ${v.zoom.toFixed(3)}, ${v.visible}/${v.total} elements in view, whole board in view: ${v.boardInView}): ` +
        `${r.reps.map((x) => x.fps).join(' / ')} (median ${r.medianFps}; p95 ${r.reps.map((x) => x.p95).join('/')} ms; ` +
        `trace ${r.trace?.traceFps} fps drawn, main ${r.trace?.mainBusyPct}% busy; machine ${r.machineBusyPct}% busy)`,
    )
  }
  // 4. drag preview of 100 notes through the overrides owner, zoom 1
  await setView(page, '1')
  await page.waitForTimeout(1500)
  const dragReps = []
  for (let i = 0; i < 3; i++) {
    const d = await dragPreview(page, 3000)
    dragReps.push({ ...repStats(d.times), updates: d.updates })
    await page.waitForTimeout(300)
  }
  log(
    `drag preview (100 notes, offsets every frame, zoom 1): ${dragReps.map((d) => d.fps).join(' / ')} fps, ${dragReps.map((d) => d.updates).join('/')} override updates`,
  )

  const loaderStats = await page.evaluate(() => {
    const x = (window.__lobbySpike as { extra: unknown }).extra as HeavyExtra
    return { states: x.loader.states(), stats: { ...x.loader.stats } }
  })
  const memory = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } })
      .memory
    return m
      ? { usedMB: Math.round(m.usedJSHeapSize / 1e6), totalMB: Math.round(m.totalJSHeapSize / 1e6) }
      : null
  })
  const probe = await page.evaluate(() => {
    const x = (window.__lobbySpike as { extra: unknown }).extra as unknown as {
      probe: { ops: unknown[]; versionDrift(): unknown[] }
    }
    return { ops: x.probe.ops.length, drift: x.probe.versionDrift().length }
  })
  await context.close()

  const report = {
    at: new Date().toISOString(),
    run,
    spec: SPEC,
    gpu,
    viewport: `${VIEWPORT.width}x${VIEWPORT.height} @${DPR}`,
    scene: { elements: built.count, bytes: built.json.length, buildMs: built.ms },
    opens: opens.map((o) => ({ wallMs: o.wallMs, visibleImagesMs: o.visibleImagesMs, timing: o.timing })),
    openMedianMs: median(opens.map((o) => o.wallMs)),
    fpsTab: { open: open.wallMs },
    views: results,
    dragPreview: dragReps,
    loader: loaderStats,
    serverMaxInFlight: files.stats.maxInFlight,
    memory,
    echo: probe,
  }
  const dir = join(import.meta.dirname, '..', '..', 'test-results', `${SPIKE_RUN_TAG}-a14`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `a14-run-${run}.json`), JSON.stringify(report, null, 2))
  log(
    `open median ${report.openMedianMs} ms; loader max in flight ${loaderStats.stats.maxInFlight} (server ${files.stats.maxInFlight}); heap ${memory?.usedMB} MB; echo ops ${probe.ops}`,
  )
  console.log('A14-METRICS', JSON.stringify(report))
  expect(loaderStats.stats.maxInFlight).toBeLessThanOrEqual(6)
  expect(probe.ops).toBe(0)
})
