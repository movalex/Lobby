// The zoom actions (MAK-10: tldraw's zoom-in, zoom-out, zoom-in-on-cursor, zoom-out-on-cursor,
// zoom-to-100, zoom-to-fit, zoom-to-selection) on Lobby's own camera (canvas/api/parts/navigation.ts): the
// zoom menu, the navigation panel's buttons and the keys run these. Fit goes below Excalidraw's 0.1 when
// the board needs it (docs/EXCALIDRAW-MIGRATION.md §4.2, spike A's A14), and so does the zoom wheel
// (`installWheelZoom`, CR 3b-2) and a plain mouse wheel that zooms (Preferences ▸ Input device, W5-33).
import type {
  CanvasInputEvent,
  LobbyCanvas,
  Viewport,
  WheelPreference,
  ZoomLimits,
} from '../../../../canvas/api/index.ts'
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
 * out at or below Excalidraw's 0.1 on a board whose floor is below it, and any zoom-wheel event while the
 * camera is below 0.1, where the engine's handler would snap to 0.1 or step by +0.1 (6.9% → 16.9%, W5-19).
 * Excalidraw's delta rule (at most ±10 per event, a positive delta zooms out) applied as a ratio, so a step
 * is 10% of the zoom at any zoom. Out never goes below `limits.min` (the whole-board fit) and never zooms in:
 * below the floor (the board shrank, a follow or a stored view put the camera there) it stays put. Null
 * when the engine's own wheel should run: from 0.1 up (zooming in at 0.1 too), at 0.1 on a board that fits
 * at 0.1, no delta.
 */
export function wheelZoom(
  zoom: number,
  e: WheelZoomInput,
  limits: Pick<ZoomLimits, 'min' | 'max'>,
): number | null {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
  const raw = e.deltaY * unit
  if (!raw || !Number.isFinite(raw) || !(zoom > 0)) return null
  const EPS = 1e-6
  const below = zoom < ENGINE_MIN_ZOOM - EPS
  if (raw > 0 && zoom > ENGINE_MIN_ZOOM + EPS) return null
  if (raw > 0 && !below && limits.min >= ENGINE_MIN_ZOOM) return null
  if (raw < 0 && !below) return null
  const delta = Math.min(WHEEL_MAX_DELTA, Math.max(-WHEEL_MAX_DELTA, raw))
  const next = zoom * (1 - delta / 100)
  if (raw > 0) return Math.max(Math.min(limits.min, zoom), next)
  return Math.min(limits.max, Math.max(zoom, next))
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
type WheelInput = Extract<CanvasInputEvent, { type: 'wheel' | 'pinch' }>
const isZoomWheel = (e: CanvasInputEvent): e is WheelInput =>
  (e.type === 'wheel' || e.type === 'pinch') && (e.ctrl || e.meta) && !e.shift

// ---- a plain mouse wheel that zooms (Preferences ▸ Input device, W5-33) --------------------------------------

/** Excalidraw's own top zoom (getNormalizedZoom): its wheel and pinch stop here, so Lobby's do too. */
export const ENGINE_MAX_ZOOM = 30

/** One wheel event as the input device guess reads it. */
export interface WheelShape {
  readonly deltaX?: number
  readonly deltaY?: number
  readonly deltaMode?: number
}

/**
 * Whether a wheel event looks like a notch of a mouse wheel rather than a trackpad's scroll (the Input
 * device preference's `auto`): a wheel that reports lines or pages (Firefox's mouse wheel), or whole
 * hundreds of pixels on the one axis (Chrome's and Edge's mouse wheel: 100 px a notch, 120 on some
 * systems, a multiple of it when turned fast). A trackpad scrolls in small, uneven pixel steps, usually
 * with a sideways part. A guess: the setting says it outright when this one gets a device wrong.
 */
export function looksLikeMouseWheel(e: WheelShape): boolean {
  const dy = e.deltaY ?? 0
  if (!dy || !Number.isFinite(dy) || (e.deltaX ?? 0) !== 0) return false
  if (e.deltaMode === 1 || e.deltaMode === 2) return true
  const a = Math.abs(dy)
  return Number.isInteger(a) && a >= 100 && (a % 100 === 0 || a % 120 === 0)
}

/** Whether a plain wheel event (no Ctrl/Cmd, no Shift) zooms: the preference, or `auto`'s guess. */
export function plainWheelZooms(pref: WheelPreference, e: WheelShape): boolean {
  if (pref === 'mouse') return true
  if (pref === 'trackpad') return false
  return looksLikeMouseWheel(e)
}

/**
 * The zoom after one plain-wheel notch that zooms (the mouse preference), over the whole range: Excalidraw
 * never sees such an event as a zoom (it reads Ctrl on the event), so Lobby steps it, by the same
 * proportional rule as `wheelZoom`: 10% of the zoom a notch, at any zoom, with the engine's most per event.
 * Out stops at `limits.min` (the whole-board fit) and never zooms in; in stops at the engine's top. Null
 * for no delta.
 */
export function wheelZoomStep(
  zoom: number,
  e: WheelZoomInput,
  limits: Pick<ZoomLimits, 'min'>,
): number | null {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
  const raw = e.deltaY * unit
  if (!raw || !Number.isFinite(raw) || !(zoom > 0)) return null
  const delta = Math.min(WHEEL_MAX_DELTA, Math.max(-WHEEL_MAX_DELTA, raw))
  const next = zoom * (1 - delta / 100)
  if (raw > 0) return Math.max(Math.min(limits.min, zoom), next)
  return Math.max(zoom, Math.min(ENGINE_MAX_ZOOM, next))
}

/**
 * Takes what Excalidraw's own wheel would get wrong; everything else stays the engine's. Returns the
 * unsubscribe.
 *
 *  - the zoom wheel and the trackpad pinch (Ctrl/Cmd + wheel) where the engine would snap to 0.1 (`wheelZoom`,
 *    CR 3b-2, W5-19). Events arriving before the engine has applied the previous move build on that move
 *    (the camera is read back only after a render);
 *  - a plain mouse wheel where the Input device preference says it zooms (`plainWheelZooms`, W5-33), at any
 *    zoom: the engine reads Ctrl on the event, so a plain wheel is only ever a pan to it.
 */
export function installWheelZoom(canvas: LobbyCanvas): () => void {
  let pending: { x: number; y: number; zoom: number; at: number } | null = null
  /** A plain wheel event (no Ctrl/Cmd, no Shift) the Input device preference says zooms. */
  const plainZoom = (e: WheelInput): boolean => {
    if (e.type !== 'wheel' || e.ctrl || e.meta || e.shift) return false
    try {
      return plainWheelZooms(canvas.settings.get().wheel, e)
    } catch {
      return false // a canvas without the settings (a unit test's): the engine's pan
    }
  }

  return canvas.on('input', (e) => {
    if ((e.type !== 'wheel' && e.type !== 'pinch') || e.deltaY === undefined) return
    const plain = plainZoom(e)
    if (!plain && !isZoomWheel(e)) return
    const now = performance.now()
    const read = canvas.viewport.get()
    const v = pending && now - pending.at < 120 ? pending : read
    const wheel = { deltaY: e.deltaY, deltaMode: e.deltaMode ?? 0 }
    const limits = canvas.viewport.limits()
    const next = plain ? wheelZoomStep(v.zoom, wheel, limits) : wheelZoom(v.zoom, wheel, limits)
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
