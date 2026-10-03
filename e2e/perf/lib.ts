// Shared helpers for the perf harness (e2e/perf/run.ts): statistics, the slice of Lobby's board page (the
// test facade and the debug handle) the in-page scripts use, the browser launcher and the board open.
//
// Everything passed to page.evaluate runs in the page: it must not reference anything from this
// module (Playwright serializes the function's source).
import { cpus } from 'node:os'
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Nearest-rank percentile of an unsorted list (0 when empty). */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank] ?? 0
}

export const median = (values: readonly number[]) => percentile(values, 50)
export const round1 = (n: number) => Math.round(n * 10) / 10

export interface Summary {
  n: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

export function summarize(values: readonly number[]): Summary {
  const n = values.length
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : 0
  return {
    n,
    p50: round1(percentile(values, 50)),
    p95: round1(percentile(values, 95)),
    p99: round1(percentile(values, 99)),
    max: round1(n ? Math.max(...values) : 0),
    mean: round1(mean),
  }
}

/**
 * Whole-machine CPU busy share between start() and the returned stop() (all cores; other programs
 * count too). Reported with every measurement: this PC is shared, and a busy machine lowers the numbers.
 */
export function cpuMeter(): () => number {
  const snap = () =>
    cpus().reduce(
      (a, c) => {
        const t = c.times
        a.busy += t.user + t.sys + t.irq + t.nice
        a.total += t.user + t.sys + t.irq + t.nice + t.idle
        return a
      },
      { busy: 0, total: 0 },
    )
  const s = snap()
  return () => {
    const e = snap()
    return round1(((e.busy - s.busy) / Math.max(1, e.total - s.total)) * 100)
  }
}

// ---- the board page, as the in-page scripts see it ----------------------------------------------------
//
// Lobby's board page behind the dev-auth guard (the build vite preview serves: VITE_DRAFTROOM_DEV_AUTH=1):
//   window.lobbyCanvas      the e2e test facade (apps/web/src/canvas/test-facade.ts: items, get, update,
//                           saveState, pushedOps, ...), every write through `transact` and the sync engine;
//   window.__lobbyHarness   its side channel (viewport, setViewport, fit, the change log, the paint watch);
//   window.__lobbyBoard     the board page's debug handle (canvas/board/session.ts): `canvas` (LobbyCanvas:
//                           transact, viewport.zoomTo, files.status), `port` (on('changed')), `core`;
//   window.__lobbyLod       the level-of-detail pass's switch and state (3b), when the page has it.
// The types below are the slice the in-page scripts use (types only: page.evaluate ships the source).

export interface PerfBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PerfViewport extends PerfBounds {
  zoom: number
}

export interface PerfElement extends PerfBounds {
  id: string
  type: string
  isDeleted?: boolean
  containerId?: string | null
  frameId?: string | null
  backgroundColor?: string
  fileId?: string | null
  boundElements?: { id: string; type: string }[] | null
}

export interface PerfTx {
  update(id: string, patch: Record<string, unknown>): void
}

export interface PerfWindow {
  lobbyCanvas?: {
    items(): PerfElement[]
    get(id: string): PerfElement | null
    saveState(): { state: string }
    pushedOps(): { at: number; ops: { k: string; id?: string; el?: { id: string } }[] }[]
  }
  __lobbyHarness?: { session(): { welcomed: boolean } }
  __lobbyBoard?: {
    canvas: {
      items(): PerfElement[]
      bounds(id: string): PerfBounds | null
      select(ids: string[]): void
      transact<T>(label: string, fn: (tx: PerfTx) => T): T
      isHidden(id: string): boolean
      viewport: {
        get(): PerfViewport
        set(v: Partial<PerfViewport>): void
        zoomTo(b: PerfBounds, o?: { maxZoom?: number }): void
      }
      files: { status(id: string): string | null }
    }
    port: { on(event: 'changed', listener: (ids: readonly string[]) => void): () => void }
  }
  __lobbyLod?: {
    state(): { active: boolean; stale: number; rendering: number }
    setEnabled(on: boolean): void
  }
}

// ---- the camera ------------------------------------------------------------------------------------------

/**
 * The measured views: Lobby's whole-board fit, frame 0 at 0.25, frame 0's note grid at 100% (no image in
 * view: the image column is at the frame's right), and `100-images`: frame 0's image column at 100% (three
 * images on screen, drawn from their 2,048 px display renderings).
 */
export type PerfView = 'fit' | '0.25' | '100' | '100-images'

export interface ViewState {
  zoom: number
  /** items (a note with its label is one) at least partly in the viewport, and on the board */
  visible: number
  total: number
}

/**
 * Sets the camera of `page` through the board page's LobbyCanvas (as a person's zoom would) and clears the
 * selection: `fit` is Lobby's whole-board fit (zoomTo every live item, below Excalidraw's 0.1, as
 * e2e/excalidraw/navigation-lod-fps.spec.ts does), `0.25` centres frame `frame0` at 0.25, `100` puts
 * frame 0's top-left 20 px from the viewport's at 100%, `100-images` frame 0's image column (its right
 * 520 px) at 100%. Resolves two animation frames later.
 */
export function setView(page: Page, view: PerfView, frame0: string): Promise<ViewState> {
  return page.evaluate(
    async ({ view, frame0 }) => {
      const c = (window as unknown as PerfWindow).__lobbyBoard?.canvas
      if (!c) throw new Error('no window.__lobbyBoard (a dev-auth build of Lobby’s board page?)')
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
        if (!f) throw new Error(`no frame ${frame0}`)
        const vp = c.viewport.get()
        if (view === '0.25') {
          const z = 0.25
          c.viewport.set({
            zoom: z,
            x: f.x + f.width / 2 - (vp.width * vp.zoom) / z / 2,
            y: f.y + f.height / 2 - (vp.height * vp.zoom) / z / 2,
          })
        } else if (view === '100-images')
          c.viewport.set({ zoom: 1, x: f.x + f.width - 520 - 300, y: f.y + 40 })
        else c.viewport.set({ zoom: 1, x: f.x - 20, y: f.y - 20 })
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

/** Image element ids at least partly in the current viewport of `page`. */
export const imagesInView = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as PerfWindow).__lobbyBoard?.canvas
    if (!c) return []
    const v = c.viewport.get()
    return c
      .items()
      .filter(
        (e) =>
          e.type === 'image' &&
          !e.isDeleted &&
          e.x + e.width >= v.x &&
          e.x <= v.x + v.width &&
          e.y + e.height >= v.y &&
          e.y <= v.y + v.height,
      )
      .map((e) => e.id)
  })

// ---- browser --------------------------------------------------------------------------------------

export type BrowserKind = 'chrome' | 'shell'

/**
 * Branded Chrome in (new) headless mode with the hardware GPU, as the 2026-09-27 review measured
 * (docs/REVIEW-2026-09-27.md §2), or Playwright's headless shell (software rendering) with `shell`.
 */
export async function launchBrowser(kind: BrowserKind): Promise<Browser> {
  if (kind === 'shell') return chromium.launch({ headless: true })
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-precise-memory-info'],
  })
}

