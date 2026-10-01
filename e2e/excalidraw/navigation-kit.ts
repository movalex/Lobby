// Helpers for 3b's ported navigation specs (navigation-*.spec.ts) on the Excalidraw board page: the first
// view marker, the camera (viewport = the visible scene rectangle and the zoom), geometry, the page's
// navigation dev hook (window.__lobbyNavigation: its commands and menu entries with the page's feature
// context, while 3a's menu and selection-bar shells are not on the page), the clipboard, and opening a
// path in a fresh browser. Canvas reads and writes go through ../tests/support/canvas.ts (the facade).
import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  type Bounds,
  type CanvasElement,
  canvasCall,
  expectSaved,
  itemBounds,
  items,
  itemText,
  selection,
  type Viewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import type { TestUser } from '../tests/support/users.ts'

// ---- the first view ------------------------------------------------------------------------------------

/** The navigation feature is mounted and the first view is decided (the overlay's data-start-view). */
export async function waitForNavigation(page: Page): Promise<void> {
  await waitForCanvas(page)
  await expect(page.locator('[data-testid="navigation-overlay"][data-start-view]')).toBeAttached({
    timeout: 30_000,
  })
}

/** What the first view did: 'template:<id>', 'deep-link', 'restore', 'restore+fit', 'start-view', 'fit', … */
export const startView = (page: Page) =>
  page.getByTestId('navigation-overlay').getAttribute('data-start-view')

// ---- the camera ------------------------------------------------------------------------------------------

export const viewport = (page: Page): Promise<Viewport> => canvasCall(page, 'viewport')
export const zoom = async (page: Page) => (await viewport(page)).zoom

/** Sets the camera (the scene's top-left and the zoom) at once, through the page's canvas. */
export async function setView(page: Page, v: { x: number; y: number; zoom: number }): Promise<void> {
  await page.evaluate((view) => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: { viewport: { set(v: unknown): void } } } })
      .__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    b.canvas.viewport.set(view)
  }, v)
}

/** The union of the scene bounds of `ids` that exist, or null. */
export async function boundsOf(page: Page, ids: readonly string[]): Promise<Bounds | null> {
  const bs = (await Promise.all(ids.map((id) => itemBounds(page, id)))).filter((b): b is Bounds => !!b)
  if (!bs.length) return null
  const x = Math.min(...bs.map((b) => b.x))
  const y = Math.min(...bs.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...bs.map((b) => b.x + b.width)) - x,
    height: Math.max(...bs.map((b) => b.y + b.height)) - y,
  }
}

export const contains = (outer: Bounds, inner: Bounds, tolerance = 0.5) =>
  inner.x >= outer.x - tolerance &&
  inner.y >= outer.y - tolerance &&
  inner.x + inner.width <= outer.x + outer.width + tolerance &&
  inner.y + inner.height <= outer.y + outer.height + tolerance

export const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Whether the bounds of `ids` lie wholly inside the visible scene rectangle. */
export async function inView(page: Page, ids: readonly string[]): Promise<boolean> {
  const [v, b] = await Promise.all([viewport(page), boundsOf(page, ids)])
  return b !== null && contains(v, b)
}

/** The camera has stopped (no animation, pan or zoom in progress). */
export async function cameraIdle(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const b = (window as unknown as { __lobbyBoard?: { canvas: { viewport: { moving(): boolean } } } })
          .__lobbyBoard
        return b?.canvas.viewport.moving() ?? true
      }),
    )
    .toBe(false)
}

// ---- reads ------------------------------------------------------------------------------------------------

export const sortedSelection = async (page: Page) => [...(await selection(page))].sort()

/** Content items (no bound labels) of `type`, or all. */
export async function contentOf(page: Page, type?: string): Promise<CanvasElement[]> {
  return (await items(page)).filter(
    (e) =>
      !(e.type === 'text' && (e as { containerId?: string | null }).containerId) &&
      (!type || e.type === type),
  )
}
export const countOf = async (page: Page, type?: string) => (await contentOf(page, type)).length

/** The notes with their text, sorted by text. */
export async function notes(
  page: Page,
): Promise<{ id: string; text: string; x: number; y: number; frameId: string | null }[]> {
  const list = await contentOf(page, 'stickynote')
  const out = await Promise.all(
    list.map(async (n) => ({
      id: n.id,
      text: await itemText(page, n.id),
      x: n.x,
      y: n.y,
      frameId: n.frameId,
    })),
  )
  return out.sort((a, b) => a.text.localeCompare(b.text))
}

