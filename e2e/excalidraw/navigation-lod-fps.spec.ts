// A measurement, not part of the regular run (LOBBY_MEASURE_FPS=1): pan fps of the heavy board (the perf
// seed's 20 frames, 4,500 notes, 200 images: e2e/perf/seed.ts HEAVY) on the Excalidraw board page at
// Lobby's whole-board fit, at 0.25 and at 1, with sync running (the page's own socket is live), for the
// level-of-detail pass of docs/EXCALIDRAW-MIGRATION.md §8.5 (wave 3b: ≥ 24 fps at Lobby's fit).
//
// Same method as spike A14 and spike B's perf-fps (e2e/spike/fixtures/perf-kit.ts `measureView`): the
// headless shell with GPU flags, 1536×864 at DPR 1.25, the pointer at rest over the canvas, nothing
// selected, 3 scripted pans of 3 s per view (a 600 px sine, half of it vertically) plus one traced pan; the
// camera moves through LobbyCanvas.viewport.set (the board page's camera, as a person's pan would).
//
// Each view is measured once per MODE, in the same page and the same machine state:
//   default   the page as it is
//   lod-off   the level-of-detail pass switched off (window.__lobbyLod, dev-auth builds only)
//   lod-on    the level-of-detail pass switched on (its default)
// LOBBY_FPS_MODES=a,b picks the modes (default: default, or lod-off,lod-on when the pass is on the page);
// LOBBY_FPS_PROFILE=1 adds one V8 CPU-profiled pan per view and mode (the top functions are logged; the
// raw .cpuprofile goes to the test's output folder).
//
//   LOBBY_MEASURE_FPS=1 E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-lod-fps
import { writeFileSync } from 'node:fs'
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test'
import { logProfile, startProfile, stopProfile, summarizeProfile } from '../perf/fps.ts'
import { HEAVY, type HeavySpec, seedHeavyExcalidrawBoard } from '../perf/seed.ts'
import { DPR, GPU_ARGS, gpuInfo, measureView, pan, VIEWPORT } from '../spike/fixtures/perf-kit.ts'
import { signInContext } from '../tests/support/api.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'

test.skip(process.env.LOBBY_MEASURE_FPS !== '1', 'a measurement: LOBBY_MEASURE_FPS=1')
test.setTimeout(60 * 60_000)
// no Playwright trace or screenshots while measuring (a trace's screencast adds main-thread work)
test.use({ trace: 'off', screenshot: 'off' })

type View = 'fit' | '0.25' | '1'
/** LOBBY_FPS_VIEWS=fit,1 picks the views (default all three). */
const VIEWS: readonly View[] = (process.env.LOBBY_FPS_VIEWS?.split(',') as View[] | undefined) ?? [
  'fit',
  '0.25',
  '1',
]

/** LOBBY_FPS_SPEC=frames,notes,images (a smaller board for a quick look); default the heavy board. */
function spec(): HeavySpec {
  const raw = process.env.LOBBY_FPS_SPEC
  if (!raw) return HEAVY
  const [frames, notes, images] = raw.split(',').map(Number)
  return { frames: frames ?? 2, notes: notes ?? 100, images: images ?? 0, comments: 0 }
}

/** perf-kit's pan hooks on LobbyCanvas.viewport (window.__lobbyBoard, dev-auth builds). */
async function installCamera(page: Page) {
  await page.evaluate(() => {
    type V = { x: number; y: number; zoom: number }
    const c = (
      window as unknown as {
        __lobbyBoard: { canvas: { viewport: { get(): V; set(v: Partial<V>): void } } }
      }
    ).__lobbyBoard.canvas
    const w = window as unknown as Record<string, unknown>
    let o = c.viewport.get()
    w.__panStart = () => {
      o = c.viewport.get()
    }
    w.__panBy = (dx: number, dy: number) => c.viewport.set({ x: o.x - dx / o.zoom, y: o.y - dy / o.zoom })
    w.__panEnd = () => c.viewport.set({ x: o.x, y: o.y })
  })
}

