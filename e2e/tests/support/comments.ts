// Helpers for the comments suite (docs/FEATURES-M2-CONTRACTS.md, "comments"): a typed slice of the
// comments routes for setup and server-side checks, locators for the comment UI, and the few
// editor-driven steps (placing notes, clicking a spot on a shape, reading where a pin sits).
import { expect, type Locator, type Page } from '@playwright/test'
import type { Api } from './api.ts'
import { edit, read, shapeBounds, toScreen } from './board.ts'
import type { BoxLike, EditorLike, VecLike } from './editor.ts'
import { richText } from './editor.ts'

/**
 * The extra tldraw 5.4.2 Editor methods this suite uses (node_modules/@tldraw/editor/dist-esm/
 * index.d.mts). Only a type: callbacks run in the page, so they cast `ed as Ed` inline.
 */
export interface Ed extends EditorLike {
  getContainer(): HTMLElement
  getCurrentPageId(): string
  getPages(): { id: string; name: string }[]
  createPage(page: { id: string; name: string }): Ed
  setCurrentPage(pageId: string): Ed
  getCamera(): { x: number; y: number; z: number }
  setCamera(camera: { x: number; y: number; z: number }): Ed
  getZoomLevel(): number
  getViewportScreenBounds(): BoxLike
  screenToPage(point: VecLike): VecLike
  getShapesAtPoint(point: VecLike, opts?: { hitInside?: boolean; margin?: number }): unknown[]
}

// ---- API (the slice of @draftroom/contracts comments.ts the suite reads) ---------------------------

export type Anchor =
  | { kind: 'point'; x: number; y: number; pageId?: string }
  | { kind: 'shape'; shapeId: string; u: number; v: number }

export interface UserRef {
  id: string
  name: string
  color: string
}
export interface ThreadComment {
  id: string
  threadId: string
  author: UserRef
  body: string
  mentions: string[]
  createdAt: string
  editedAt: string | null
}
export interface Thread {
  id: string
  boardId: string
  anchor: Anchor
  status: 'open' | 'resolved'
  createdBy: UserRef
  resolvedBy: UserRef | null
  comments: ThreadComment[]
}
export interface NotificationItem {
  id: string
  kind: 'mention' | 'reply' | 'resolved' | 'access_request'
  boardId: string
  boardTitle: string
  threadId: string | null
  commentId: string | null
  readAt: string | null
}