/** Positions of `ids` (scene top-left, frame). */
export async function placements(
  page: Page,
  ids: readonly string[],
): Promise<Record<string, { x: number; y: number; frameId: string | null }>> {
  const all = new Map((await items(page)).map((e) => [e.id, e]))
  const out: Record<string, { x: number; y: number; frameId: string | null }> = {}
  for (const id of ids) {
    const e = all.get(id)
    if (e) out[id] = { x: Math.round(e.x * 100) / 100, y: Math.round(e.y * 100) / 100, frameId: e.frameId }
  }
  return out
}

// ---- the navigation dev hook -------------------------------------------------------------------------------

type Hook = {
  run(id: string): Promise<boolean>
  entries(menu: 'contextMenu' | 'mainMenu'): { id: string; label: string }[]
  menu(menu: 'contextMenu' | 'mainMenu', path: string): Promise<boolean>
  selectionBar(): string[]
}

/** Runs a command of the page's registry with the feature context (as its menu entry or key would). */
export const navRun = (page: Page, commandId: string) =>
  page.evaluate(async (id) => {
    const h = (window as unknown as { __lobbyNavigation?: Hook }).__lobbyNavigation
    if (!h) throw new Error('no window.__lobbyNavigation (not the Excalidraw board page, or not a dev build)')
    return h.run(id)
  }, commandId)

/** The entries a menu would show now (`parent/child` for submenu entries), with their labels. */
export const navEntries = (page: Page, menu: 'contextMenu' | 'mainMenu') =>
  page.evaluate((m) => {
    const h = (window as unknown as { __lobbyNavigation?: Hook }).__lobbyNavigation
    if (!h) throw new Error('no window.__lobbyNavigation')
    return h.entries(m)
  }, menu)

/** Runs a menu entry that is shown now; false when it is not. */
export const navMenu = (page: Page, menu: 'contextMenu' | 'mainMenu', path: string) =>
  page.evaluate(
    async ({ m, p }) => {
      const h = (window as unknown as { __lobbyNavigation?: Hook }).__lobbyNavigation
      if (!h) throw new Error('no window.__lobbyNavigation')
      return h.menu(m, p)
    },
    { m: menu, p: path },
  )

/** The selection-bar items that would show for the current selection. */
export const navSelectionBar = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { __lobbyNavigation?: Hook }).__lobbyNavigation
    if (!h) throw new Error('no window.__lobbyNavigation')
    return h.selectionBar()
  })

// ---- the keyboard ------------------------------------------------------------------------------------------

/** Gives the board the keyboard without a click (a click would change the selection). */
export async function focusCanvas(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
}

// ---- the clipboard -------------------------------------------------------------------------------------------

export async function grantClipboard(context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
}

/** One clipboard item with these representations (e.g. text/html + text/plain). */
export async function writeClipboard(page: Page, parts: Record<string, string>) {
  await page.evaluate(async (entries) => {
    const blobs: Record<string, Blob> = {}
    for (const [type, value] of Object.entries(entries)) blobs[type] = new Blob([value], { type })
    await navigator.clipboard.write([new ClipboardItem(blobs)])
  }, parts)
}

export const readClipboardText = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

// ---- other browsers -----------------------------------------------------------------------------------------

/**
 * Opens `path` (a copied link, `/b/<id>?template=…`) as `user` in a fresh browser context (a new profile:
 * no stored camera). `board: false` for pages that are not an open board (no access). The caller closes it.
 */
export async function openPath(
  browser: Browser,
  user: TestUser,
  path: string,
  opts: { board?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  await page.goto(path)
  if (opts.board !== false) await waitForNavigation(page)
  return { context, page }
}

/** The camera this browser stored for the board and user (localStorage). */
export const storedView = (page: Page, boardId: string, userId: string) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as { x: number; y: number; zoom: number }) : null
  }, `draftroom:camera:v2:${userId}:${boardId}`)

/**
 * Frame membership through the page's canvas (`tx.setFrame`: a note's label goes with it), one step.
 * The facade's `update` writes one element only.
 */
