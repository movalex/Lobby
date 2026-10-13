// Wave O (WO-PAN, O-2): the pan blit on Lobby's 10k board (the engine patch's `setPanBlit`, sync/flags.ts PAN_BLIT).
// A pan keeps the static canvas's last frame shifted by the move and draws only its edges and the ink of the elements
// that came into or left view. These check that it draws what a full render draws, on the GPU shell the fps spec
// measures (1536x864 at 1.25, e2e/spike/fixtures/perf-kit.ts):
//  1. at Lobby's fit (the level-of-detail pass on), 0.25, 0.5 and 1: a pan of 40 frames of fractional steps, its last
//     frame (a blit) against the render at rest (the blit's own full render, 120 ms later) and against a full render of
//     the same camera with the blit off; a control first (two full renders whole device pixels apart, their overlap
//     compared: the GPU raster's own translation floor);
//  2. with the board's grid on (Lobby's grid setting: Excalidraw's grid mode), at 0.5, 1 and 2: the same pan, its last
//     frame against a full render (the grid's dashed lines start their pattern at the scroll modulo the grid size, so
//     a shifted frame's dashes and a later band's would disagree), within a control taken with the grid off;
//  3. stale pixels, each in the middle of a pan at 0.5: images that finish loading (their bytes held until the pan
//     runs), a remote change (bob moves a note in view), a selection change (of a note with a link: its link icon
//     goes), a theme switch, and bob's laser and cursor over the view (Lobby's overlays, never the static canvas). Each
//     must end the blit at once (a full render) and the pan's last frame must equal a full render.
// The canvas is read through a copy (drawImage into the page's own canvas): Chrome moves a canvas that is read back
// often to its CPU rasterizer, whose anti-aliasing differs (the wave O scout's finding).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test excalidraw/o2-pan-blit.spec.ts --project=chromium
import { writeFileSync } from 'node:fs'
import { type Browser, chromium, type Page, type Route } from '@playwright/test'
import { imagesInView, setView, waitImagesLoaded } from '../perf/lib.ts'
import { DPR, GPU_ARGS, VIEWPORT } from '../spike/fixtures/perf-kit.ts'
import { signInContext } from '../tests/support/api.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { closeAccountMenu, pickTheme } from '../tests/support/theme.ts'
import { laserStroke } from './l6-kit.ts'
import { seedBigBoard } from './support/big-board.ts'

test.setTimeout(20 * 60_000)
test.use({ trace: 'off', screenshot: 'off' })

interface Stats {
  on: boolean
  full: number
  blit: number
  rest: number
  lost: number
  elements: number
  area: number
  last: string
}
interface Diff {
  pixels: number
  max: number
  bbox: [number, number, number, number] | null
}

type PanWindow = {
  __lobbyPanBlit: { set(on: boolean): void; stats(): Stats; reset(): void }
  __lobbyBoard: {
    canvas: {
      viewport: {
        get(): { x: number; y: number; zoom: number; width: number; height: number }
        set(v: Partial<{ x: number; y: number; zoom: number }>): void
      }
      bounds(id: string): { x: number; y: number; width: number; height: number } | null
      select(ids: string[]): void
      settings: { set(patch: { grid?: boolean }): void; get(): { grid: boolean } }
    }
  }
  lobbyCanvas: {
    get(id: string): { x: number; link?: string | null; frameId?: string | null } | null
    update(id: string, patch: Record<string, unknown>): void
    setTool(tool: string): boolean
    tool(): string | null
    items(): unknown[]
    saveState(): { state: string }
  }
  __pan: {
    run(steps: number): Promise<{ steps: number; stats: Stats }>
    stopIn(n: number): void
    grab(slot: string): void
    diff(a: string, b: string): Diff
    overlap(a: string, b: string, dx: number, dy: number): Diff
    snapped(): { x: number; y: number }
    dump(a: string, b: string, bbox: [number, number, number, number]): string
    zoom(a: string, b: string): { png: string; x: number; y: number } | null
  }
} & Record<string, unknown>

