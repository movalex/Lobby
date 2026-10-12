// A measurement, not part of the regular run (LOBBY_MEASURE_FPS=1): pan fps of a big board on the Excalidraw board
// page at Lobby's whole-board fit, at 0.25 and at 0.5 (and 1 on request), with sync running (the page's own socket is
// live), for the level-of-detail pass of docs/EXCALIDRAW-MIGRATION.md §8.5 (wave 3b: ≥ 24 fps at Lobby's fit).
//
// Wave N (WS1, N1-5): the board is the 10k fixture (e2e/excalidraw/support/big-board.ts: 20 frames of notes, 400 bound
// arrows, 50 images, 730 loose shapes; LOBBY_FPS_BOARD=heavy: the perf seed's heavy board, e2e/perf/seed.ts HEAVY), the
// views default to fit, 0.25 and 0.5, and each view is measured at CPU 1x and 4x (LOBBY_FPS_CPU=1,4; 4x is the laptop
// stand-in, the real laptop number stays an owner device check: PERF-laptop). With N1_PERF=1 the N1-5 targets are
// asserted on the size-aware pass (the `size-on` mode, and `default` when the page ships with it): a median of at least
// 55 fps at each view at 1x, and at least 30 at 4x. SIZE_AWARE_LOD ships off until that gate passes
// (apps/web/src/canvas/sync/flags.ts), so with N1_PERF=1 the modes default to `default,size-on`: the page as shipped
// (the pass before wave N) and the size-aware pass, in the same page and machine state.
//
// Same method as spike A14 and spike B's perf-fps (e2e/spike/fixtures/perf-kit.ts `measureView`): the
// headless shell with GPU flags, 1536×864 at DPR 1.25, the pointer at rest over the canvas, nothing
// selected, 3 scripted pans of 3 s per view (a 600 px sine, half of it vertically) plus one traced pan; the
// camera moves through LobbyCanvas.viewport.set (the board page's camera, as a person's pan would).
// The images are real: each carries its upload's customData.lobby.file (W5-34; before that fix no image of
// this board ever loaded, so every earlier number of this spec is of a board whose 200 images were never
// drawn). The open is timed to live and Saved, then to every image loaded; each view is measured once the
// images in it are loaded (the loader's state), and the run fails if any image fails to load.
//
// Each view is measured once per MODE, in the same page and the same machine state:
//   default   the page as it is (the pass as shipped: SIZE_AWARE_LOD)
//   lod-off   the level-of-detail pass switched off (window.__lobbyLod, dev-auth builds only)
//   lod-on    the level-of-detail pass switched on (its default)
//   size-on   N1-5's size-aware pass (zoom buckets, the memory cap, loose-element tiles)
//   size-off  the pass as before wave N (one bucket, frames only, below zoom 0.2)
// LOBBY_FPS_MODES=a,b picks the modes (default: default, or lod-off,lod-on when the pass is on the page);
// LOBBY_FPS_PROFILE=1 adds one V8 CPU-profiled pan per view and mode (the top functions are logged; the
// raw .cpuprofile goes to the test's output folder). LOBBY_FPS_TRACE=1 adds one Chrome-traced pan per view and mode
// (the main thread's self time per event, per frame, logged; the trace .json in the output folder).
//
//   LOBBY_MEASURE_FPS=1 E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-lod-fps
import { writeFileSync } from 'node:fs'
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test'
import { installPanHooks, logProfile, startProfile, stopProfile, summarizeProfile } from '../perf/fps.ts'
import { imagesInView, setView, waitImagesLoaded } from '../perf/lib.ts'
import { HEAVY, type HeavySpec, seedHeavyExcalidrawBoard } from '../perf/seed.ts'
import { DPR, GPU_ARGS, gpuInfo, measureView, pan, VIEWPORT } from '../spike/fixtures/perf-kit.ts'
import { signInContext } from '../tests/support/api.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { chromeTrace, mainThreadSelf, seedBigBoard } from './support/big-board.ts'

test.skip(process.env.LOBBY_MEASURE_FPS !== '1', 'a measurement: LOBBY_MEASURE_FPS=1')
test.setTimeout(60 * 60_000)
// no Playwright trace or screenshots while measuring (a trace's screencast adds main-thread work)
test.use({ trace: 'off', screenshot: 'off' })

type View = 'fit' | '0.25' | '0.5' | '1' | '1-images'
/**
 * LOBBY_FPS_VIEWS=fit,1 picks the views (default the N1-5 gate views: fit, 0.25, 0.5). `1-images`: zoom 1 on frame
 * 0's image column (the `1` view has no image in it), e2e/perf/lib.ts `100-images`.
 */
