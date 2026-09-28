// Shared helpers for the perf harness (e2e/perf/run.ts): statistics, the slice of tldraw's Editor the
// in-page scripts use, and the browser launcher.
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

// ---- the editor, as the in-page scripts see it (tldraw 5.4.2; see e2e/tests/support/editor.ts) -------

export interface PerfShape {
  id: string
  type: string
  x: number
  y: number
  parentId: string
  props: Record<string, unknown>
  meta: Record<string, unknown>
}

export interface PerfBox {
  x: number
  y: number
  w: number
  h: number
  center: { x: number; y: number }
}

export interface PerfEditor {
  store: {
    listen(
      fn: (e: {
        changes: {
          added: Record<string, PerfShape>
          updated: Record<string, [PerfShape, PerfShape]>
          removed: Record<string, PerfShape>
        }
      }) => void,
      filters?: { source?: 'user' | 'remote' | 'all'; scope?: 'document' | 'session' | 'presence' | 'all' },
    ): () => void
    get(id: string): unknown
  }
  run(fn: () => void): void
  createShapes(partials: Record<string, unknown>[]): PerfEditor
  createAssets(assets: Record<string, unknown>[]): PerfEditor
  updateShape(partial: Record<string, unknown>): PerfEditor
  updateDocumentSettings(settings: Record<string, unknown>): PerfEditor
  getShape(id: string): PerfShape | undefined
  getCurrentPageShapeIds(): Set<string>
  getCurrentPageShapes(): PerfShape[]
  getShapePageBounds(id: string): PerfBox | undefined
  getCurrentPageBounds(): PerfBox | undefined
  getViewportScreenBounds(): PerfBox
  getViewportPageBounds(): PerfBox
  getCamera(): { x: number; y: number; z: number }
  setCamera(point: { x: number; y: number; z?: number }, opts?: { immediate?: boolean }): PerfEditor
  zoomToFit(opts?: { immediate?: boolean }): PerfEditor
  getZoomLevel(): number
  getRenderingShapes(): { id: string; shape: PerfShape }[]
  getCulledShapes(): Set<string>
  getCollaborators(): unknown[]
  selectNone(): PerfEditor
  setCurrentTool(id: string): PerfEditor
}

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

/** Opens a board and waits until the canvas is live and every shape tldraw renders is in the DOM. */
export async function openBoard(page: Page, web: string, boardId: string): Promise<number> {
  const t0 = Date.now()
  await page.goto(`${web}/b/${boardId}`)
  await page.waitForFunction(
    () => {
      const ed = (window as unknown as { editor?: PerfEditor }).editor
      if (!ed) return false
      const status = document.querySelector('[data-testid="conn-status"]')?.getAttribute('data-state')
      if (status && status !== 'online') return false
      return document.querySelectorAll('.tl-shape').length >= ed.getRenderingShapes().length
    },
    null,
    { timeout: 180_000, polling: 100 },
  )
  return Date.now() - t0
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