/** The in-page tools: a pan loop (one camera step per animation frame), the canvas read through a copy, diffs. */
function installPanTools(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as PanWindow
    const store = w as unknown as Record<string, Uint8ClampedArray>
    const canvas = () => document.querySelector('canvas.excalidraw__canvas.static') as HTMLCanvasElement
    let stopIn = -1
    const compare = (
      a: Uint8ClampedArray,
      b: Uint8ClampedArray,
      W: number,
      H: number,
      dx: number,
      dy: number,
    ) => {
      let pixels = 0
      let max = 0
      let bbox: [number, number, number, number] | null = null
      for (let y = Math.max(0, -dy); y < Math.min(H, H - dy); y++)
        for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x++) {
          const i = (y * W + x) * 4
          const j = ((y + dy) * W + (x + dx)) * 4
          let m = 0
          for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs((a[i + k] as number) - (b[j + k] as number)))
          if (!m) continue
          pixels++
          if (m > max) max = m
          bbox = bbox
            ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)]
            : [x, y, x, y]
        }
      return { pixels, max, bbox }
    }
    w.__pan = {
      run: (steps) =>
        new Promise((resolve) => {
          const vp = w.__lobbyBoard.canvas.viewport
          let i = 0
          stopIn = -1
          const step = () => {
            if (i >= steps || stopIn === 0) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  w.__pan.grab('__panEnd')
                  resolve({ steps: i, stats: w.__lobbyPanBlit.stats() })
                }),
              )
              return
            }
            if (stopIn > 0) stopIn--
            const o = vp.get()
            const dx = 23.3 * Math.sin(i / 4) + 3.7
            const dy = -11.9 * Math.cos(i / 5) + 1.3
            i++
            vp.set({ x: o.x - dx / o.zoom, y: o.y - dy / o.zoom })
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        }),
      stopIn: (n) => {
        stopIn = n
      },
      grab: (slot) => {
        const c = canvas()
        const copy = document.createElement('canvas')
        copy.width = c.width
        copy.height = c.height
        const cx = copy.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
        cx.drawImage(c, 0, 0)
        store[slot] = cx.getImageData(0, 0, c.width, c.height).data
      },
      diff: (a, b) => {
        const c = canvas()
        return compare(store[a] as Uint8ClampedArray, store[b] as Uint8ClampedArray, c.width, c.height, 0, 0)
      },
      overlap: (a, b, dx, dy) => {
        const c = canvas()
        const A = store[a] as Uint8ClampedArray
        const B = store[b] as Uint8ClampedArray
        return compare(A, B, c.width, c.height, dx, dy)
      },
      dump: (a, b, bbox) => {
        const c = canvas()
        const W = c.width
        const H = c.height
        const x0 = Math.max(0, bbox[0] - 40)
        const y0 = Math.max(0, bbox[1] - 40)
        const x1 = Math.min(W - 1, bbox[2] + 40)
        const y1 = Math.min(H - 1, bbox[3] + 40)
        const cw = x1 - x0 + 1
        const ch = y1 - y0 + 1
        const out = document.createElement('canvas')
        out.width = cw
        out.height = ch * 3
        const ctx = out.getContext('2d') as CanvasRenderingContext2D
        const A = store[a] as Uint8ClampedArray
        const B = store[b] as Uint8ClampedArray
        const parts = [ctx.createImageData(cw, ch), ctx.createImageData(cw, ch), ctx.createImageData(cw, ch)]
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++) {
            const si = ((y + y0) * W + (x + x0)) * 4
            const di = (y * cw + x) * 4
            let m = 0
            for (let k = 0; k < 4; k++) {
              ;(parts[0] as ImageData).data[di + k] = A[si + k] as number
              ;(parts[1] as ImageData).data[di + k] = B[si + k] as number
              m = Math.max(m, Math.abs((A[si + k] as number) - (B[si + k] as number)))
            }
            const d = (parts[2] as ImageData).data
            d[di] = m ? 255 : 0
            d[di + 1] = 0
            d[di + 2] = 0
            d[di + 3] = 255
          }
        parts.forEach((img, k) => {
          ctx.putImageData(img, 0, ch * k)
        })
        return out.toDataURL('image/png').split(',')[1] as string
      },
      zoom: (a, b) => {
        const c = canvas()
        const W = c.width
        const A = store[a] as Uint8ClampedArray
        const B = store[b] as Uint8ClampedArray
        let at = -1
        for (let i = 0; i < A.length; i += 4) {
          let m = 0
          for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs((A[i + k] as number) - (B[i + k] as number)))
          if (m > 8) {
            at = i / 4
            break
          }
        }
        if (at < 0) return null
        const px = at % W
        const py = Math.floor(at / W)
        const S = 48
        const Z = 8
        const x0 = Math.max(0, px - S / 2)
        const y0 = Math.max(0, py - S / 2)
        const out = document.createElement('canvas')
        out.width = S * Z * 3
        out.height = S * Z
        const ctx = out.getContext('2d') as CanvasRenderingContext2D
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            const i = ((y0 + y) * W + (x0 + x)) * 4
            const col = (d: Uint8ClampedArray) =>
              `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${(d[i + 3] as number) / 255})`
            ctx.fillStyle = col(A)
            ctx.fillRect(x * Z, y * Z, Z, Z)
            ctx.fillStyle = col(B)
            ctx.fillRect(S * Z + x * Z, y * Z, Z, Z)
            let m = 0
            for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs((A[i + k] as number) - (B[i + k] as number)))
            ctx.fillStyle = `rgb(${Math.min(255, m * 4)},0,0)`
            ctx.fillRect(2 * S * Z + x * Z, y * Z, Z, Z)
          }
        return { png: out.toDataURL('image/png').split(',')[1] as string, x: px, y: py }
      },
      snapped: () => {
        const v = w.__lobbyBoard.canvas.viewport.get()
        const k = v.zoom * window.devicePixelRatio
        return { x: Math.round(-v.x * k), y: Math.round(-v.y * k) }
      },
    }
  })
}

