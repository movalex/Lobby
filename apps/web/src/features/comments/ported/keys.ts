// OWNER: 3c. The comments feature's keys on the Excalidraw board page (docs/EXCALIDRAW-CONTRACTS.md §1 rule 8:
// declared, dispatched by the board page's key layer). As on the tldraw page:
// - C selects the comment tool and Shift+C hides or shows the markers (for me only); both work on a
//   read-only canvas (./index.tsx commands);
// - with the comment tool on: Enter comments on the selection (the middle of the view when nothing is
//   selected), Esc closes what is open and then returns to the select tool, and (PRI-14, A11Y2-04)
//   Tab / Shift+Tab step through the board's objects in reading order, Ctrl/Cmd+Shift+↓ goes inside the
//   selected frame and Ctrl/Cmd+Shift+↑ back out, so "C, Tab…, Enter" comments on an object without a
//   mouse.

import type { CommentAnchor } from '@draftroom/contracts'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  items as elementsApi,
  type FeatureKeySpec,
  type LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { COMMENT_TOOL_ID, controllerFor } from './controller.ts'
import { anchorForKeyboard, anchorPoint, revealAnchor } from './geometry.ts'

const inTool = (ctx: CanvasFeatureContext) => ctx.canvas.tool() === COMMENT_TOOL_ID

/** Reading order: top to bottom, then left to right (ties by id, so the order is stable). */
export function readingOrder(els: readonly CanvasElement[]): CanvasElement[] {
  return [...els].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The steppable objects that share `frameId` (null: the board's top level), hidden ones left out. */
function siblings(canvas: LobbyCanvas, frameId: string | null): CanvasElement[] {
  return readingOrder(
    elementsApi
      .contentItems(canvas.items())
      .filter((e) => (e.frameId ?? null) === frameId && !canvas.isHidden(e.id)),
  )
}

/** The selected object (a bound label counts as its container), or null. */
function selected(canvas: LobbyCanvas): CanvasElement | null {
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (el && !el.isDeleted) return elementsApi.containerOf(el, (x) => canvas.get(x))
  }
  return null
}

/** Selects `el` and brings it into view when it is not on screen. */
function selectAndShow(canvas: LobbyCanvas, el: CanvasElement) {
  canvas.select([el.id])
  const v = canvas.viewport.get()
  const inside =
    el.x >= v.x && el.y >= v.y && el.x + el.width <= v.x + v.width && el.y + el.height <= v.y + v.height
  if (inside) return
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  canvas.viewport.set({ x: cx - v.width / 2, y: cy - v.height / 2 }, { animate: true })
}

/** Tab / Shift+Tab: the next or previous object in reading order among the selection's siblings. */
export function stepSelection(canvas: LobbyCanvas, dir: 'next' | 'prev'): boolean {
  const current = selected(canvas)
  const list = siblings(canvas, current?.frameId ?? null)
  if (!list.length) return false
  const i = current ? list.findIndex((e) => e.id === current.id) : -1
  const next =
    i < 0
      ? dir === 'next'
        ? list[0]
        : list[list.length - 1]
      : list[(i + (dir === 'next' ? 1 : -1) + list.length) % list.length]
  if (next) selectAndShow(canvas, next)
  return true
}

/** Ctrl/Cmd+Shift+↓: the first object inside the selected frame; ↑: the frame of the selected object. */
export function stepLevel(canvas: LobbyCanvas, dir: 'in' | 'out'): boolean {
  const current = selected(canvas)
  if (!current) return false
  if (dir === 'out') {
    const frame = current.frameId ? canvas.get(current.frameId) : undefined
    if (frame && !frame.isDeleted) selectAndShow(canvas, frame)
    return true
  }
  if (current.type !== 'frame') return true
  const first = siblings(canvas, current.id)[0]
  if (first) selectAndShow(canvas, first)
  return true
}

/** Enter in the comment tool (and the context menu's "Comment"): a new thread on the selection. */
export function placeCommentFromKeyboard(ctx: CanvasFeatureContext, on?: CommentAnchor) {
  const { store } = controllerFor(ctx)
  if (!store.canComment.get()) return
  const anchor = on ?? anchorForKeyboard(ctx.canvas)
  store.startNewThread(anchor)
  // The selected object may be out of view (keyboard users step through the board).
  const point = anchorPoint(ctx.canvas, anchor)
  const v = ctx.canvas.viewport.get()
  if (point && !(point.x >= v.x && point.y >= v.y && point.x <= v.x + v.width && point.y <= v.y + v.height))
    revealAnchor(ctx.canvas, anchor)
}

export const COMMENT_TOOL_KEYS: readonly FeatureKeySpec[] = [
  {
    id: 'comments.tool-enter',
    scope: 'canvas',
    chords: ['enter'],
    match: (_e, ctx) => inTool(ctx) && !ctx.canvas.pointer()?.down,
    handle: (_e, ctx) => {
      placeCommentFromKeyboard(ctx)
      return true
    },
  },
  {
    id: 'comments.tool-escape',
    scope: 'canvas',
    chords: ['escape'],
    match: (_e, ctx) => inTool(ctx),
    handle: (_e, ctx) => {
      if (!controllerFor(ctx).store.closeAll()) ctx.canvas.setTool('select')
      return true
    },
  },
  {
    id: 'comments.tool-tab',
    scope: 'canvas',
    chords: ['tab', 'shift+tab'],
    match: (_e, ctx) => inTool(ctx),
    handle: (e, ctx) => stepSelection(ctx.canvas, e.shiftKey ? 'prev' : 'next'),
  },
  {
    id: 'comments.tool-level',
    scope: 'canvas',
    chords: ['mod+shift+arrowdown', 'mod+shift+arrowup'],
    match: (_e, ctx) => inTool(ctx),
    handle: (e, ctx) => stepLevel(ctx.canvas, e.key === 'ArrowDown' ? 'in' : 'out'),
  },
]
