// OWNER: WS2 (wave S, compare). The pure geometry of compare (docs/WAVE-S-CONTRACTS.md §3.3): fitting two versions
// into one box (letterboxed when their proportions differ), the slider's clip, and the zoom and pan the side-by-side
// panes share. No DOM: unit-tested in geometry.test.ts.

export interface Size {
  readonly w: number
  readonly h: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** `content` fitted inside `box` without cropping, centred (object-fit: contain). An unknown size fills the box. */
export function fitBox(content: Size | null, box: Size): Rect {
  if (!content || !(content.w > 0) || !(content.h > 0) || !(box.w > 0) || !(box.h > 0))
    return { x: 0, y: 0, w: Math.max(0, box.w), h: Math.max(0, box.h) }
  const s = Math.min(box.w / content.w, box.h / content.h)
  const w = content.w * s
  const h = content.h * s
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h }
}

/** Whether two pictures have the same proportions (within 1 %): otherwise the slider says they are letterboxed. */
export function sameAspect(a: Size | null, b: Size | null, tolerance = 0.01): boolean {
  if (!a || !b || !(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return true
  const ra = a.w / a.h
  const rb = b.w / b.h
  return Math.abs(ra - rb) / Math.max(ra, rb) <= tolerance
}

/**
 * The box both versions share in the slider and onion skin: A's proportions fitted in `frame` (B is fitted inside it,
 * letterboxed when its proportions differ: sameAspect says so). Without A's size, B's; without either, the frame.
 */
export function sharedBox(a: Size | null, b: Size | null, frame: Size): Size {
  const fitted = fitBox(a && a.w > 0 && a.h > 0 ? a : b, frame)
  return { w: fitted.w, h: fitted.h }
}

export const clampPercent = (p: number) => (Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 50)

/** The slider's clip of the top version (B): it shows right of the divider at `percent` (0: all B, 100: all A). */
export const sliderClip = (percent: number) => `inset(0 0 0 ${clampPercent(percent)}%)`

/** The divider's percent for a pointer at `clientX` over a box starting at `left`, `width` wide. */
export function percentAt(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 50
  return clampPercent(((clientX - left) / width) * 100)
}

// ---- side by side: one zoom and pan for both panes -----------------------------------------------------------

export interface View {
  /** 1 = fitted */
  readonly zoom: number
  /** the content's offset in pane pixels (at this zoom) */
  readonly x: number
  readonly y: number
}

export const FIT: View = { zoom: 1, x: 0, y: 0 }
export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/**
 * Zooms by `factor` keeping the pane point `at` (pixels from the pane's top-left) where it is. Back at the fitted
 * zoom, the view is centred again.
 */
export function zoomAt(view: View, factor: number, at: { x: number; y: number }): View {
  const zoom = clampZoom(view.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1))
  if (zoom === MIN_ZOOM) return FIT
  const k = zoom / view.zoom
  return { zoom, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }
}

/** Pans by (dx, dy) pane pixels; the content never leaves the pane (at most its overflow on each side). */
export function panBy(view: View, dx: number, dy: number, pane: Size): View {
  if (view.zoom <= MIN_ZOOM) return FIT
  const maxX = 0
  const minX = pane.w - pane.w * view.zoom
  const maxY = 0
  const minY = pane.h - pane.h * view.zoom
  return {
    zoom: view.zoom,
    x: Math.min(maxX, Math.max(minX, view.x + dx)),
    y: Math.min(maxY, Math.max(minY, view.y + dy)),
  }
}

export const viewTransform = (v: View) => `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