const frames = (page: Page, n = 3) =>
  page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        let i = 0
        const step = () => (++i >= n ? r() : requestAnimationFrame(step))
        requestAnimationFrame(step)
      }),
    n,
  )

/** The camera rendered in full: the blit off, nudged away and back, read into `slot`; the blit back on. */
async function fullRender(page: Page, slot: string) {
  await page.evaluate(async (slot) => {
    const w = window as unknown as PanWindow
    const vp = w.__lobbyBoard.canvas.viewport
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    w.__lobbyPanBlit.set(false)
    const o = vp.get()
    vp.set({ x: o.x + 5 / o.zoom, y: o.y + 3 / o.zoom })
    await raf()
    await raf()
    vp.set({ x: o.x, y: o.y })
    await raf()
    await raf()
    await raf()
    w.__pan.grab(slot)
    w.__lobbyPanBlit.set(true)
  }, slot)
}

/**
 * The control here: full renders whole device pixels apart (two small moves), each overlap with the first compared,
 * the most pixels and the most levels: the GPU raster's own floor (an off-grid draw, an anti-aliased path, lands a few
 * pixels a few levels apart at another scroll). The camera is put back.
 */
async function controlHere(page: Page, dumpAs?: string): Promise<Diff> {
  const start = await page.evaluate(() => (window as unknown as PanWindow).__lobbyBoard.canvas.viewport.get())
  await fullRender(page, '__c0')
  const s0 = await page.evaluate(() => (window as unknown as PanWindow).__pan.snapped())
  const floor: Diff = { pixels: 0, max: 0, bbox: null }
  for (const [dx, dy] of [
    [8, 4],
    [3, 11],
  ] as const) {
    await page.evaluate(
      ({ start, dx, dy }) =>
        (window as unknown as PanWindow).__lobbyBoard.canvas.viewport.set({
          x: start.x - dx / start.zoom,
          y: start.y - dy / start.zoom,
        }),
      { start, dx, dy },
    )
    await fullRender(page, '__c1')
    const s1 = await page.evaluate(() => (window as unknown as PanWindow).__pan.snapped())
    const d = await page.evaluate(
      ({ dx, dy }) => (window as unknown as PanWindow).__pan.overlap('__c0', '__c1', dx, dy),
      { dx: s1.x - s0.x, dy: s1.y - s0.y },
    )
    floor.pixels = Math.max(floor.pixels, d.pixels)
    floor.max = Math.max(floor.max, d.max)
    if (dumpAs && d.max > 16) {
      // the overlap shifted into place: c1 moved by (dx, dy) onto c0's pixels, then compared
      await page.evaluate(
        ({ dx, dy }) => {
          const w = window as unknown as Record<string, Uint8ClampedArray>
          const c = document.querySelector('canvas.excalidraw__canvas.static') as HTMLCanvasElement
          const W = c.width
          const H = c.height
          const src = w.__c1 as Uint8ClampedArray
          const out = new Uint8ClampedArray(src.length)
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const sx = x + dx
              const sy = y + dy
              if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
              const i = (y * W + x) * 4
              const j = (sy * W + sx) * 4
              for (let k = 0; k < 4; k++) out[i + k] = src[j + k] as number
            }
          w.__c1s = out
        },
        { dx: s1.x - s0.x, dy: s1.y - s0.y },
      )
      const dd = await page.evaluate(() => (window as unknown as PanWindow).__pan.diff('__c0', '__c1s'))
      if (dd.bbox) await dumpPng(page, '__c0', '__c1s', dd.bbox, `${dumpAs}-control-${dx}-${dy}`)
    }
  }
  await page.evaluate(
    (start) => (window as unknown as PanWindow).__lobbyBoard.canvas.viewport.set({ x: start.x, y: start.y }),
    start,
  )
  await frames(page)
  return floor
}