async function json<T>(res: Awaited<ReturnType<Api['fetch']>>, what: string): Promise<T> {
  if (res.status() >= 300) throw new Error(`${what} -> ${res.status()} ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

/** The comments routes, as one signed-in user (setup, and what the server stored). */
export function commentsApi(api: Api) {
  return {
    threads: (boardId: string) =>
      api
        .fetch('GET', `/api/boards/${boardId}/threads?status=all`)
        .then((r) => json<{ threads: Thread[]; reads: Record<string, string> }>(r, 'GET threads')),
    thread: async (boardId: string, threadId: string) =>
      (await commentsApi(api).threads(boardId)).threads.find((t) => t.id === threadId) ?? null,
    createThread: (boardId: string, anchor: Anchor, body: string) =>
      api
        .fetch('POST', `/api/boards/${boardId}/threads`, { anchor, body })
        .then((r) => json<{ thread: Thread }>(r, 'POST threads'))
        .then((r) => r.thread),
    reply: (threadId: string, body: string) =>
      api
        .fetch('POST', `/api/threads/${threadId}/comments`, { body })
        .then((r) => json<{ thread: Thread }>(r, 'POST reply'))
        .then((r) => r.thread),
    notifications: () =>
      api
        .fetch('GET', '/api/me/notifications')
        .then((r) =>
          json<{ notifications: NotificationItem[]; unreadCount: number }>(r, 'GET notifications'),
        ),
    /** Earlier tests notify the same people; a test that counts starts from a clean inbox. */
    markAllNotificationsRead: async () => {
      const res = await api.fetch('POST', '/api/me/notifications/read', { all: true })
      if (res.status() >= 300) throw new Error(`mark all read -> ${res.status()}`)
    },
  }
}

/** (u, v) of a stored shape-anchored thread. */
export function uvOf(thread: Thread | null): { u: number; v: number } {
  if (thread?.anchor.kind !== 'shape') throw new Error(`not a shape thread: ${JSON.stringify(thread)}`)
  return { u: thread.anchor.u, v: thread.anchor.v }
}

/** A mention token as the composer sends it (contracts `mentionTokenFor`). */
export const mentionToken = (name: string, userId: string) => `@[${name}](${userId})`

// ---- locators --------------------------------------------------------------------------------------

export const pins = (page: Page) => page.getByTestId('comment-pin')
export const pin = (page: Page, threadId: string) =>
  page.locator(`[data-testid="comment-pin"][data-thread-id="${threadId}"]`)
export const threadPopover = (page: Page, threadId?: string) =>
  threadId
    ? page.locator(`[data-testid="thread-popover"][data-thread-id="${threadId}"]`)
    : page.getByTestId('thread-popover')
export const newCommentPopover = (page: Page) => page.getByTestId('new-comment-popover')
export const commentRow = (page: Page, threadId: string) =>
  page.locator(`[data-testid="comment-row"][data-thread-id="${threadId}"]`)
export const commentItem = (scope: Page | Locator, commentId: string) =>
  scope.locator(`[data-testid="comment-item"][data-comment-id="${commentId}"]`)
export const bell = (page: Page) => page.getByTestId('notifications-bell')
/**
 * A comments toast with an action (mention → View, resolve → Undo): tldraw's own toasts (bottom
 * right), which carry no test id, found by their text.
 */
export const commentToast = (page: Page, text: string) =>
  page.locator('.tlui-toast__container', { hasText: text })

// ---- editor-driven steps ---------------------------------------------------------------------------

export const currentTool = (page: Page) => read(page, (ed) => ed.getCurrentToolId())

/** A note at (x, y) (page space), created by this tab (an editor's). */
export async function createNote(page: Page, id: string, x: number, y: number, text = 'Idea') {
  await edit(
    page,
    (ed, a) => ed.createShape({ id: a.id, type: 'note', x: a.x, y: a.y, props: { richText: a.text } }),
    { id, x, y, text: richText(text) },
  )
}

/** Keyboard focus on the board (as after a click on it), so tldraw shortcuts reach the editor. */
export async function focusCanvas(page: Page) {
  await edit(page, (ed) => (ed as Ed).getContainer().focus())
}

/** Whether keyboard focus is on the editor container itself (where tldraw handles Esc and keys). */
export const canvasHasFocus = (page: Page) =>
  read(page, (ed) => document.activeElement === (ed as Ed).getContainer())

export const currentPageId = (page: Page) => read(page, (ed) => (ed as Ed).getCurrentPageId())

/** Centres the camera on a shape at zoom `z`. */
export async function centerOn(page: Page, shapeId: string, z: number) {
  await edit(
    page,
    (ed, a) => {
      const e = ed as Ed
      const b = e.getShapePageBounds(a.shapeId)
      if (!b) throw new Error(`no shape ${a.shapeId}`)
      const vp = e.getViewportScreenBounds()
      e.setCamera({ x: -(b.x + b.w / 2) + vp.w / 2 / a.z, y: -(b.y + b.h / 2) + vp.h / 2 / a.z, z: a.z })
    },
    { shapeId, z },
  )
}

/** Moves the camera far away from the content near the origin (its pins are culled). */
export async function panAway(page: Page) {
  await edit(page, (ed) => (ed as Ed).setCamera({ x: 20_000, y: 20_000, z: 1 }))
}

/** Presses C and waits for the comment tool. */
export async function pressCommentTool(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('c')
  await expect.poll(() => currentTool(page)).toBe('comment')
}

/** The screen point at (u, v) of a shape's page bounds. */
export async function screenPointOnShape(page: Page, shapeId: string, u: number, v: number) {
  const b = await shapeBounds(page, shapeId)
  if (!b) throw new Error(`shape ${shapeId} has no bounds`)
  return toScreen(page, { x: b.x + u * b.w, y: b.y + v * b.h })
}

/**
 * With the comment tool on: clicks (u, v) of a shape, writes `text` in the new-comment composer,
 * presses Enter and returns the id of the thread whose popover then opens.
 */
export async function commentOnShape(page: Page, shapeId: string, text: string, uv = { u: 0.5, v: 0.5 }) {
  const p = await screenPointOnShape(page, shapeId, uv.u, uv.v)
  return commentAtScreenPoint(page, p, text)
}

export async function commentAtScreenPoint(page: Page, p: VecLike, text: string) {
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

/**
 * A screen point of empty board near the middle of the viewport (away from the dock, top bar and
 * toolbar): the first candidate with no shape within 40 screen px.
 */
export async function emptyCanvasPoint(page: Page): Promise<VecLike> {
  return read(page, (ed) => {
    const e = ed as Ed
    const vp = e.getViewportScreenBounds()
    const cx = vp.x + vp.w / 2
    const cy = vp.y + vp.h / 2
    const offsets = [
      [0, 0],
      [0, 220],
      [0, -200],
      [280, 0],
      [-280, 0],
      [280, 200],
      [-280, 200],
      [280, -200],
      [-280, -200],
    ]
    for (const [dx = 0, dy = 0] of offsets) {
      const screen = { x: cx + dx, y: cy + dy }
      const hits = e.getShapesAtPoint(e.screenToPage(screen), {
        hitInside: true,
        margin: 40 / e.getZoomLevel(),
      })
      if (hits.length === 0) return screen
    }
    throw new Error('no empty spot of board near the viewport centre')
  })
}

/**
 * Where a pin should sit on screen for a shape anchor (u, v of the shape's page bounds, unrotated
 * shapes), and where its pointed bottom-left corner actually is. Both in CSS pixels of the window.
 */
export async function pinPlacement(page: Page, threadId: string, shapeId: string, u: number, v: number) {
  const expected = await screenPointOnShape(page, shapeId, u, v)
  const box = await pin(page, threadId).boundingBox()
  return { expected, actual: box ? { x: box.x, y: box.y + box.height } : null }
}

export async function expectPinOnAnchor(page: Page, threadId: string, shapeId: string, u: number, v: number) {
  await expect
    .poll(
      async () => {
        const { expected, actual } = await pinPlacement(page, threadId, shapeId, u, v)
        if (!actual) return 'no pin'
        return Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y))
      },
      { message: 'distance (px) between the pin corner and its anchor' },
    )
    .toBeLessThanOrEqual(2)
}

/**
 * Waits for the truthful save indicator. Needed before a reload: alone on a board, tldraw sync runs
 * in solo mode and pushes about once a second, so an edit made just before a reload can be lost.
 */
export async function waitForSaved(page: Page) {
  // Two frames first: React has rendered the edit that was just made ("Saving…"). Without them the
  // check can pass on the "Saved" from before that edit and the reload that follows loses it.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved')
}

/** Opens the Comments dock panel (idempotent). */
export async function openCommentsPanel(page: Page) {
  const panel = page.getByTestId('comments-panel')
  if (!(await panel.isVisible())) await page.getByTestId('dock-tab-comments').click()
  await expect(panel).toBeVisible()
  return panel
}
