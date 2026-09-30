/**
 * OWNER: 3b (navigation). The camera members of LobbyCanvas beyond the C0 port: Lobby's own zoom-to and
 * fit camera (below Excalidraw's 0.1 clamp, docs/EXCALIDRAW-MIGRATION.md §4.2), ensure-visible, zoom
 * steps and limits.
 *
 * Composed from the canvas's own members alone (`viewport.get`/`set`, `screenToScene`, `items`, `bounds`,
 * `isHidden`), so they are real on any canvas: the screen size is the viewport's scene size times its
 * zoom, and every move is one `viewport.set` (animated by the board page when `animate` is given). The
 * camera math is the pure functions below (Node-tested).
 *
 * The zoom Lobby moves to is its own: `zoomTo` may go below Excalidraw's 0.1 floor down to the zoom a
 * whole-board fit needs (`limits().min`), as spike A's A14 showed a 9,220-element board needs 0.054 in a
 * 1536 × 864 view. `updateScene` accepts such a zoom; only Excalidraw's own wheel and keys clamp to 0.1.
 */
import { union } from '../geometry.ts'
import { contentItems } from '../items.ts'
import type {
  Bounds,
  CameraMove,
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
  'zoomTo' | 'centerOn' | 'ensureVisible' | 'zoomStep' | 'limits'
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
  const wanted = opts.zoom ?? Math.min(fitZoom(bounds, screen, opts.inset ?? DEFAULT_INSET), opts.maxZoom ?? 1)
  const zoom = clamp(wanted, limits.min, limits.max)
  return centeredOn({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, zoom, screen)
}

/** The next zoom step in or out from `zoom` (tldraw's zoomIn / zoomOut: a step past the halfway point is skipped). */
export function nextZoomStep(zoom: number, steps: readonly number[], direction: 'in' | 'out'): number {
  const n = steps.length
  if (n === 0) return zoom
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

/** The camera at `zoom` that keeps scene point `at` where it is on screen (a zoom around the pointer). */
export function zoomAround(v: Viewport, at: ScenePoint, zoom: number): CameraTarget {
  const sx = (at.x - v.x) * v.zoom
  const sy = (at.y - v.y) * v.zoom
  return { x: at.x - sx / zoom, y: at.y - sy / zoom, zoom }
}

/**
 * The camera that brings `bounds` wholly on screen with `margin` screen pixels to spare, or null when it
 * already is. A target that fits at the current zoom is panned into view (the least move); a larger one
 * is zoomed out to (never in).
 */
export function ensureVisibleCamera(
  v: Viewport,
  bounds: Bounds,
  margin: number,
  limits: Pick<ZoomLimits, 'min' | 'max'>,
): CameraTarget | null {
  const m = margin / v.zoom
  const inside =
    bounds.x >= v.x + m &&
    bounds.y >= v.y + m &&
    bounds.x + bounds.width <= v.x + v.width - m &&
    bounds.y + bounds.height <= v.y + v.height - m
  if (inside) return null
  const screen = screenOf(v)
  if (bounds.width + 2 * m > v.width || bounds.height + 2 * m > v.height) {
    return zoomToCamera(bounds, screen, limits, { inset: margin, maxZoom: v.zoom })
  }
  // pan the least: only along the axes where the target sticks out
  const shift = (lo: number, size: number, vlo: number, vsize: number) => {
    if (lo < vlo + m) return lo - m - vlo
    if (lo + size > vlo + vsize - m) return lo + size + m - (vlo + vsize)
    return 0
  }
  return {
    x: v.x + shift(bounds.x, bounds.width, v.x, v.width),
    y: v.y + shift(bounds.y, bounds.height, v.y, v.height),
    zoom: v.zoom,
  }
}

// ---- the part ---------------------------------------------------------------------------------------------

export function createNavigationPart(deps: PartDeps): NavigationPart {
  const canvas = () => deps.self()
  const move = (to: CameraTarget, opts?: CameraMove) =>
    canvas().viewport.set({ x: to.x, y: to.y, zoom: to.zoom }, opts)

  /** Every live item's bounds, hidden (collapsed) ones and bound labels left out; null for an empty board. */
  const contentBounds = (): Bounds | null => {
    const c = canvas()
    return union(
      contentItems(c.items())
        .filter((e) => !c.isHidden(e.id))
        .map((e) => c.bounds(e.id)),
    )
  }

  const limits = (): ZoomLimits => {
    const v = canvas().viewport.get()
    const b = contentBounds()
    return limitsFor(b ? fitZoom(b, screenOf(v)) : null)
  }

  const targetBounds = (target: Bounds | readonly string[]): Bounds | null => {
    if (!Array.isArray(target)) return target as Bounds
    const c = canvas()
    return union((target as readonly string[]).map((id) => c.bounds(id)))
  }

  return {
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
      const l = limits()
      const zoom = clamp(nextZoomStep(v.zoom, l.steps, direction), l.min, l.max)
      const pivot: ScenePoint = at
        ? c.screenToScene(at as ScreenPoint)
        : { x: v.x + v.width / 2, y: v.y + v.height / 2 }
      move(zoomAround(v, pivot, zoom), opts)
    },
    limits,
  }
}
