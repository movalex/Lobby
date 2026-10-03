// The zoom actions (MAK-10: tldraw's zoom-in, zoom-out, zoom-in-on-cursor, zoom-out-on-cursor,
// zoom-to-100, zoom-to-fit, zoom-to-selection) on Lobby's own camera (canvas/api/parts/navigation.ts): the
// zoom menu, the navigation panel's buttons and the keys run these. Fit goes below Excalidraw's 0.1 when
// the board needs it (docs/EXCALIDRAW-MIGRATION.md §4.2, spike A's A14), and so does the zoom wheel
// (`installWheelZoom`, CR 3b-2), a plain mouse wheel that zooms (Preferences ▸ Input device, W5-33) and a
// two-finger touch pinch (CR 3b-10, W5-19).
import type {
  CanvasInputEvent,
  LobbyCanvas,
  ScenePoint,
  TouchPinch,
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

// ---- the two-finger touch pinch below Excalidraw's 0.1 (CR 3b-10, W5-19) ---------------------------------

/**
 * Whether Lobby takes this pinch from the engine: where Excalidraw's own would clamp (it keeps every pinch
 * at or above 0.1, getNormalizedZoom). A pinch that started below 0.1 (the engine would snap it up to 0.1
 * on its first move) or that goes below it, on a board whose whole-board fit is below 0.1.
 */
export function pinchTakenByLobby(
  startZoom: number,
  scale: number,
  limits: Pick<ZoomLimits, 'min'>,
): boolean {
  if (!pinchBelowEngineFloor(startZoom, scale)) return false
  return startZoom < ENGINE_MIN_ZOOM - 1e-6 || limits.min < ENGINE_MIN_ZOOM - 1e-6
}

/**
 * Whether the engine's own pinch would clamp this one: it started below 0.1 or is going below it. Cheap (no
 * board read), so every move can ask before `pinchTakenByLobby` reads the whole-board fit.
 */
export function pinchBelowEngineFloor(startZoom: number, scale: number): boolean {
  if (!(startZoom > 0) || !Number.isFinite(scale) || scale <= 0) return false
  return startZoom * Math.min(1, scale) < ENGINE_MIN_ZOOM - 1e-6
}

/**
 * The zoom a pinch of `scale` (the fingers' distance over their distance at the start) gives from
 * `startZoom`: the engine's own rule (start × scale), within Lobby's limits. Out stops at the whole-board
 * fit, or at the start when that is already below it (it never zooms in on an out gesture); in stops at the
 * engine's top.
 */
export function pinchZoom(startZoom: number, scale: number, limits: Pick<ZoomLimits, 'min'>): number {
  const lo = Math.min(limits.min, startZoom)
  const hi = Math.max(ENGINE_MAX_ZOOM, startZoom)
  return Math.min(hi, Math.max(lo, startZoom * scale))
}

/**
 * The camera at `zoom` that keeps the scene point `anchor` under the fingers' middle, which is at `px` in
 * canvas pixels (the camera's top-left is the scene point at the canvas's top-left).
 */
export const pinchCamera = (anchor: ScenePoint, px: { x: number; y: number }, zoom: number) => ({
  x: anchor.x - px.x / zoom,
  y: anchor.y - px.y / zoom,
  zoom,
})

/** What Lobby keeps of a touch pinch (see `installWheelZoom`). */
interface PinchGesture {
  readonly startZoom: number
  /** the fingers' middle at the last event the engine handled (where Lobby's takeover starts from) */
  last: { x: number; y: number }
  /** once Lobby has the pinch: the scene point under the fingers' middle, and where that is in canvas pixels */
  base: { anchor: ScenePoint; px: { x: number; y: number }; centre: { x: number; y: number } } | null
}

/**
 * Takes what Excalidraw's own wheel and pinch would get wrong, around the pointer or the fingers; everything
 * else stays the engine's. Returns the unsubscribe.
 *
 *  - the zoom wheel and the trackpad pinch (Ctrl/Cmd + wheel) where the engine would snap to 0.1 (`wheelZoom`,
 *    CR 3b-2, W5-19). Events arriving before the engine has applied the previous move build on that move
 *    (the camera is read back only after a render);
 *  - a plain mouse wheel where the Input device preference says it zooms (`plainWheelZooms`, W5-33), at any
 *    zoom: the engine reads Ctrl on the event, so a plain wheel is only ever a pan to it;
 *  - a two-finger touch pinch where the engine would stop at 0.1 (`pinchTakenByLobby`, CR 3b-10). The input
 *    layer (canvas/board/input.ts) says when the second finger lands, how far the fingers have spread and
 *    where their middle is. From the move that goes below the engine's floor, or from the first one of a
 *    pinch that started below it, Lobby holds the gesture to its end, taking those moves from the engine
 *    (`handled()`) and placing the camera itself; the engine keeps every other pinch.
 */
export function installWheelZoom(canvas: LobbyCanvas): () => void {
  let pending: { x: number; y: number; zoom: number; at: number } | null = null
  let pinch: PinchGesture | null = null

  // The camera Lobby last put for a pinch, held for two frames: the engine applies its own last pinch move a
  // flush late (its pinch calls `translate` inside a state updater), over the first camera Lobby sets, so
  // what the engine left is put back once it has landed.
  let held: { x: number; y: number; zoom: number } | null = null
  let rounds = 0
  let frame = 0
  const check = () => {
    frame = 0
    const want = held
    if (!want) return
    const r = canvas.viewport.get()
    if (
      Math.abs(r.zoom - want.zoom) > 1e-9 ||
      Math.abs(r.x - want.x) * r.zoom > 0.01 ||
      Math.abs(r.y - want.y) * r.zoom > 0.01
    )
      canvas.viewport.set(want)
    if (--rounds > 0) frame = requestAnimationFrame(check)
    else held = null
  }
  const hold = (to: { x: number; y: number; zoom: number } | null) => {
    held = to
    rounds = 2
    if (to && !frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(check)
  }

  const touchPinch = (e: WheelInput, t: TouchPinch) => {
    if (t.phase === 'start') {
      hold(null)
      pinch = { startZoom: canvas.viewport.get().zoom, last: e.screen, base: null }
      return
    }
    if (t.phase === 'end') {
      pinch = null
      return
    }
    if (!pinch) return
    if (!pinch.base) {
      if (
        !pinchBelowEngineFloor(pinch.startZoom, t.scale) ||
        !pinchTakenByLobby(pinch.startZoom, t.scale, canvas.viewport.limits())
      ) {
        pinch.last = e.screen
        return
      }
      // the takeover: the camera the engine has left (its last move), the scene point under the fingers'
      // middle then, and where that middle is in canvas pixels
      const read = canvas.viewport.get()
      const anchor = canvas.screenToScene(pinch.last)
      pinch.base = {
        anchor,
        px: { x: (anchor.x - read.x) * read.zoom, y: (anchor.y - read.y) * read.zoom },
        centre: pinch.last,
      }
    }
    e.handled()
    const b = pinch.base
    const px = { x: b.px.x + (e.screen.x - b.centre.x), y: b.px.y + (e.screen.y - b.centre.y) }
    const zoom = pinchZoom(pinch.startZoom, t.scale, canvas.viewport.limits())
    const to = pinchCamera(b.anchor, px, zoom)
    canvas.viewport.set(to)
    hold(to)
  }

  /** A plain wheel event (no Ctrl/Cmd, no Shift) the Input device preference says zooms. */
  const plainZoom = (e: WheelInput): boolean => {
    if (e.type !== 'wheel' || e.ctrl || e.meta || e.shift) return false
    try {
      return plainWheelZooms(canvas.settings.get().wheel, e)
    } catch {
      return false // a canvas without the settings (a unit test's): the engine's pan
    }
  }

  const off = canvas.on('input', (e) => {
    if (e.type === 'pinch' && e.touch) {
      touchPinch(e, e.touch)
      return
    }
    if ((e.type !== 'wheel' && e.type !== 'pinch') || e.deltaY === undefined) return
    const plain = plainZoom(e)
    if (!plain && !isZoomWheel(e)) return
    hold(null)
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
  return () => {
    off()
    held = null
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    frame = 0
  }
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