/**
 * Within the GPU raster's own floor: a path the engine draws itself (a frame's outline, its rounded corners) sits a
 * fraction of a pixel apart at another scroll (the canvas keeps its transform in single precision), so a few of its
 * anti-aliased edge pixels land some levels apart: two full renders whole device pixels apart differ by 2 px at 16
 * levels at fit (the control), a frame's corner by 6 px at 21 levels at 0.25. So: no pixel more than 32 levels (or the
 * control's most) apart, on about as many pixels as the control. Stale content is hundreds of pixels far apart.
 */
const withinFloor = (d: Diff, floor: Diff) =>
  d.max <= Math.max(32, floor.max) && d.pixels <= 2 * floor.pixels + 200

/** `a` against `b` (two canvases read into the page) */
const diffOf = (page: Page, a: string, b: string) =>
  page.evaluate(({ a, b }) => (window as unknown as PanWindow).__pan.diff(a, b), { a, b })

/** the board page's camera, and putting one on it */
const viewOf = (page: Page) =>
  page.evaluate(() => (window as unknown as PanWindow).__lobbyBoard.canvas.viewport.get())
const putView = (page: Page, v: { x: number; y: number; zoom: number }) =>
  page.evaluate((v) => (window as unknown as PanWindow).__lobbyBoard.canvas.viewport.set(v), v)

/** blit | full | where they differ, cropped around `bbox`, into the test's output folder */
async function dumpPng(
  page: Page,
  a: string,
  b: string,
  bbox: [number, number, number, number],
  name: string,
) {
  const png = await page.evaluate(
    ({ a, b, bbox }) => (window as unknown as PanWindow).__pan.dump(a, b, bbox),
    { a, b, bbox },
  )
  const base = name.replace(/[^a-z0-9.]+/gi, '-')
  writeFileSync(test.info().outputPath(`${base}.png`), Buffer.from(png, 'base64'))
  const z = await page.evaluate(({ a, b }) => (window as unknown as PanWindow).__pan.zoom(a, b), { a, b })
  if (z) writeFileSync(test.info().outputPath(`${base}-zoom-${z.x}-${z.y}.png`), Buffer.from(z.png, 'base64'))
}

