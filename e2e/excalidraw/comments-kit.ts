// Helpers for the ported comments specs (comments-*.spec.ts) on the Excalidraw board page: the api slice and
// the locators of the tldraw suite's support/comments.ts (the same test ids), plus the canvas-driven steps
// on the facade (tests/support/canvas.ts) instead of window.editor. Element ids are the canvas's own; the
// api names them `shape:<id>` (canvas-schema refs.ts), as comment anchors do.
import { expect, type Page } from '@playwright/test'
import {
  canvasCall,
  createNote,
  expectSaved,
  item,
  sceneToScreen,
  setViewport,
  tool,
  viewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { newCommentPopover, threadPopover } from '../tests/support/comments.ts'

export {
  bell,
  commentItem,
  commentRow,
  commentsApi,
  mentionToken,
  newCommentPopover,
  openCommentsPanel,
  pin,
  pins,
  type Thread,
  threadPopover,
  uvOf,
} from '../tests/support/comments.ts'

/** The api's object ref of an element (anchors, deleted rows). */
export const ref = (elementId: string) => `shape:${elementId}`

/** A shape anchor on an element at (u, v). */
export const shapeAnchor = (elementId: string, u = 0.5, v = 0.5) => ({
  kind: 'shape' as const,
  shapeId: ref(elementId),
  u,
  v,
})

/**
 * A comments notice with an action (mention → View, resolve → Undo): the board page's notices on the
 * Excalidraw page (tldraw drew its own toasts), found by their text.
 */
export const commentToast = (page: Page, text: string) => page.locator('.dr-notice', { hasText: text })

export const currentTool = (page: Page) => tool(page)

/** A note at (x, y) (scene), created by this tab; resolves with its element id once this tab has it saved. */
export async function noteAt(page: Page, x: number, y: number, text = 'Idea'): Promise<string> {
  const id = await createNote(page, { x, y, text })
  await expectSaved(page)
  return id
}

/** Keyboard focus on the board (as after a click on it) without a click: the board's keys reach it. */
export async function focusCanvas(page: Page) {
  await page.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: { focus(o?: object): void } } }).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
    b.canvas.focus({ preventScroll: true })
  })
  await expect.poll(() => canvasHasFocus(page)).toBe(true)
}

/** Whether the board has the keyboard (the focus is inside the engine's container). */
export const canvasHasFocus = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))

/** Presses C and waits for the comment tool. */
export async function pressCommentTool(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('c')
  await expect.poll(() => currentTool(page)).toBe('comment')
}

/** An element's own box (scene): its x, y, width, height. */
async function boxOf(page: Page, id: string) {
  const el = await item(page, id)
  if (!el) throw new Error(`no element ${id}`)
  return { x: el.x, y: el.y, w: el.width, h: el.height }
}

/** The screen point at (u, v) of an (unrotated) element's box. */
export async function screenPointOnElement(page: Page, id: string, u: number, v: number) {
  const b = await boxOf(page, id)
  return sceneToScreen(page, { x: b.x + u * b.w, y: b.y + v * b.h })
}

/**
 * With the comment tool on: clicks (u, v) of an element, writes `text` in the new-comment composer, presses
 * Enter and returns the id of the thread whose popover then opens.
 */
export async function commentOnElement(page: Page, id: string, text: string, uv = { u: 0.5, v: 0.5 }) {
  const p = await screenPointOnElement(page, id, uv.u, uv.v)
  return commentAtScreenPoint(page, p, text)
}

export async function commentAtScreenPoint(page: Page, p: { x: number; y: number }, text: string) {
  await page.mouse.click(p.x, p.y)
  const composer = newCommentPopover(page).getByTestId('comment-composer')
  await expect(composer).toBeFocused()
  await composer.fill(text)
  await composer.press('Enter')
  await expect(newCommentPopover(page)).toHaveCount(0)
  const popover = threadPopover(page)
  await expect(popover).toBeVisible()
  const id = await popover.getAttribute('data-thread-id')
  if (!id) throw new Error('thread popover without data-thread-id')
  return id
}

/** A screen point of empty board (right half, lower third; the specs put their notes near the origin). */
export async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return { x: Math.round(box.x + box.width * 0.72), y: Math.round(box.y + box.height * 0.7) }
}

/** Where a pin should sit on screen for a shape anchor, and where its pointed bottom-left corner is. */
export async function pinPlacement(page: Page, threadId: string, id: string, u: number, v: number) {
  const expected = await screenPointOnElement(page, id, u, v)
  const box = await page.locator(`[data-testid="comment-pin"][data-thread-id="${threadId}"]`).boundingBox()
  return { expected, actual: box ? { x: box.x, y: box.y + box.height } : null }
}

export async function expectPinOnAnchor(page: Page, threadId: string, id: string, u: number, v: number) {
  await expect
    .poll(
      async () => {
        const { expected, actual } = await pinPlacement(page, threadId, id, u, v)
        if (!actual) return 'no pin'
        return Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y))
      },
      { message: 'distance (px) between the pin corner and its anchor' },
    )
    .toBeLessThanOrEqual(2)
}

/** Centres the camera on an element at zoom `zoom`. */
export async function centerOn(page: Page, id: string, zoom: number) {
  const b = await boxOf(page, id)
  const v = await viewport(page)
  const w = (v.width * v.zoom) / zoom
  const h = (v.height * v.zoom) / zoom
  await setViewport(page, { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, zoom })
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(zoom, 3)
}

/** Moves the camera far away from the content near the origin (its pins are culled). */
export async function panAway(page: Page) {
  await setViewport(page, { x: 20_000, y: 20_000, zoom: 1 })
}

/** The canvas's client rectangle (the board page's own layout). */
export async function canvasRect(page: Page) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return box
}

/** Reloads the board and waits for the canvas (after this tab's last changes were saved). */
export async function reloadBoard(page: Page) {
  await expectSaved(page)
  await page.reload()
  await waitForCanvas(page)
}

/** Whom this tab follows (a session id), through the page's debug handle until 2E's `following` verb lands. */
export const followingSid = (page: Page) =>
  page.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: { follow: { current(): string | null } } } })
      .__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    return b.canvas.follow.current()
  })

/** This tab's session id (the welcome's). */
export async function sessionId(page: Page): Promise<string> {
  const me = await canvasCall(page, 'me')
  if (!me?.sid) throw new Error('no session id')
  return me.sid
}
