/**
 * Plain scene-space geometry for features (docs/EXCALIDRAW-CONTRACTS.md §5): the replacement for
 * tldraw's `Box`, `Vec` and `Mat` in feature code. Excalidraw has no parent spaces (every element's
 * `x`, `y` are scene coordinates, and frames do not transform their children), so features need only
 * rectangles and points. Pure, frozen at wave 1.
 */
import type { Bounds, ScenePoint } from '../port.ts'

export type { Bounds, ScenePoint }

export const rect = (x: number, y: number, width: number, height: number): Bounds => ({ x, y, width, height })

export const center = (r: Bounds): ScenePoint => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

export const maxX = (r: Bounds) => r.x + r.width
export const maxY = (r: Bounds) => r.y + r.height

/** The smallest rectangle holding every point (null for none). */
export function fromPoints(points: readonly ScenePoint[]): Bounds | null {
  if (points.length === 0) return null
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const p of points) {
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x)
    y2 = Math.max(y2, p.y)
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/** The smallest rectangle holding every rectangle (null for none). */
export function union(rects: readonly (Bounds | null | undefined)[]): Bounds | null {
  const pts: ScenePoint[] = []
  for (const r of rects) {
    if (!r) continue
    pts.push({ x: r.x, y: r.y }, { x: maxX(r), y: maxY(r) })
  }
  return fromPoints(pts)
}

/** Grows (or, with a negative `by`, shrinks) every side by `by`. */
export const expand = (r: Bounds, by: number): Bounds => ({
  x: r.x - by,
  y: r.y - by,
  width: Math.max(0, r.width + 2 * by),
  height: Math.max(0, r.height + 2 * by),
})

export const translate = (r: Bounds, dx: number, dy: number): Bounds => ({ ...r, x: r.x + dx, y: r.y + dy })

/** Whether `p` is inside `r` (edges included). */
export const containsPoint = (r: Bounds, p: ScenePoint): boolean =>
  p.x >= r.x && p.x <= maxX(r) && p.y >= r.y && p.y <= maxY(r)

/** Whether `inner` lies wholly inside `outer` (edges included). */
export const containsRect = (outer: Bounds, inner: Bounds): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && maxX(inner) <= maxX(outer) && maxY(inner) <= maxY(outer)

/** Whether the two rectangles overlap (touching edges count). */
export const intersects = (a: Bounds, b: Bounds): boolean =>
  a.x <= maxX(b) && b.x <= maxX(a) && a.y <= maxY(b) && b.y <= maxY(a)

/** The overlap of two rectangles, or null. */
export function intersection(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const x2 = Math.min(maxX(a), maxX(b))
  const y2 = Math.min(maxY(a), maxY(b))
  return x2 < x || y2 < y ? null : { x, y, width: x2 - x, height: y2 - y }
}

export const distance = (a: ScenePoint, b: ScenePoint): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Equal within `tolerance` on every field. */
export const sameRect = (a: Bounds, b: Bounds, tolerance = 0.5): boolean =>
  Math.abs(a.x - b.x) <= tolerance &&
  Math.abs(a.y - b.y) <= tolerance &&
  Math.abs(a.width - b.width) <= tolerance &&
  Math.abs(a.height - b.height) <= tolerance

/** The four corners of `r` rotated by `angle` (radians) around its centre, as Excalidraw rotates elements. */
export function corners(r: Bounds, angle = 0): ScenePoint[] {
  const c = center(r)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    { x: r.x, y: r.y },
    { x: maxX(r), y: r.y },
    { x: maxX(r), y: maxY(r) },
    { x: r.x, y: maxY(r) },
  ].map((p) => ({
    x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
    y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
  }))
}