export async function setFrame(page: Page, ids: readonly string[], frameId: string | null): Promise<void> {
  await page.evaluate(
    ({ list, frame }) => {
      type Tx = { setFrame(ids: string[], f: string | null): void }
      const b = (
        window as unknown as {
          __lobbyBoard?: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      b.canvas.transact('e2e set frame', (tx) => tx.setFrame(list, frame))
    },
    { list: [...ids], frame: frameId },
  )
  await expectSaved(page)
}

/** Groups `ids` through the page's canvas (`tx.group`), one step; returns the group id. */
export async function group(page: Page, ids: readonly string[]): Promise<string> {
  const gid = await page.evaluate(
    (list) => {
      type Tx = { group(ids: string[]): string }
      const b = (
        window as unknown as {
          __lobbyBoard?: { canvas: { transact(l: string, fn: (tx: Tx) => string): string } }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      return b.canvas.transact('e2e group', (tx) => tx.group(list))
    },
    [...ids],
  )
  await expectSaved(page)
  return gid
}

/** Binds an arrow's ends through the page's canvas (`tx.bind`), one step. */
export async function bindArrow(page: Page, arrow: string, start: string | null, end: string | null) {
  await page.evaluate(
    ({ a, s, e }) => {
      type Tx = { bind(arrow: string, end: 'start' | 'end', target: string | null): void }
      const b = (
        window as unknown as {
          __lobbyBoard?: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard')
      b.canvas.transact('e2e bind', (tx) => {
        tx.bind(a, 'start', s)
        tx.bind(a, 'end', e)
      })
    },
    { a: arrow, s: start, e: end },
  )
  await expectSaved(page)
}

/** Several facade writes in a row, each Saved before the next (spike B's open O2 race; board-kit.ts). */
export async function seed<T>(page: Page, writes: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = []
  for (const w of writes) {
    out.push(await w())
    await expectSaved(page)
  }
  return out
}

/** Lobby's undo and redo through the real keys on the board (the facade verbs are 2E's, not on the page yet). */
export async function undoKey(page: Page): Promise<void> {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+z')
}
export async function redoKey(page: Page): Promise<void> {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+Shift+z')
}

/** One board-document key as this tab holds it (lb_doc through the page's canvas). */
export const docValue = (page: Page, key: string) =>
  page.evaluate((k) => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: { doc: { get(k: string): unknown } } } })
      .__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    return b.canvas.doc.get(k) ?? null
  }, key)

/** Two viewports agree within a pixel (scene) and a thousandth of zoom. */
export const nearView = (
  a: { x: number; y: number; zoom: number },
  b: { x: number; y: number; zoom: number },
  px = 1,
) => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px && Math.abs(a.zoom - b.zoom) < 0.001

/** A real click on the canvas at a fraction of its box (empty canvas the caller chose). */
export async function clickCanvasAt(page: Page, fx: number, fy: number): Promise<void> {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
}

// ---- camera motion (W5-21) ------------------------------------------------------------------------------------

/** Starts recording the camera on every animation frame (each change once), to count a move's positions. */
export async function recordCamera(page: Page): Promise<void> {
  await page.evaluate(() => {
    type V = { x: number; y: number; zoom: number }
    const w = window as unknown as {
      __navCams?: string[]
      __navCamsOn?: boolean
      __lobbyBoard: { canvas: { viewport: { get(): V } } }
    }
    const cams: string[] = []
    w.__navCams = cams
    w.__navCamsOn = true
    const tick = () => {
      if (!w.__navCamsOn) return
      const v = w.__lobbyBoard.canvas.viewport.get()
      const k = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.zoom.toFixed(5)}`
      if (cams[cams.length - 1] !== k) cams.push(k)
      requestAnimationFrame(tick)
    }
    tick()
  })
}

/** Stops recording; the cameras seen, in order (the first is where the move started). */
export async function recordedCameras(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __navCams?: string[]; __navCamsOn?: boolean }
    w.__navCamsOn = false
    return w.__navCams ?? []
  })
}

/** Runs `action` and returns how many camera positions it went through (1 + the in-between ones). */
export async function cameraSteps(page: Page, action: () => Promise<void>, settleMs = 700): Promise<number> {
  await recordCamera(page)
  await action()
  await page.waitForTimeout(settleMs)
  return (await recordedCameras(page)).length - 1
}

/** Whether the element at the centre of `testId`'s box is that control (nothing covers it). */
export async function centreHitsItself(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!at && (at === el || el.contains(at))
  }, testId)
}
