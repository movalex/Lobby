// The zoom actions (MAK-10: tldraw's zoom-in, zoom-out, zoom-in-on-cursor, zoom-out-on-cursor,
// zoom-to-100, zoom-to-fit, zoom-to-selection) on Lobby's own camera (canvas/api/parts/navigation.ts): the
// zoom menu, the navigation panel's buttons and the keys run these. Fit goes below Excalidraw's 0.1 when
// the board needs it (docs/EXCALIDRAW-MIGRATION.md §4.2, spike A's A14), and so does the zoom wheel
// (`installWheelZoom`, CR 3b-2).
import type { CanvasInputEvent, LobbyCanvas, Viewport, ZoomLimits } from '../../../../canvas/api/index.ts'
import { contentBounds } from './camera.ts'

const ANIMATE = { animate: true } as const

export const zoomIn = (canvas: LobbyCanvas) => canvas.viewport.zoomStep('in', undefined, ANIMATE)
export const zoomOut = (canvas: LobbyCanvas) => canvas.viewport.zoomStep('out', undefined, ANIMATE)

/** tldraw's zoom-in/out-on-cursor (Shift+= / Shift+-): a step around the pointer (the centre when it is off the canvas). */
export function zoomAtPointer(canvas: LobbyCanvas, direction: 'in' | 'out') {
  const p = canvas.pointer()
  canvas.viewport.zoomStep(direction, p?.overCanvas ? p.screen : undefined, ANIMATE)
}

// ---- the zoom wheel below Excalidraw's 0.1 (§4.2 "Lobby's capture wheel listener", CR 3b-2) --------------

/** Excalidraw's own zoom floor (getNormalizedZoom): its wheel snaps any zoom below it back to it. */
export const ENGINE_MIN_ZOOM = 0.1
/** Excalidraw's largest zoom delta per wheel event (ZOOM_STEP × 100: a mouse notch is one 10% step). */
export const WHEEL_MAX_DELTA = 10

/** One zoom-wheel event as the engine reads it (the `wheel`/`pinch` input event's CR 3b-2 fields). */
export interface WheelZoomInput {
  readonly deltaY: number
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages */
  readonly deltaMode: number
}

/**
 * The zoom after one zoom-wheel event (Ctrl/Cmd + wheel, a trackpad pinch) when Lobby takes it: zooming
 * out at or below Excalidraw's 0.1, or zooming in from below it, where the engine's handler would snap to
 * 0.1. Excalidraw's delta rule (at most ±10 per event, a positive delta zooms out) applied as a ratio, so a
 * step is 10% of the zoom at any zoom; the floor is `limits.min` (the whole-board fit). Null when the
 * engine's own wheel should run: from 0.1 up, a board that fits at 0.1 (no floor below it), no delta.
 */
export function wheelZoom(
  zoom: number,
  e: WheelZoomInput,
  limits: Pick<ZoomLimits, 'min' | 'max'>,
): number | null {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
  const raw = e.deltaY * unit
  if (!raw || !Number.isFinite(raw) || limits.min >= ENGINE_MIN_ZOOM) return null
  const EPS = 1e-6
  if (raw > 0 && zoom > ENGINE_MIN_ZOOM + EPS) return null
  if (raw < 0 && zoom >= ENGINE_MIN_ZOOM - EPS) return null
  const delta = Math.min(WHEEL_MAX_DELTA, Math.max(-WHEEL_MAX_DELTA, raw))
  return Math.min(limits.max, Math.max(limits.min, zoom * (1 - delta / 100)))
}

/** The camera at `zoom` that keeps scene point `at` where it is on screen. */
export const zoomAroundPoint = (
  v: Pick<Viewport, 'x' | 'y' | 'zoom'>,
  at: { x: number; y: number },
  zoom: number,
) => ({
  x: at.x - ((at.x - v.x) * v.zoom) / zoom,
  y: at.y - ((at.y - v.y) * v.zoom) / zoom,
  zoom,
})

/** A zoom-wheel event (Ctrl/Cmd, no Shift: Shift pans), as Excalidraw's handler tells zoom from pan. */
const isZoomWheel = (e: CanvasInputEvent): e is Extract<CanvasInputEvent, { type: 'wheel' | 'pinch' }> =>
  (e.type === 'wheel' || e.type === 'pinch') && (e.ctrl || e.meta) && !e.shift

/**
 * Takes the zoom wheel and the trackpad pinch where Excalidraw's own would snap to 0.1 (`wheelZoom`),
 * zooming around the pointer; everything else stays the engine's. Events arriving before the engine has
 * applied the previous move build on that move (the camera is read back only after a render). Returns
 * the unsubscribe.
 */
export function installWheelZoom(canvas: LobbyCanvas): () => void {
  let pending: { x: number; y: number; zoom: number; at: number } | null = null
  return canvas.on('input', (e) => {
    if (!isZoomWheel(e) || e.deltaY === undefined) return
    const now = performance.now()
    const read = canvas.viewport.get()
    const v = pending && now - pending.at < 120 ? pending : read
    const next = wheelZoom(
      v.zoom,
      { deltaY: e.deltaY, deltaMode: e.deltaMode ?? 0 },
      canvas.viewport.limits(),
    )
    if (next === null) {
      pending = null
      return
    }
    e.handled()
    if (Math.abs(next - v.zoom) < 1e-9) return
    // the pointer in canvas pixels (read on the engine's camera), then the scene point under it on the
    // camera this move starts from
    const s = canvas.screenToScene(e.screen)
    const px = (s.x - read.x) * read.zoom
    const py = (s.y - read.y) * read.zoom
    const to = zoomAroundPoint(v, { x: v.x + px / v.zoom, y: v.y + py / v.zoom }, next)
    pending = { ...to, at: now }
    canvas.viewport.set(to)
  })
}

/** 100% around the view's centre (tldraw's resetZoom). */
export function zoomTo100(canvas: LobbyCanvas) {
  const v = canvas.viewport.get()
  canvas.viewport.zoomTo(
    { x: v.x + v.width / 2, y: v.y + v.height / 2, width: 0, height: 0 },
    { zoom: 1, ...ANIMATE },
  )
}

/** Every item in view (tldraw's zoomToFit: it may zoom in on a small board, up to the top step). */
export function zoomToFit(canvas: LobbyCanvas) {
  const b = contentBounds(canvas)
  if (b) canvas.viewport.zoomTo(b, { maxZoom: canvas.viewport.limits().max, ...ANIMATE })
}

/**
 * tldraw's zoomToSelection: 100% centred on the selection (zooming out when it does not fit), or, when
 * already at 100%, the selection fitted (which may zoom in).
 */
export function zoomToSelection(canvas: LobbyCanvas) {
  const b = canvas.selection.length ? canvas.boundsOf(canvas.selection) : null
  if (!b) return
  const atHundred = Math.abs(canvas.viewport.get().zoom - 1) < 0.01
  canvas.viewport.zoomTo(b, { maxZoom: atHundred ? canvas.viewport.limits().max : 1, ...ANIMATE })
}

/**
 * The single unlocked note a printable key types into (type-to-edit, COL-04): a navigation key that is a
 * printable character (M, =, -, Shift+1…) leaves it to type-to-edit then, as on the tldraw board.
 */
export function typeToEditTarget(canvas: LobbyCanvas): boolean {
  if (canvas.readOnly() || canvas.editingId() !== null || canvas.selection.length !== 1) return false
  const el = canvas.get(canvas.selection[0] as string)
  return !!el && el.type === 'stickynote' && !canvas.isLocked(el.id)
}
