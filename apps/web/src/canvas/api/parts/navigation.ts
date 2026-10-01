/**
 * OWNER: 3b (navigation). The camera members of LobbyCanvas beyond the C0 port: Lobby's own zoom-to and
 * fit camera (below Excalidraw's 0.1 clamp, docs/EXCALIDRAW-MIGRATION.md §4.2), ensure-visible, zoom
 * steps and limits.
 *
 * Composed from the canvas's own members alone (`viewport.get`/`set`, `screenToScene`, `items`, `bounds`,
 * `isHidden`), so they are real on any canvas: the screen size is the viewport's scene size times its
 * zoom, and every move is one `viewport.set` (animated by the board page when `animate` is given, and
 * never under `prefers-reduced-motion: reduce`, W5-21). The camera math is the pure functions below
 * (Node-tested).
 *
 * The zoom Lobby moves to is its own: `zoomTo` and `fit` may go below Excalidraw's 0.1 floor down to the
 * zoom a whole-board fit needs (`limits().min`), as spike A's A14 showed a 9,220-element board needs 0.054
 * in a 1536 × 864 view. `updateScene` accepts such a zoom; only Excalidraw's own wheel and keys clamp to
 * 0.1 (the navigation feature takes the zoom wheel below it, `wheelZoom`).
 *
 * The whole board's bounds come from the elements' own fields (`elementBox`), in one pass: the port's
 * `bounds(id)` builds a map of the whole scene per call, so a union over every item was quadratic (on the
 * heavy board, seconds per fit, per zoom step and at the first view).
 */
import { corners, fromPoints, union } from '../geometry.ts'
import type {
  Bounds,
  CameraMove,
  CanvasElement,
  LobbyViewport,
  ScenePoint,
  ScreenPoint,
  Viewport,
  ZoomLimits,
  ZoomToOptions,
} from '../lobby-canvas.ts'
import type { PartDeps } from './types.ts'

export type NavigationPart = Pick<
  LobbyViewport,
  'zoomTo' | 'centerOn' | 'ensureVisible' | 'zoomStep' | 'limits' | 'fit'
>

// ---- the numbers ------------------------------------------------------------------------------------------

/** The zoom steps of zoom in / zoom out (tldraw's defaults from 0.1 up; the floor below 0.1 is added by `limits`). */
export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 4, 8]
/** Excalidraw's own floor (getNormalizedZoom): its wheel, pinch and keys never go below it. */
export const ENGINE_MIN_ZOOM = 0.1
/** Lobby's moves never go below this, whatever the board's size (a corrupt element far away). */
export const ABSOLUTE_MIN_ZOOM = 0.01
/** The top step: Lobby's moves never zoom in further (Excalidraw's own wheel may, up to 30). */
export const MAX_ZOOM = 8
/** Screen pixels kept free on each side of a zoomed-to rectangle (tldraw's 128 in total). */
export const DEFAULT_INSET = 64

export interface ScreenSize {
  readonly width: number
  readonly height: number
}

