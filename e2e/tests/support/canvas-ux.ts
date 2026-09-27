// Helpers for the canvas-ux browser suite (canvas-ux.spec.ts): the slice of tldraw 5.4.2's Editor these
// tests read beyond support/editor.ts, clipboard access, toolbar and geometry checks. Hand-written from
// node_modules/@tldraw/editor/src/lib/editor/Editor.ts; keep it to methods that exist there.
import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test'
import { signInContext } from './api.ts'
import { edit, read, waitForBoard } from './board.ts'
import type { BoxLike, EditorLike, ShapeLike, VecLike } from './editor.ts'
import { WEB_URL } from './ports.ts'
import type { TestUser } from './users.ts'

export interface CameraLike {
  x: number
  y: number
  z: number
}

/** EditorLike plus what canvas-ux asserts on (camera, undo, preferences, selection geometry). */
export interface CanvasEditor extends EditorLike {
  getCamera(): CameraLike
  setCamera(point: CameraLike, opts?: { immediate?: boolean }): CanvasEditor
  getZoomLevel(): number
  getViewportPageBounds(): BoxLike
  getCurrentPageBounds(): BoxLike | undefined
  getSelectionPageBounds(): BoxLike | null
  getSelectedShapes(): ShapeLike[]
  getCurrentPageId(): string
  getCurrentPageShapeIds(): Set<string>
  getCanUndo(): boolean
  /** The state-machine path, e.g. select.translating. */
  getPath(): string
  zoomToSelection(opts?: { animation?: { duration: number } }): CanvasEditor
  user: {
    getIsSnapMode(): boolean
    updateUserPreferences(prefs: { isSnapMode?: boolean }): void
  }
  inputs: { getPointerVelocity(): { len(): number }; getIsPanning(): boolean }
  /** SnapManager: the alignment guides shown while a drag snaps. */
  snaps: { getIndicators(): unknown[] }
  zoomToBounds(
    bounds: BoxLike,
    opts?: { inset?: number; immediate?: boolean; targetZoom?: number },
  ): CanvasEditor
  getOnlySelectedShape(): ShapeLike | null
  getInstanceState(): { isToolLocked: boolean; isFocused: boolean; isReadonly: boolean }
  /** 'moving' while the camera changes, 'idle' once it has stopped. */
  getCameraState(): 'idle' | 'moving'
  toggleLock(ids: string[]): CanvasEditor
}

/** `read` from board.ts, typed for CanvasEditor (the callback is still serialized into the page). */
export function readEd<T, A = undefined>(page: Page, fn: (editor: CanvasEditor, arg: A) => T, arg?: A) {
  return read<T, A>(page, fn as unknown as (e: EditorLike, a: A) => T, arg)
}

/** Runs `fn` in the page for its side effects (editor mutators return the unserializable editor). */
export function editEd<A>(page: Page, fn: (editor: CanvasEditor, arg: A) => unknown, arg?: A) {
  return edit<A>(page, fn as unknown as (e: EditorLike, a: A) => unknown, arg)
}

// ---- geometry ----------------------------------------------------------------------------------

export function union(boxes: readonly BoxLike[]): BoxLike | null {
  if (!boxes.length) return null
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function contains(outer: BoxLike, inner: BoxLike, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  )
}

export function overlaps(a: BoxLike, b: BoxLike): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export const viewport = (page: Page) => readEd(page, (ed) => ed.getViewportPageBounds())
export const camera = (page: Page) =>
  readEd(page, (ed) => {
    const c = ed.getCamera()
    return { x: c.x, y: c.y, z: c.z }
  })
export const zoom = (page: Page) => readEd(page, (ed) => ed.getZoomLevel())
export const selectedIds = (page: Page) => readEd(page, (ed) => [...ed.getSelectedShapeIds()].sort())
export const currentTool = (page: Page) => readEd(page, (ed) => ed.getCurrentToolId())

/** Page bounds of every listed shape that exists (the union of them, or null). */
export const boundsOf = (page: Page, ids: readonly string[]) =>
  readEd(
    page,
    (ed, list) => {
      const out: BoxLike[] = []
      for (const id of list) {
        const b = ed.getShapePageBounds(id)
        if (b) out.push({ x: b.x, y: b.y, w: b.w, h: b.h })
      }
      return out
    },
    [...ids],
  ).then(union)

/** Whether the page bounds of `ids` are fully inside the visible viewport. */
export async function inView(page: Page, ids: readonly string[]): Promise<boolean> {
  const [vp, b] = await Promise.all([viewport(page), boundsOf(page, ids)])
  return b !== null && contains(vp, b)
}

/** Counts shapes on the current page, optionally of one type. */
export const shapeCount = (page: Page, type?: string) =>
  readEd(page, (ed, t) => ed.getCurrentPageShapes().filter((s) => !t || s.type === t).length, type ?? null)

/** z-order of the page's direct children (back to front). */
export const zOrder = (page: Page) =>
  readEd(page, (ed) => ed.getSortedChildIdsForParent(ed.getCurrentPageId()))

