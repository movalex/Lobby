// The navigation feature's camera moves on the canvas (the tldraw build's FramesPanel goToFrame,
// start-view-runtime's fitContent/showFrame, SearchPanel's goToShape): Lobby's own camera through
// `LobbyCanvas.viewport` (3b's part, canvas/api/parts/navigation.ts), so a whole board fits below
// Excalidraw's 0.1 floor. The pure rules stay the tldraw build's (placement.ts frameCamera, start-view.ts).
import { type Bounds, geometry, items, type LobbyCanvas } from '../../../../canvas/api/index.ts'
import { frameCamera, type Insets } from '../../placement.ts'
import {
  PHONE_CANVAS_MAX_W,
  PHONE_FRAME_INSET,
  phoneFrameCamera,
  prefersFirstFrame,
} from '../../start-view.ts'
import { frameRows } from './model.ts'

/** A tldraw camera (screen = (page + camera) * z) as the viewport Lobby sets: the scene's top-left and zoom. */
export const fromTldrawCamera = (c: { x: number; y: number; z: number }) => ({ x: -c.x, y: -c.y, zoom: c.z })

/** The canvas's size on screen (CSS pixels). */
export function screenSize(canvas: LobbyCanvas): { w: number; h: number } {
  const v = canvas.viewport.get()
  return { w: v.width * v.zoom, h: v.height * v.zoom }
}

/** Every live item's bounds (bound labels and hidden, collapsed items left out), or null for an empty board. */
export function contentBounds(canvas: LobbyCanvas): Bounds | null {
  return geometry.union(
    items
      .contentItems(canvas.items())
      .filter((e) => !canvas.isHidden(e.id))
      .map((e) => canvas.bounds(e.id)),
  )
}

/** Whether any content item is (at least partly) on screen. */
export function viewportHasContent(canvas: LobbyCanvas): boolean {
  const v = canvas.viewport.get()
  const view = { x: v.x, y: v.y, width: v.width, height: v.height }
  for (const e of items.contentItems(canvas.items())) {
    if (canvas.isHidden(e.id)) continue
    const b = canvas.bounds(e.id)
    if (b && geometry.intersects(view, b)) return true
  }
  return false
}

/**
 * How much of the canvas the board's chrome covers on each side (screen px), as the tldraw build measured
 * its top-left column and bottom row: the board menu's host slot at the top, the toolbar's and the
 * navigation panel's at the bottom, and the dock panel when it overlaps the canvas (narrow layouts).
 */
export function uiInsets(canvas: LobbyCanvas): Insets {
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
  const root = canvas.container()
  if (!root) return insets
  const c = root.getBoundingClientRect()
  const rect = (el: Element | null) => {
    const r = el?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? r : null
  }
  const slotRects = (name: string) =>
    [...root.querySelectorAll(`[data-lobby-slot="${name}"] > *`)].flatMap((el) => {
      const r = rect(el)
      return r ? [r] : []
    })
  for (const r of slotRects('mainMenu')) insets.top = Math.max(insets.top, r.bottom - c.top)
  let bottomEdge = c.bottom
  for (const r of [...slotRects('toolbar'), ...slotRects('navigation')])
    bottomEdge = Math.min(bottomEdge, r.top)
  insets.bottom = Math.max(0, c.bottom - bottomEdge)
  const dock = rect(root.ownerDocument.querySelector('.dr-dock'))
  if (dock && dock.right > c.left && dock.left < c.left + c.width / 2) {
    insets.left = Math.max(0, dock.right - c.left)
  }
  return insets
}

const onPhone = (canvas: LobbyCanvas) => screenSize(canvas).w <= PHONE_CANVAS_MAX_W

/**
 * PRI-10: a frame and its heading across the part of the canvas the chrome leaves free, never above
 * 100%, animated (the Frames panel's "go to frame").
 */
export function goToFrameCamera(canvas: LobbyCanvas, id: string, animate = true): boolean {
  const b = canvas.bounds(id)
  if (!b) return false
  const limits = canvas.viewport.limits()
  const camera = frameCamera(
    { x: b.x, y: b.y, w: b.width, h: b.height },
    screenSize(canvas),
    uiInsets(canvas),
    { minZoom: limits.min, maxZoom: Math.min(1, limits.max) },
  )
  const move = animate ? { animate: { durationMs: 280 } } : {}
  if (camera) canvas.viewport.set(fromTldrawCamera(camera), move)
  else canvas.viewport.zoomTo(b, { inset: 24, maxZoom: 1, ...move })
  return true
}

/** A frame across the screen with a margin (a small one on a phone), never above 100% (the first view). */
export function showFrame(canvas: LobbyCanvas, id: string, animate: boolean): boolean {
  const b = canvas.bounds(id)
  if (!b) return false
  const move = animate ? { animate: true } : {}
  if (onPhone(canvas)) {
    // R13: a frame far wider than the phone opens at its left end, readable, not as a thin strip
    const s = screenSize(canvas)
    const camera = phoneFrameCamera(
      { x: b.x, y: b.y, w: b.width, h: b.height },
      { w: s.w, h: s.h },
      PHONE_FRAME_INSET,
    )
    if (camera) {
      canvas.viewport.set(fromTldrawCamera(camera), move)
      return true
    }
  }
  canvas.viewport.zoomTo(b, { maxZoom: 1, inset: (onPhone(canvas) ? PHONE_FRAME_INSET : 48) / 2, ...move })
  return true
}

/** The board's first frame in presentation order (a skipped one only when all are). */
export function firstFrame(canvas: LobbyCanvas): string | null {
  const rows = frameRows(canvas.items())
  return (rows.find((r) => !r.skip) ?? rows[0])?.id ?? null
}

/**
 * What a first visit without a start view shows: all content (never zoomed in past 100%), or its first
 * frame where the whole board would not be readable (a phone; a board that fits only below a readable
 * zoom): F15, DANA-06.
 */
export function fitContent(canvas: LobbyCanvas, animate = false): 'fit' | 'first-frame' | 'none' {
  const bounds = contentBounds(canvas)
  if (!bounds) return 'none'
  const screen = screenSize(canvas)
  const minZoom = canvas.viewport.limits().min
  if (
    prefersFirstFrame({ screen, content: { w: bounds.width, h: bounds.height }, minZoom, hasFrame: true })
  ) {
    const frame = firstFrame(canvas)
    if (frame && showFrame(canvas, frame, animate)) return 'first-frame'
  }
  canvas.viewport.zoomTo(bounds, { maxZoom: 1, ...(animate ? { animate: true } : {}) })
  return 'fit'
}