/** The review's window: 1536×864 CSS px at DPR 1.25 (a 1920×1080 laptop panel at 125%). */
export const VIEWPORT = { width: 1536, height: 864 }
export const DPR = 1.25

export async function signedInContext(
  browser: Browser,
  web: string,
  handle: string,
  name: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
  const res = await context.request.post(`${web}/api/auth/dev/login`, {
    headers: { origin: web },
    data: { handle, name },
  })
  if (res.status() !== 200) throw new Error(`dev login ${handle}: ${res.status()} ${await res.text()}`)
  return context
}

/**
 * Opens a board in `page` and waits until Lobby's board page is live: the facade installed and the
 * `welcome` applied, at least `elements` elements in the scene, nothing of the tab's own waiting
 * (Saved), then two animation frames (painted). Returns the ms from navigation to that.
 */
export async function openBoard(page: Page, web: string, boardId: string, elements = 0): Promise<number> {
  const t0 = Date.now()
  await page.goto(`${web}/b/${boardId}`)
  await page.waitForFunction(
    (n) => {
      const w = window as unknown as PerfWindow
      const f = w.lobbyCanvas
      if (!f || !w.__lobbyHarness?.session().welcomed || !w.__lobbyBoard) return false
      return f.items().length >= n && f.saveState().state === 'saved'
    },
    elements,
    { timeout: 180_000, polling: 100 },
  )
  await frames(page, 2)
  return Date.now() - t0
}

/**
 * Waits until the image loader has every image element of the board (`ids`; all of them when omitted)
 * loaded, or `timeoutMs` passed. Returns how many are loaded and the ms it took.
 */
export async function waitImagesLoaded(
  page: Page,
  timeoutMs = 120_000,
  ids?: readonly string[],
): Promise<{ loaded: number; total: number; failed: number; ms: number }> {
  const t0 = Date.now()
  const read = () =>
    page.evaluate((ids) => {
      const w = window as unknown as PerfWindow
      const all = ids ?? (w.lobbyCanvas?.items() ?? []).filter((e) => e.type === 'image').map((e) => e.id)
      let loaded = 0
      let failed = 0
      for (const id of all) {
        const s = w.__lobbyBoard?.canvas.files.status(id)
        if (s === 'loaded') loaded++
        else if (s === 'failed') failed++
      }
      return { loaded, failed, total: all.length }
    }, ids ?? null)
  let last = await read()
  while (last.loaded + last.failed < last.total && Date.now() - t0 < timeoutMs) {
    await sleep(100)
    last = await read()
  }
  return { ...last, ms: Date.now() - t0 }
}

/** Resolves once `n` animation frames have passed in the page. */
export const frames = (page: Page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )
