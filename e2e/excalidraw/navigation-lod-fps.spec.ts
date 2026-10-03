// A measurement, not part of the regular run (LOBBY_MEASURE_FPS=1): pan fps of the heavy board (the perf
// seed's 20 frames, 4,500 notes, 200 images: e2e/perf/seed.ts HEAVY) on the Excalidraw board page at
// Lobby's whole-board fit, at 0.25 and at 1, with sync running (the page's own socket is live), for the
// level-of-detail pass of docs/EXCALIDRAW-MIGRATION.md §8.5 (wave 3b: ≥ 24 fps at Lobby's fit).
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
import { installPanHooks, logProfile, startProfile, stopProfile, summarizeProfile } from '../perf/fps.ts'
import { imagesInView, setView, waitImagesLoaded } from '../perf/lib.ts'
import { HEAVY, type HeavySpec, seedHeavyExcalidrawBoard } from '../perf/seed.ts'
import { DPR, GPU_ARGS, gpuInfo, measureView, pan, VIEWPORT } from '../spike/fixtures/perf-kit.ts'
import { signInContext } from '../tests/support/api.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'

test.skip(process.env.LOBBY_MEASURE_FPS !== '1', 'a measurement: LOBBY_MEASURE_FPS=1')
test.setTimeout(60 * 60_000)
// no Playwright trace or screenshots while measuring (a trace's screencast adds main-thread work)
test.use({ trace: 'off', screenshot: 'off' })

type View = 'fit' | '0.25' | '1' | '1-images'
/**
 * LOBBY_FPS_VIEWS=fit,1 picks the views (default the three gate views). `1-images`: zoom 1 on frame 0's
 * image column (the `1` view has no image in it), e2e/perf/lib.ts `100-images`.
 */
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
        const cam = await setView(
          page,
          view === '1' ? '100' : view === '1-images' ? '100-images' : view,
          frame0,
        )
        await page.waitForTimeout(2_500)
        const inView = await imagesInView(page)
        const shown = await waitImagesLoaded(page, 60_000, inView)
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
        rows.push({
          mode,
          ...r,
          visible: cam.visible,
          total: cam.total,
          imagesInView: shown.total,
          imagesLoaded: shown.loaded,
          lod: state,
        })
        log(
          `${mode} ${view} (zoom ${cam.zoom.toFixed(4)}, ${cam.visible}/${cam.total} in view, ${shown.loaded}/${shown.total} images in view loaded): ${r.reps
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
      headless: true,
      open,
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