/** Frame `frameId` centred at `zoom` (navigation-lod-fps.spec.ts `centreAt`). */
function centreAt(page: Page, frameId: string, zoom: number) {
  return page.evaluate(
    async ({ frameId, zoom }) => {
      const c = (window as unknown as PanWindow).__lobbyBoard.canvas
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
    },
    { frameId, zoom },
  )
}

async function waitLodReady(page: Page) {
  await page.waitForFunction(
    () => {
      type S = { active: boolean; stale: number; rendering: number; pendingInView?: number }
      const s = (window as unknown as { __lobbyLod?: { state(): S } }).__lobbyLod?.state()
      if (s && s.pendingInView !== undefined) return !s.active || s.pendingInView === 0
      return !s?.active || (s.stale === 0 && s.rendering === 0)
    },
    undefined,
    { timeout: 120_000, polling: 100 },
  )
}

/** A pan of `steps` frames with the blit on, its last frame read into `__panEnd`, and the stats. */
const pan = (page: Page, steps: number) =>
  page.evaluate((steps) => {
    const w = window as unknown as PanWindow
    w.__lobbyPanBlit.set(true)
    w.__lobbyPanBlit.reset()
    return w.__pan.run(steps)
  }, steps)

/** Opens the seeded board in the GPU shell as `who`; `hold` gets each image byte request until it is let go. */
async function openMeasured(
  browser: Browser,
  who: { handle: string; name: string },
  board: string,
  elements: number,
  hold?: Route[],
) {
  const context = await browser.newContext({ baseURL: WEB_URL, viewport: VIEWPORT, deviceScaleFactor: DPR })
  await signInContext(context, who.handle, who.name)
  if (hold) await context.route('**/files/**/d/**', (route) => void hold.push(route))
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForCanvas(page, 180_000)
  await page.waitForFunction(
    (n) => {
      const f = (window as unknown as Partial<PanWindow>).lobbyCanvas
      return !!f && f.items().length >= n && f.saveState().state === 'saved'
    },
    elements,
    { timeout: 180_000, polling: 250 },
  )
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await installPanTools(page)
  return { context, page }
}

const frameOf = (page: Page, note: string) =>
  page.evaluate((n) => (window as unknown as PanWindow).lobbyCanvas.get(n)?.frameId ?? null, note)

test('O-2 pan blit: its frames are a full render’s, at Lobby’s fit, 0.25, 0.5 and 1', async ({
  canvasSession,
  users,
  board,
}) => {
  const log = (s: string) => console.log(`[pan-blit] ${s}`)
  const a = await canvasSession('alice')
  const big = await seedBigBoard(a.page, board)
  const frame0 = await frameOf(a.page, big.board.noteIds[0] as string)
  await a.context.close()
  const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
  const results: Record<string, unknown> = {}
  try {
    const { context, page } = await openMeasured(browser, await users.get('alice'), board, big.elements)
    const imgs = await waitImagesLoaded(page, 180_000)
    expect(imgs.failed).toBe(0)
    for (const view of ['fit', '0.25', '0.5', '1'] as const) {
      if (view === '0.5') await centreAt(page, frame0 as string, 0.5)
      else await setView(page, view === '1' ? '100' : view, frame0 as string)
      await page.waitForTimeout(2_500)
      await waitImagesLoaded(page, 60_000, await imagesInView(page))
      await waitLodReady(page)
      await page.waitForTimeout(500)
      const control = await controlHere(page)
      log(`${view} control: ${JSON.stringify(control)}`)
      const reps: unknown[] = []
      for (let rep = 0; rep < 3; rep++) {
        const r = await pan(page, 40)
        expect(r.stats.last, `${view} rep ${rep}: the pan's last render`).toBe('blit')
        expect(r.stats.blit, `${view} rep ${rep}: blits`).toBeGreaterThanOrEqual(30)
        await page.waitForTimeout(300)
        const restStats = await page.evaluate(() => (window as unknown as PanWindow).__lobbyPanBlit.stats())
        expect(restStats.last, `${view} rep ${rep}: the render at rest`).toBe('rest')
        await page.evaluate(() => (window as unknown as PanWindow).__pan.grab('__rest'))
        await fullRender(page, '__full')
        const rest = await diffOf(page, '__panEnd', '__rest')
        const full = await diffOf(page, '__panEnd', '__full')
        const stats = r.stats
        log(
          `${view} rep ${rep}: ${stats.blit} blits, ${stats.full} full, ${Math.round(stats.elements / Math.max(1, stats.blit))} elements a blit; rest ${JSON.stringify(rest)}; full ${JSON.stringify(full)}`,
        )
        reps.push({ stats, rest, full })
        // the blit's frame is the full render's, within the GPU raster's own floor (withinFloor)
        for (const [what, d] of [
          ['rest', rest],
          ['full', full],
        ] as const) {
          if (d.pixels && d.bbox) {
            const ref = what === 'rest' ? '__rest' : '__full'
            await dumpPng(page, '__panEnd', ref, d.bbox, `${view}-${rep}-${what}`)
          }
          const msg = `${view} rep ${rep}: ${JSON.stringify(d)} apart from the ${what} render`
          expect(withinFloor(d, control), msg).toBe(true)
        }
      }
      results[view] = { control, reps }
    }
    writeFileSync(test.info().outputPath('pan-blit-pixels.json'), JSON.stringify(results, null, 1))
    await context.close()
  } finally {
    await browser.close()
  }
})