/** Lobby's whole-board fit (the navigation part's zoomTo, below Excalidraw's 0.1), or 0.25 / 1 on frame 0. */
async function setView(page: Page, view: View, frame0: string) {
  return page.evaluate(
    async ({ view, frame0 }) => {
      type B = { x: number; y: number; width: number; height: number }
      type V = B & { zoom: number }
      type El = B & { id: string; type: string; containerId?: string | null; isDeleted?: boolean }
      const c = (
        window as unknown as {
          __lobbyBoard: {
            canvas: {
              items(): El[]
              bounds(id: string): B | null
              selection: string[]
              select(ids: string[]): void
              viewport: {
                get(): V
                set(v: Partial<V>): void
                zoomTo(b: B, o?: { maxZoom?: number; zoom?: number }): void
              }
            }
          }
        }
      ).__lobbyBoard.canvas
      c.select([])
      const all = c.items().filter((e) => !e.isDeleted && !(e.type === 'text' && e.containerId))
      if (view === 'fit') {
        let x1 = Number.POSITIVE_INFINITY
        let y1 = Number.POSITIVE_INFINITY
        let x2 = Number.NEGATIVE_INFINITY
        let y2 = Number.NEGATIVE_INFINITY
        for (const e of all) {
          x1 = Math.min(x1, e.x)
          y1 = Math.min(y1, e.y)
          x2 = Math.max(x2, e.x + e.width)
          y2 = Math.max(y2, e.y + e.height)
        }
        c.viewport.zoomTo({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, { maxZoom: 1 })
      } else {
        const f = c.bounds(frame0)
        if (!f) throw new Error('no frame 0')
        const vp = c.viewport.get()
        const sw = vp.width * vp.zoom
        const sh = vp.height * vp.zoom
        if (view === '0.25') {
          const z = 0.25
          c.viewport.set({
            zoom: z,
            x: f.x + f.width / 2 - sw / z / 2,
            y: f.y + f.height / 2 - sh / z / 2,
          })
        } else c.viewport.set({ zoom: 1, x: f.x - 20, y: f.y - 20 })
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const v = c.viewport.get()
      const visible = all.filter(
        (e) => e.x + e.width >= v.x && e.x <= v.x + v.width && e.y + e.height >= v.y && e.y <= v.y + v.height,
      ).length
      return { zoom: v.zoom, visible, total: all.length }
    },
    { view, frame0 },
  )
}

/** Switches the page into a mode; returns false when the page cannot (the pass is not on it). */
async function enterMode(page: Page, mode: string): Promise<boolean> {
  return page.evaluate((mode) => {
    const w = window as unknown as {
      __lobbyLod?: { setEnabled(on: boolean): void }
      __lobbyBoard: {
        api: { setElementRenderOverrides(o: Map<string, unknown> | null): void }
        canvas: { items(): { id: string; type: string; frameId?: string | null }[] }
      }
    }
    const lod = w.__lobbyLod
    const probed = w as unknown as { __lodProbe?: boolean }
    // probes (no feature code): what the engine's render costs when every frame child is left out of it
    // (a render offset far off screen: the engine culls it) or drawn at opacity 0, straight on the engine's
    // override snapshot (empty on this idle board); the bitmap a level-of-detail pass would draw is not drawn
    if (mode === 'probe-cull' || mode === 'probe-opacity') {
      lod?.setEnabled(false)
      const children = w.__lobbyBoard.canvas.items().filter((e) => e.frameId && e.type !== 'frame')
      const value = mode === 'probe-cull' ? { offset: { x: 1e7, y: 1e7 } } : { opacity: 0 }
      w.__lobbyBoard.api.setElementRenderOverrides(new Map(children.map((e) => [e.id, value])))
      probed.__lodProbe = true
      return true
    }
    if (probed.__lodProbe) {
      w.__lobbyBoard.api.setElementRenderOverrides(null)
      probed.__lodProbe = false
    }
    if (mode === 'default') return true
    if (mode === 'lod-off' || mode === 'lod-on') {
      if (!lod) return false
      lod.setEnabled(mode === 'lod-on')
      return true
    }
    throw new Error(`unknown mode ${mode}`)
  }, mode)
}

const lodState = (page: Page) =>
  page.evaluate(() => {
    const lod = (window as unknown as { __lobbyLod?: { state(): unknown } }).__lobbyLod
    return lod ? lod.state() : null
  })

test('heavy board: pan fps at Lobby’s fit, 0.25 and 1, per mode (the §8.5 level-of-detail gate)', async ({
  canvasSession,
  users,
  board,
}) => {
  const testInfo = test.info()
  const log = (s: string) => console.log(`[lod-fps] ${s}`)
  // 1. seed through the real protocol in a regular session, then close it (one page measures)
  const a = await canvasSession('alice')
  const lines: string[] = []
  const seeded = await seedHeavyExcalidrawBoard(a.page, board, spec(), (s) => lines.push(s))
  log(`seed: ${lines.join(' | ')}`)
  const frame0 = await a.page.evaluate((note) => {
    const f = (window as unknown as { lobbyCanvas: { get(id: string): { frameId?: string | null } | null } })
      .lobbyCanvas
    return f.get(note)?.frameId ?? null
  }, seeded.frame0Notes[0] as string)
  if (!frame0) throw new Error('frame 0 not found')
  await a.context.close()

  // 2. the measuring browser: the GPU shell at the review's size
  const browser: Browser = await chromium.launch({ headless: true, args: GPU_ARGS })
  try {
    const context = await browser.newContext({ baseURL: WEB_URL, viewport: VIEWPORT, deviceScaleFactor: DPR })
    const who = await users.get('alice')
    await signInContext(context, who.handle, who.name)
    const page = await context.newPage()
    const t0 = Date.now()
    await page.goto(`/b/${board}`)
    await waitForCanvas(page, 180_000)
    await page.waitForFunction(
      (n) => {
        const f = (
          window as unknown as { lobbyCanvas?: { items(): unknown[]; saveState(): { state: string } } }
        ).lobbyCanvas
        return !!f && f.items().length >= n && f.saveState().state === 'saved'
      },
      seeded.elements,
      { timeout: 180_000, polling: 250 },
    )
    log(`opened ${seeded.elements} elements in ${Date.now() - t0} ms`)
    const gpu = await gpuInfo(browser, page)
    log(`gpu: ${JSON.stringify(gpu)}`)
    const cdp: CDPSession = await context.newCDPSession(page)
    await installCamera(page)
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await page.waitForTimeout(3_000)

    const hasLod = await page.evaluate(() => !!(window as unknown as { __lobbyLod?: unknown }).__lobbyLod)
    const modes = (process.env.LOBBY_FPS_MODES ?? (hasLod ? 'lod-off,lod-on' : 'default'))
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    const rows: Record<string, unknown>[] = []
    for (const view of VIEWS) {
      for (const mode of modes) {
        if (!(await enterMode(page, mode))) {
          log(`${mode}: not on this page, skipped`)
          continue
        }
        const cam = await setView(page, view, frame0)
        await page.waitForTimeout(2_500)
        // the pass renders its bitmaps once it is on: measure the steady state (the time it took is logged)
        if (mode === 'lod-on') {
          const t = Date.now()
          await page.waitForFunction(
            () => {
              type S = { active: boolean; stale: number; rendering: number }
              const s = (window as unknown as { __lobbyLod?: { state(): S } }).__lobbyLod?.state()
              return !s?.active || (s.stale === 0 && s.rendering === 0)
            },
            undefined,
            { timeout: 120_000, polling: 100 },
          )
          log(`${mode} ${view}: bitmaps ready ${Date.now() - t} ms after the 2.5 s settle`)
          await page.waitForTimeout(500)
        }
        const r = await measureView(page, cdp, view, cam.zoom)
        const state = await lodState(page)
        rows.push({ mode, ...r, visible: cam.visible, total: cam.total, lod: state })
        log(
          `${mode} ${view} (zoom ${cam.zoom.toFixed(4)}, ${cam.visible}/${cam.total} in view): ${r.reps
            .map((x) => x.fps)
            .join(
              ' / ',
            )} fps (median ${r.medianFps}; traced ${r.trace?.traceFps} fps drawn, main ${r.trace?.mainBusyPct}% busy; machine ${r.machineBusyPct}% busy)${state ? ` lod ${JSON.stringify(state)}` : ''}`,
        )
        if (process.env.LOBBY_FPS_PROFILE === '1') {
          await startProfile(cdp)
          const times = await pan(page, 3000, 600)
          const profile = await stopProfile(cdp, testInfo.outputPath(`${mode}-${view}.cpuprofile`))
          const s = summarizeProfile(profile, times.length)
          logProfile(log, `${mode} ${view}`, s, 20)
          await page.waitForTimeout(400)
        }
      }
    }
    const result = {
      gpu,
      viewport: `${VIEWPORT.width}x${VIEWPORT.height} @${DPR}`,
      board: { spec: seeded.spec, elements: seeded.elements, items: seeded.items },
      rows,
    }
    writeFileSync(testInfo.outputPath('lod-fps.json'), JSON.stringify(result, null, 2))
    testInfo.annotations.push({ type: 'lod-fps', description: JSON.stringify(result) })
    expect(rows.length).toBeGreaterThan(0)
    await context.close()
  } finally {
    await browser.close()
  }
})