const VIEWS: readonly View[] = (process.env.LOBBY_FPS_VIEWS?.split(',') as View[] | undefined) ?? [
  'fit',
  '0.25',
  '0.5',
]
/** LOBBY_FPS_CPU=1,4 the CPU throttling rates each view is measured at */
const CPUS: readonly number[] = (process.env.LOBBY_FPS_CPU ?? '1,4').split(',').map(Number)
/** LOBBY_FPS_BOARD=heavy: the perf seed's heavy board; default the 10k fixture */
const BOARD = process.env.LOBBY_FPS_BOARD === 'heavy' ? 'heavy' : 'big10k'
/** N1-5's targets, asserted with N1_PERF=1: the median fps of each view at 1x and at 4x */
const TARGET_FPS: Readonly<Record<number, number>> = { 1: 55, 4: 30 }

/** frame `frameId` centred at `zoom` (the 0.25 view of e2e/perf/lib.ts setView, at any zoom). */
function centreAt(page: Page, frameId: string, zoom: number) {
  return page.evaluate(
    async ({ frameId, zoom }) => {
      type Box = { x: number; y: number; width: number; height: number }
      const c = (
        window as unknown as {
          __lobbyBoard: {
            canvas: {
              select(ids: string[]): void
              bounds(id: string): Box | null
              items(): (Box & { isDeleted?: boolean; type: string; containerId?: string | null })[]
              viewport: {
                get(): Box & { zoom: number }
                set(v: { zoom: number; x: number; y: number }): void
              }
            }
          }
        }
      ).__lobbyBoard.canvas
      c.select([])
      const f = c.bounds(frameId)
      if (!f) throw new Error(`no frame ${frameId}`)
      const vp = c.viewport.get()
      c.viewport.set({
        zoom,
        x: f.x + f.width / 2 - (vp.width * vp.zoom) / zoom / 2,
        y: f.y + f.height / 2 - (vp.height * vp.zoom) / zoom / 2,
      })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const v = c.viewport.get()
      const all = c.items().filter((e) => !e.isDeleted && !(e.type === 'text' && e.containerId))
      const visible = all.filter(
        (e) => e.x + e.width >= v.x && e.x <= v.x + v.width && e.y + e.height >= v.y && e.y <= v.y + v.height,
      ).length
      return { zoom: v.zoom, visible, total: all.length }
    },
    { frameId, zoom },
  )
}

/** LOBBY_FPS_SPEC=frames,notes,images (a smaller board for a quick look); default the heavy board. */
function spec(): HeavySpec {
  const raw = process.env.LOBBY_FPS_SPEC
  if (!raw) return HEAVY
  const [frames, notes, images] = raw.split(',').map(Number)
  return { frames: frames ?? 2, notes: notes ?? 100, images: images ?? 0, comments: 0 }
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
    // N1-5: the pass as before wave N (one bucket, no tiles, below 0.2 only), for the comparison
    const sized = (
      w as unknown as {
        __lobbyLod?: { setSizeAware?(on: boolean): void; state(): { sizeAware?: boolean } }
      }
    ).__lobbyLod
    // the page's own setting, read once (the other modes go back to it)
    const shipped = w as unknown as { __lodShippedSizeAware?: boolean }
    if (shipped.__lodShippedSizeAware === undefined)
      shipped.__lodShippedSizeAware = sized?.state().sizeAware ?? false
    if (mode === 'size-off' || mode === 'size-on') {
      if (!sized?.setSizeAware) return false
      lod?.setEnabled(true)
      sized.setSizeAware(mode === 'size-on')
      return true
    }
    sized?.setSizeAware?.(shipped.__lodShippedSizeAware)
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

test('big board: pan fps at Lobby’s fit, 0.25 and 0.5, per mode and CPU rate (the §8.5 and N1-5 level-of-detail gate)', async ({
  canvasSession,
  users,
  board,
}) => {
  const testInfo = test.info()
  const log = (s: string) => console.log(`[lod-fps] ${s}`)
  // 1. seed through the real protocol in a regular session, then close it (one page measures)
  const a = await canvasSession('alice')
  const lines: string[] = []
  let seeded: {
    spec: unknown
    elements: number
    items: number
    images: { length: number }
    frame0Notes: string[]
  }
  if (BOARD === 'heavy') seeded = await seedHeavyExcalidrawBoard(a.page, board, spec(), (s) => lines.push(s))
  else {
    const big = await seedBigBoard(a.page, board)
    lines.push(`10k fixture: images ${big.ms.images} ms, elements ${big.ms.elements} ms`)
    seeded = {
      spec: 'the 10k fixture (e2e/excalidraw/support/big-board.ts)',
      elements: big.elements,
      items: big.elements - big.board.noteIds.length,
      images: { length: big.board.elements.filter((e) => e.type === 'image').length },
      frame0Notes: big.board.noteIds.slice(0, 1),
    }
  }
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
    const openMs = Date.now() - t0
    const imgs = await waitImagesLoaded(page, 180_000)
    const open = { ms: openMs, imagesMs: openMs + imgs.ms, images: imgs.total, imagesLoaded: imgs.loaded }
    log(
      `opened ${seeded.elements} elements in ${openMs} ms (live and Saved); ${imgs.loaded}/${imgs.total} images loaded at ${open.imagesMs} ms (${imgs.failed} failed)`,
    )
    expect(imgs.failed, 'images that failed to load').toBe(0)
    expect(imgs.loaded, 'images loaded within 3 min of the open').toBe(seeded.images.length)
    const gpu = await gpuInfo(browser, page)
    log(`gpu: ${JSON.stringify(gpu)}`)
    const cdp: CDPSession = await context.newCDPSession(page)
    await installPanHooks(page)
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await page.waitForTimeout(3_000)

    const hasLod = await page.evaluate(() => !!(window as unknown as { __lobbyLod?: unknown }).__lobbyLod)
    const modes = (
      process.env.LOBBY_FPS_MODES ??
      (hasLod && BOARD === 'heavy'
        ? 'lod-off,lod-on'
        : process.env.N1_PERF === '1'
          ? 'default,size-on'
          : 'default')
    )
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    const rows: Record<string, unknown>[] = []
    for (const cpu of CPUS)
      for (const view of VIEWS) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
        for (const mode of modes) {
          if (!(await enterMode(page, mode))) {
            log(`${mode}: not on this page, skipped`)
            continue
          }
          const cam =
            view === '0.5'
              ? await centreAt(page, frame0, 0.5)
              : await setView(page, view === '1' ? '100' : view === '1-images' ? '100-images' : view, frame0)
          await page.waitForTimeout(2_500)
          const inView = await imagesInView(page)
          const shown = await waitImagesLoaded(page, 60_000, inView)
          // the pass renders its bitmaps once it is on: measure the steady state (the time it took is logged)
          if (mode === 'lod-on' || mode === 'default' || mode === 'size-on' || mode === 'size-off') {
            const t = Date.now()
            await page.waitForFunction(
              () => {
                type S = { active: boolean; stale: number; rendering: number; pendingInView?: number }
                const s = (window as unknown as { __lobbyLod?: { state(): S } }).__lobbyLod?.state()
                // N1-5: under the memory cap the regions out of view may stay stale: the view's are what is drawn
                if (s && s.pendingInView !== undefined) return !s.active || s.pendingInView === 0
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
          rows.push({
            cpu,
            mode,
            ...r,
            visible: cam.visible,
            total: cam.total,
            imagesInView: shown.total,
            imagesLoaded: shown.loaded,
            lod: state,
          })
          log(
            `cpu ${cpu}x ${mode} ${view} (zoom ${cam.zoom.toFixed(4)}, ${cam.visible}/${cam.total} in view, ${shown.loaded}/${shown.total} images in view loaded): ${r.reps
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
          // LOBBY_FPS_TRACE=1 (wave N.1): one more pan under a full Chrome trace (written to the output folder, DevTools
          // opens it), with the renderer main thread's self time per event per frame and the page's DOM and canvases
          if (process.env.LOBBY_FPS_TRACE === '1') {
            const dom = await page.evaluate(() => ({
              nodes: document.querySelectorAll('*').length,
              canvases: [...document.querySelectorAll('canvas')]
                .map((c) => `${c.width}x${c.height}`)
                .join(' '),
            }))
            let times: number[] = []
            const events = await chromeTrace(
              cdp,
              testInfo.outputPath(`cpu${cpu}-${mode}-${view}.trace.json`),
              async () => {
                times = await pan(page, 3000, 600)
              },
            )
            const frames = Math.max(1, times.length - 1)
            log(
              `  ${mode} ${view} traced pan: ${dom.nodes} DOM nodes, canvases ${dom.canvases}; main thread per frame:`,
            )
            for (const [name, us] of [...mainThreadSelf(events).entries()]
              .sort((x, y) => y[1] - x[1])
              .slice(0, 20))
              log(`    ${(us / 1000 / frames).toFixed(2).padStart(8)} ms  ${name}`)
            await page.waitForTimeout(400)
          }
        }
      }
    const result = {
      gpu,
      viewport: `${VIEWPORT.width}x${VIEWPORT.height} @${DPR}`,
      headless: true,
      open,
      board: { spec: seeded.spec, elements: seeded.elements, items: seeded.items },
      rows,
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    writeFileSync(testInfo.outputPath('lod-fps.json'), JSON.stringify(result, null, 2))
    testInfo.annotations.push({ type: 'lod-fps', description: JSON.stringify(result) })
    expect(rows.length).toBeGreaterThan(0)
    // N1-5's targets on the size-aware pass (N1_PERF=1): the size-on rows, and the page's own when it ships with it
    if (process.env.N1_PERF === '1')
      for (const row of rows) {
        const r = row as {
          cpu: number
          mode: string
          view: string
          medianFps: number
          lod: { sizeAware?: boolean } | null
        }
        if (r.mode !== 'default' && r.mode !== 'lod-on' && r.mode !== 'size-on') continue
        if (!r.lod?.sizeAware) continue
        const target = TARGET_FPS[r.cpu]
        if (target !== undefined)
          expect(r.medianFps, `${r.view} at CPU ${r.cpu}x (${r.mode})`).toBeGreaterThanOrEqual(target)
      }
    await context.close()
  } finally {
    await browser.close()
  }
})