test('O-2 pan blit: with the board’s grid on, its frames are a full render’s, at 0.5, 1 and 2', async ({
  canvasSession,
  users,
  board,
}) => {
  const log = (s: string) => console.log(`[pan-blit] ${s}`)
  const a = await canvasSession('alice')
  const big = await seedBigBoard(a.page, board)
  const frame0 = await frameOf(a.page, big.board.noteIds[0] as string)
  await a.context.close()
  const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
  const results: Record<string, unknown> = {}
  try {
    const { context, page } = await openMeasured(browser, await users.get('alice'), board, big.elements)
    const imgs = await waitImagesLoaded(page, 180_000)
    expect(imgs.failed).toBe(0)
    const grid = async (on: boolean) => {
      const now = await page.evaluate((on) => {
        const { settings } = (window as unknown as PanWindow).__lobbyBoard.canvas
        settings.set({ grid: on })
        return settings.get().grid
      }, on)
      expect(now, 'the board’s grid setting').toBe(on)
      await frames(page)
    }
    for (const zoom of [0.5, 1, 2]) {
      await centreAt(page, frame0 as string, zoom)
      await page.waitForTimeout(1_500)
      await waitImagesLoaded(page, 60_000, await imagesInView(page))
      await waitLodReady(page)
      // the control with the grid off: two full renders at other scrolls draw the grid's dashes at another phase
      await grid(false)
      await page.waitForTimeout(300)
      const control = await controlHere(page)
      await grid(true)
      await page.waitForTimeout(300)
      log(`grid ${zoom} control: ${JSON.stringify(control)}`)
      const reps: unknown[] = []
      for (let rep = 0; rep < 2; rep++) {
        const r = await pan(page, 40)
        await page.waitForTimeout(300)
        await fullRender(page, '__full')
        const full = await diffOf(page, '__panEnd', '__full')
        const at = `grid ${zoom} rep ${rep}`
        log(`${at}: ${r.stats.blit} blits, ${r.stats.full} full; full ${JSON.stringify(full)}`)
        reps.push({ stats: r.stats, full })
        if (full.pixels && full.bbox) await dumpPng(page, '__panEnd', '__full', full.bbox, `grid-${at}`)
        expect.soft(withinFloor(full, control), `${at}: ${JSON.stringify(full)} apart`).toBe(true)
        // the blit stays off while the grid is drawn: every frame of the pan is a full render
        expect.soft(r.stats.blit, `${at}: blits`).toBe(0)
      }
      results[String(zoom)] = { control, reps }
    }
    await grid(false)
    writeFileSync(test.info().outputPath('pan-blit-grid.json'), JSON.stringify(results, null, 1))
    await context.close()
  } finally {
    await browser.close()
  }
})