/** A camera Lobby installs: the scene point at the canvas's top-left and the zoom. */
export interface CameraTarget {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The screen size of a viewport (its scene size times its zoom). */
export const screenOf = (v: Viewport): ScreenSize => ({ width: v.width * v.zoom, height: v.height * v.zoom })

/**
 * The zoom that shows `bounds` whole with `inset` screen pixels free on each side (no clamp). A
 * zero-sized side counts as 1 scene pixel.
 */
export function fitZoom(bounds: Bounds, screen: ScreenSize, inset = DEFAULT_INSET): number {
  const w = Math.max(1, screen.width - 2 * inset)
  const h = Math.max(1, screen.height - 2 * inset)
  return Math.min(w / Math.max(1, bounds.width), h / Math.max(1, bounds.height))
}

/** The camera that puts scene point `center` in the middle of the canvas at `zoom`. */
export function centeredOn(center: ScenePoint, zoom: number, screen: ScreenSize): CameraTarget {
  return { x: center.x - screen.width / zoom / 2, y: center.y - screen.height / zoom / 2, zoom }
}

/** Lobby's zoom limits for a canvas whose whole-board fit needs `fit` (null: an empty board). */
export function limitsFor(fit: number | null): ZoomLimits {
  const f = fit !== null && Number.isFinite(fit) && fit > 0 ? fit : 1
  const min = clamp(Math.min(ENGINE_MIN_ZOOM, f), ABSOLUTE_MIN_ZOOM, ENGINE_MIN_ZOOM)
  const steps = min < ENGINE_MIN_ZOOM ? [min, ...ZOOM_STEPS] : [...ZOOM_STEPS]
  return { min, max: MAX_ZOOM, steps, fit: f }
}

/**
 * The camera of a zoom-to (tldraw's zoomToBounds): the fit zoom capped at `maxZoom` (default 1: a fit
 * of a few elements is not a magnifier), or exactly `zoom`, clamped to the limits; centred on `bounds`.
 */
export function zoomToCamera(
  bounds: Bounds,
  screen: ScreenSize,
  limits: Pick<ZoomLimits, 'min' | 'max'>,
  opts: Pick<ZoomToOptions, 'inset' | 'zoom' | 'maxZoom'> = {},
): CameraTarget {
  const wanted =
    opts.zoom ?? Math.min(fitZoom(bounds, screen, opts.inset ?? DEFAULT_INSET), opts.maxZoom ?? 1)
  const zoom = clamp(wanted, limits.min, limits.max)
  return centeredOn({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, zoom, screen)
}

/** Share of the canvas a `viewport.fit` fills (the board page's fit, a margin for the chrome). */
export const FIT_FILL = 0.8

/**
 * The camera of `viewport.fit` (the board page's rule: `FIT_FILL` of the canvas, never above 100%), with
 * Lobby's floor instead of Excalidraw's 0.1: `limits.min`, the whole-board fit when that is lower.
 */
export function fitCamera(bounds: Bounds, screen: ScreenSize, limits: Pick<ZoomLimits, 'min'>): CameraTarget {
  const w = Math.max(1, bounds.width)
  const h = Math.max(1, bounds.height)
  const zoom = clamp(Math.min(screen.width / w, screen.height / h) * FIT_FILL, limits.min, 1)
  return centeredOn({ x: bounds.x + w / 2, y: bounds.y + h / 2 }, zoom, screen)
}

type Pt = readonly [number, number]

/**
 * An element's axis-aligned scene box from its own fields: `x`, `y`, `width`, `height` rotated by `angle`
 * about the centre, as Excalidraw rotates elements; a linear element's (arrow, line, freedraw) box of its
 * points, rotated the same way. A superset of the engine's bounds for a curved line (its bulge is inside
 * the points' box only for most curves), and it needs no scene map: one pass over the board is O(n).
 */
export function elementBox(el: CanvasElement): Bounds {
  const points = (el as { points?: readonly Pt[] }).points
  let box: Bounds = { x: el.x, y: el.y, width: el.width, height: el.height }
  if (Array.isArray(points) && points.length) {
    const b = fromPoints(points.map(([px, py]) => ({ x: el.x + px, y: el.y + py })))
    if (b) box = b
  }
  if (!el.angle) return box
  return fromPoints(corners(box, el.angle)) ?? box
}

/** Every live content item's box (bound labels, deleted and `hidden` items left out); null when none. */
export function contentBox(
  elements: readonly CanvasElement[],
  hidden: (id: string) => boolean = () => false,
): Bounds | null {
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const e of elements) {
    if (e.isDeleted || (e.type === 'text' && e.containerId)) continue
    if (hidden(e.id)) continue
    const b = elementBox(e)
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.width)
    y2 = Math.max(y2, b.y + b.height)
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null
}

/**
 * The next zoom step in or out from `zoom` (tldraw's zoomIn / zoomOut: a step past the halfway point is
 * skipped). From below the first step, in is the first step (a camera below Lobby's floor: the board
 * shrank, a follow or a stored view set it; tldraw's loop would skip it).
 */
export function nextZoomStep(zoom: number, steps: readonly number[], direction: 'in' | 'out'): number {
  const n = steps.length
  if (n === 0) return zoom
  if (direction === 'in' && zoom < (steps[0] as number)) return steps[0] as number
  if (direction === 'in') {
    for (let i = 1; i < n; i++) {
      const z1 = steps[i - 1] as number
      const z2 = steps[i] as number
      if (z2 - zoom <= (z2 - z1) / 2) continue
      return z2
    }
    return steps[n - 1] as number
  }
  for (let i = n - 1; i > 0; i--) {
    const z1 = steps[i - 1] as number
    const z2 = steps[i] as number
    if (z2 - zoom >= (z2 - z1) / 2) continue
    return z1
  }
  return steps[0] as number
}

/**
 * The zoom of a zoom-in / zoom-out step from `zoom` within `limits` (W5-19): the next step, clamped, and
 * never the other way: an out step below the floor stays where it is instead of jumping up to it, and an in
 * step above the top one stays too.
 */
export function stepZoom(
  zoom: number,
  limits: Pick<ZoomLimits, 'min' | 'max' | 'steps'>,
  direction: 'in' | 'out',
): number {
  const next = clamp(nextZoomStep(zoom, limits.steps, direction), limits.min, limits.max)
  return direction === 'out' ? Math.min(zoom, next) : Math.max(zoom, next)
}

/** The camera at `zoom` that keeps scene point `at` where it is on screen (a zoom around the pointer). */
export function zoomAround(v: Viewport, at: ScenePoint, zoom: number): CameraTarget {
  const sx = (at.x - v.x) * v.zoom
  const sy = (at.y - v.y) * v.zoom
  return { x: at.x - sx / zoom, y: at.y - sy / zoom, zoom }
}

/**
 * The camera that brings `bounds` wholly on screen with `margin` screen pixels to spare, or null when it
 * already is. A target that fits at the current zoom keeps the zoom and is panned into view (the least
 * move; the margin shrinks to what the view leaves around a target nearly as large as the view, as 3i's
 * `isOnScreen` reads it); only a target larger than the view is zoomed out to (never in, W5-21: Alt+Arrow
 * changed the zoom for an item that fitted).
 */
export function ensureVisibleCamera(
  v: Viewport,
  bounds: Bounds,
  margin: number,
  limits: Pick<ZoomLimits, 'min' | 'max'>,
): CameraTarget | null {
  const m = margin / v.zoom
  const mx = Math.min(m, Math.max(0, (v.width - bounds.width) / 2))
  const my = Math.min(m, Math.max(0, (v.height - bounds.height) / 2))
  // half a screen pixel of slack: a target just centred is not moved again by float noise
  const eps = 0.5 / v.zoom
  const inside =
    bounds.x >= v.x + mx - eps &&
    bounds.y >= v.y + my - eps &&
    bounds.x + bounds.width <= v.x + v.width - mx + eps &&
    bounds.y + bounds.height <= v.y + v.height - my + eps
  if (inside) return null
  if (bounds.width > v.width || bounds.height > v.height) {
    // never in: below the floor (a camera set below it) the floor is the zoom now
    const lo = { min: Math.min(limits.min, v.zoom), max: limits.max }
    return zoomToCamera(bounds, screenOf(v), lo, { inset: margin, maxZoom: v.zoom })
  }
  // pan the least: only along the axes where the target sticks out
  const shift = (lo: number, size: number, vlo: number, vsize: number, mm: number) => {
    if (lo < vlo + mm) return lo - mm - vlo
    if (lo + size > vlo + vsize - mm) return lo + size + mm - (vlo + vsize)
    return 0
  }
  return {
    x: v.x + shift(bounds.x, bounds.width, v.x, v.width, mx),
    y: v.y + shift(bounds.y, bounds.height, v.y, v.height, my),
    zoom: v.zoom,
  }
}

// ---- reduced motion (W5-21) ---------------------------------------------------------------------------------

/** Whether the person asked for less motion (the `prefers-reduced-motion: reduce` media query). */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

/**
 * A camera move as the person asked for it: with reduced motion every animated move is an immediate one
 * (WCAG 2.3.3; tldraw's `animationSpeed` 0), the rest of the options kept.
 */
export function cameraMove<T extends CameraMove>(opts: T | undefined, reduced: boolean): T | undefined {
  if (!opts?.animate || !reduced) return opts
  return { ...opts, animate: false }
}

// ---- the part ---------------------------------------------------------------------------------------------

export function createNavigationPart(deps: PartDeps): NavigationPart {
  const canvas = () => deps.self()
  // W5-21: every move of these members honours reduced motion (Ctrl+=, Ctrl+-, fit, go to frame, the
  // search panel, the minimap, 3i's Alt+Arrow through ensureVisible)
  const move = (to: CameraTarget, opts?: CameraMove) =>
    canvas().viewport.set({ x: to.x, y: to.y, zoom: to.zoom }, cameraMove(opts, prefersReducedMotion()))

  /** Every live item's box, hidden (collapsed) ones and bound labels left out; null for an empty board. */
  const contentBounds = (): Bounds | null => {
    const c = canvas()
    return contentBox(c.items(), (id) => c.isHidden(id))
  }

  const limits = (): ZoomLimits => {
    const v = canvas().viewport.get()
    const b = contentBounds()
    return limitsFor(b ? fitZoom(b, screenOf(v)) : null)
  }

  /** The boxes of `ids` (a few: the engine's own bounds; many: the elements' own fields, in one pass). */
  const boundsOfIds = (ids: readonly string[]): Bounds | null => {
    const c = canvas()
    if (ids.length <= 16) return union(ids.map((id) => c.bounds(id)))
    const byId = new Map(c.items().map((e) => [e.id, e]))
    return union(ids.map((id) => byId.get(id)).map((e) => (e && !e.isDeleted ? elementBox(e) : null)))
  }

  const targetBounds = (target: Bounds | readonly string[]): Bounds | null =>
    Array.isArray(target) ? boundsOfIds(target as readonly string[]) : (target as Bounds)

  return {
    fit(ids, opts) {
      const b = ids?.length ? boundsOfIds(ids) : contentBounds()
      if (!b) return
      const v = canvas().viewport.get()
      move(fitCamera(b, screenOf(v), limits()), opts)
    },
    zoomTo(bounds, opts) {
      const v = canvas().viewport.get()
      move(zoomToCamera(bounds, screenOf(v), limits(), opts), opts)
    },
    centerOn(point, opts) {
      const v = canvas().viewport.get()
      move(centeredOn(point, v.zoom, screenOf(v)), opts)
    },
    ensureVisible(target, opts) {
      const b = targetBounds(target)
      if (!b) return
      const to = ensureVisibleCamera(canvas().viewport.get(), b, opts?.margin ?? 16, limits())
      if (to) move(to, opts)
    },
    zoomStep(direction, at, opts) {
      const c = canvas()
      const v = c.viewport.get()
      const zoom = stepZoom(v.zoom, limits(), direction)
      // at the floor (or the top) a step changes nothing: no move, no animation
      if (Math.abs(zoom - v.zoom) < 1e-9) return
      const pivot: ScenePoint = at
        ? c.screenToScene(at as ScreenPoint)
        : { x: v.x + v.width / 2, y: v.y + v.height / 2 }
      move(zoomAround(v, pivot, zoom), opts)
    },
    limits,
  }
}