// ---- toolbar -----------------------------------------------------------------------------------

/** data-testid of every tool button the user can see in the main toolbar, left to right. */
export function visibleToolbarIds(page: Page): Promise<string[]> {
  return page.locator('.tlui-main-toolbar [data-testid^="tools."]').evaluateAll((els) =>
    els
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((el) => el.getAttribute('data-testid') ?? ''),
  )
}

// ---- clipboard ---------------------------------------------------------------------------------

/** The async clipboard API needs these on the web origin (the browser asks a real user once). */
export async function grantClipboard(context: BrowserContext) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
}

/** Puts one clipboard item with these representations (e.g. text/html + text/plain) on the clipboard. */
export async function writeClipboard(page: Page, parts: Record<string, string>) {
  await page.evaluate(async (items) => {
    const blobs: Record<string, Blob> = {}
    for (const [type, value] of Object.entries(items)) blobs[type] = new Blob([value], { type })
    await navigator.clipboard.write([new ClipboardItem(blobs)])
  }, parts)
}

export const readClipboardText = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

// ---- the board as a user sees it --------------------------------------------------------------

/** Clicks a shape at its centre, as a user selecting it would (also gives the canvas the keyboard). */
export async function clickShape(page: Page, id: string, opts: { shift?: boolean } = {}) {
  const c = await readEd(
    page,
    (ed, shapeId) => {
      const b = ed.getShapePageBounds(shapeId)
      if (!b) throw new Error(`no shape ${shapeId}`)
      return ed.pageToScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
    },
    id,
  )
  if (opts.shift) await page.keyboard.down('Shift')
  await page.mouse.click(c.x, c.y)
  if (opts.shift) await page.keyboard.up('Shift')
}

/** Clicks empty canvas at a page point (deselects and gives the canvas the keyboard). */
export async function clickCanvasAt(page: Page, point: VecLike) {
  const s = await readEd(page, (ed, p) => ed.pageToScreen(p), point)
  await page.mouse.click(s.x, s.y)
}

/** Drags with the primary button from one screen point to another in small steps. */
export async function drag(page: Page, from: VecLike, to: VecLike, opts: { steps?: number } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 12 })
  await page.mouse.up()
}

/** Screen point of a page point. */
export const screenOf = (page: Page, point: VecLike) => readEd(page, (ed, p) => ed.pageToScreen(p), point)

/**
 * Waits until the save indicator says every local change is acknowledged by the server ("Saved").
 * Needed before another browser loads the board or this one reloads while the user is ALONE: tldraw
 * sync then sends changes at 1 frame per second (SOLO_MODE_FPS), so a reload or a first visit within
 * that second would not see them yet (the app warns before unloading unsaved changes).
 */
export async function waitForSaved(page: Page) {
  // Two frames: the tracker has seen the last change and React has rendered it ("Saving…").
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 20_000 })
}

/**
 * Waits until canvas-ux has mounted on this page: its keys, paste handler and snap default are
 * installed and the start view has decided the first camera (the overlay's data-start-view).
 */
export async function waitForCanvasUx(page: Page) {
  await expect(page.locator('[data-testid="canvas-ux-overlay"][data-start-view]')).toBeAttached({
    timeout: 30_000,
  })
}

/** What the start view did on this page load: 'template:<id>', 'deep-link', 'restore', 'restore+fit', 'fit', 'none'. */
export const startView = (page: Page) => page.getByTestId('canvas-ux-overlay').getAttribute('data-start-view')

/** tldraw's keyboard-shortcuts dialog rows: label and the key text as shown. */
export function shortcutRows(page: Page): Promise<{ label: string; kbd: string }[]> {
  return page.locator('.tlui-shortcuts-dialog__key-pair').evaluateAll((rows) =>
    rows.map((r) => ({
      label: (r.querySelector('.tlui-shortcuts-dialog__key-pair__key')?.textContent ?? '').trim(),
      // tldraw renders each key (and each '+' between them) as a <span> inside one <kbd>.
      kbd: [...r.querySelectorAll('.tlui-kbd span')].map((k) => (k.textContent ?? '').trim()).join(''),
    })),
  )
}

/**
 * Opens `path` (e.g. a copied deep link, or /b/<id>?template=…) as `user` in a new browser context,
 * signed in through the dev login endpoint. `board: false` for pages that are not an open board
 * (no-access). The caller closes the context.
 */
export async function openPath(
  browser: Browser,
  user: TestUser,
  path: string,
  opts: { board?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  await page.goto(path)
  if (opts.board !== false) {
    await waitForBoard(page)
    await waitForCanvasUx(page)
  }
  return { context, page }
}

/** The camera canvas-ux stored for this board and user (localStorage, per browser profile). */
export function storedCamera(page: Page, boardId: string, userId: string) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as { pageId: string; x: number; y: number; z: number }) : null
  }, `draftroom:camera:v1:${userId}:${boardId}`)
}