test('O-2 pan blit: no stale pixel after images load, a remote change, a selection change, a theme switch, or under a laser', async ({
  canvasSession,
  users,
  board,
}) => {
  const log = (s: string) => console.log(`[pan-blit] ${s}`)
  const a = await canvasSession('alice')
  const big = await seedBigBoard(a.page, board)
  const note0 = big.board.noteIds[0] as string
  const frame0 = await frameOf(a.page, note0)
  await a.context.close()
  const bob = await canvasSession('bob')
  const browser = await chromium.launch({ headless: true, args: GPU_ARGS })
  const held: Route[] = []
  try {
    const { context, page } = await openMeasured(browser, await users.get('alice'), board, big.elements, held)
    await centreAt(page, frame0 as string, 0.5)
    await page.waitForTimeout(1_000)
    const inView = await imagesInView(page)
    expect(inView.length, 'images in the 0.5 view').toBeGreaterThan(0)
    expect(held.length, 'image bytes held').toBeGreaterThan(0)
    const cases: Record<string, unknown> = {}
    /**
     * A pan from frame 0's 0.5 view that runs while `during` changes something, then `after` more frames; its last frame
     * compared with a full render of the same camera, within the floor of a control taken in the state the change left.
     * `full`: the change must end the blit at once (a full render); Lobby's overlays need none.
     */
    const staleCase = async (
      name: string,
      during: () => Promise<void>,
      o: { after?: number; full?: boolean } = {},
    ) => {
      const { after = 25, full: needsFull = true } = o
      await centreAt(page, frame0 as string, 0.5)
      await frames(page)
      const run = pan(page, 600)
      await page.waitForTimeout(250)
      const mid = await page.evaluate(() => (window as unknown as PanWindow).__lobbyPanBlit.stats())
      await during()
      const changed = await page.evaluate(() => (window as unknown as PanWindow).__lobbyPanBlit.stats())
      await page.evaluate((n) => (window as unknown as PanWindow).__pan.stopIn(n), after)
      const r = await run
      await fullRender(page, '__full')
      const d = await diffOf(page, '__panEnd', '__full')
      const control = await controlHere(page, name)
      log(
        `${name}: before the change ${mid.blit} blits / ${mid.full} full; by its end ${changed.blit} / ${changed.full}; at the pan's end ${r.stats.blit} / ${r.stats.full} (${r.steps} steps, last ${r.stats.last}); vs full ${JSON.stringify(d)}; control ${JSON.stringify(control)}`,
      )
      cases[name] = { mid, changed, end: r.stats, diff: d, control }
      if (d.pixels && d.bbox) await dumpPng(page, '__panEnd', '__full', d.bbox, name)
      expect.soft(mid.blit, `${name}: blits before the change`).toBeGreaterThan(5)
      // the change gave a full render, then the pan went on blitting
      if (needsFull)
        expect.soft(changed.full, `${name}: a full render after the change`).toBeGreaterThan(mid.full)
      expect.soft(r.stats.blit - changed.blit, `${name}: blits after it`).toBeGreaterThan(10)
      expect.soft(r.stats.last, `${name}: the pan's last render`).toBe('blit')
      const msg = `${name}: ${JSON.stringify(d)} within the floor ${JSON.stringify(control)}`
      expect.soft(withinFloor(d, control), msg).toBe(true)
    }

    // 1. images that finish loading mid-pan: their bytes were held since the open
    await staleCase('images loading', async () => {
      for (const route of held.splice(0)) await route.continue()
      await page.context().unroute('**/files/**/d/**')
      const shown = await waitImagesLoaded(page, 60_000, inView)
      expect(shown.loaded, 'the images in view loaded').toBe(inView.length)
      // and the rest of the board's (each one loaded is a scene update: a full render)
      const all = await waitImagesLoaded(page, 60_000)
      expect(all.failed).toBe(0)
      await page.waitForTimeout(300)
    })

    // 2. a remote change: bob moves a note in the middle of alice's view
    await centreAt(page, frame0 as string, 0.5)
    const target = await page.evaluate(
      ({ notes }) => {
        const w = window as unknown as PanWindow
        const v = w.__lobbyBoard.canvas.viewport.get()
        return (
          notes.find((id) => {
            const b = w.__lobbyBoard.canvas.bounds(id)
            return (
              !!b &&
              b.x > v.x + v.width * 0.35 &&
              b.x + b.width < v.x + v.width * 0.65 &&
              b.y > v.y + v.height * 0.35 &&
              b.y + b.height < v.y + v.height * 0.65
            )
          }) ?? null
        )
      },
      { notes: big.board.noteIds },
    )
    expect(target, 'a note in the middle of the view').not.toBeNull()
    const id = target as string
    const x0 = await page.evaluate((id) => (window as unknown as PanWindow).lobbyCanvas.get(id)?.x ?? 0, id)
    await staleCase('a remote change', async () => {
      await bob.page.evaluate(({ id, x }) => (window as unknown as PanWindow).lobbyCanvas.update(id, { x }), {
        id,
        x: x0 + 40,
      })
      await page.waitForFunction(
        ({ id, x }) => (window as unknown as PanWindow).lobbyCanvas.get(id)?.x === x,
        { id, x: x0 + 40 },
        { timeout: 30_000, polling: 20 },
      )
      await page.waitForTimeout(100)
    })

    // 3. a selection change: the note gets a link (its icon is drawn unless it is selected), then is selected mid-pan
    const link = `${WEB_URL}/b/${board}?el=${note0}`
    await page.evaluate(({ id, link }) => (window as unknown as PanWindow).lobbyCanvas.update(id, { link }), {
      id,
      link,
    })
    await page.waitForFunction(
      ({ id, link }) => (window as unknown as PanWindow).lobbyCanvas.get(id)?.link === link,
      { id, link },
      { timeout: 30_000, polling: 50 },
    )
    await page.waitForTimeout(300)
    await staleCase('a selection change', async () => {
      await page.evaluate((id) => (window as unknown as PanWindow).__lobbyBoard.canvas.select([id]), id)
      await page.waitForTimeout(100)
    })
    await page.evaluate(() => (window as unknown as PanWindow).__lobbyBoard.canvas.select([]))

    // 4. a theme switch (the account menu's picker, as a person switches)
    await staleCase('a theme switch', async () => {
      await pickTheme(page, 'dark')
      await closeAccountMenu(page)
      await page.waitForTimeout(150)
    })
    await pickTheme(page, 'light')
    await closeAccountMenu(page)
    await page.waitForTimeout(300)

    // 5. bob's cursor and laser over alice's view (bob's camera on hers): Lobby's overlays, never the static canvas, so
    // no full render is due; the blit goes on and its frame is still a full render's
    let overlays = { cursors: 0, laser: 0 }
    await staleCase(
      'a laser and a cursor',
      async () => {
        await putView(bob.page, await viewOf(page))
        // the laser through bob's facade (the board's keys go to the page that has the focus: alice's here)
        await bob.page.evaluate(() => (window as unknown as PanWindow).lobbyCanvas.setTool('laser'))
        await expect
          .poll(() => bob.page.evaluate(() => (window as unknown as PanWindow).lobbyCanvas.tool()))
          .toBe('laser')
        await laserStroke(bob.page, { dx: 8, steps: 40, stepMs: 16 })
        overlays = await page.evaluate(() => ({
          cursors: document.querySelectorAll('[data-testid="cursor"]').length,
          laser: document.querySelectorAll('[data-testid="laser-layer"] path').length,
        }))
      },
      { full: false },
    )
    log(`a laser and a cursor: alice's overlays ${JSON.stringify(overlays)}`)
    const shown = overlays.cursors + overlays.laser
    expect.soft(shown, 'bob’s cursor or laser on alice’s page').toBeGreaterThan(0)
    writeFileSync(test.info().outputPath('pan-blit-stale.json'), JSON.stringify(cases, null, 1))
    await context.close()
  } finally {
    for (const route of held.splice(0)) await route.continue().catch(() => {})
    await browser.close()
  }
})
