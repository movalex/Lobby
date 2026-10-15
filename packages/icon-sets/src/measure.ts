// OWNER: WS1 (wave Q, the icons). How far a converted icon is from its source, on the 24-unit grid. Build and test
// time only.
//
//   drawn(primitive)       the primitive as the pinned Excalidraw draws it (roughness 0): a line's own points; an
//                          ellipse's exact outline; a rectangle with Excalidraw's corners (a quadratic Bézier from
//                          the side to the side through the corner, radius min(r, shorter side / 4): the adaptive
//                          radius of @excalidraw/element getCornerRadius, read from the installed dist/dev).
//   hausdorff(a, b, step)  the symmetric Hausdorff distance between two sets of polylines, from every point of each
//                          (densified to `step`) to the nearest segment of the other, through a uniform grid.
//
// The fidelity tests sample the source with path.ts `sample` (uniform in each segment's parameter: not the
// converter's adaptive `flatten`) and require hausdorff(source, drawn) <= ICON_MAX_HAUSDORFF.

import type { IconPrimitive } from '@draftroom/contracts'
import type { Pt } from './path.ts'

/** The largest distance a converted icon may be from its densely sampled source, in grid units (contract §7). */
export const ICON_MAX_HAUSDORFF = 0.15

/** Excalidraw's DEFAULT_PROPORTIONAL_RADIUS: an adaptive radius is at most this share of the shorter side. */
export const EXCALIDRAW_PROPORTIONAL_RADIUS = 0.25

const ELLIPSE_STEPS = 256
const CORNER_STEPS = 32

/** The radius Excalidraw draws for a rectangle `w` by `h` with roundness {type: 3, value: r}. */
export function drawnCornerRadius(r: number, w: number, h: number): number {
  const x = Math.min(w, h)
  return x <= r / EXCALIDRAW_PROPORTIONAL_RADIUS ? x * EXCALIDRAW_PROPORTIONAL_RADIUS : r
}

/** The polylines a primitive is drawn along (its outline; a fill is the inside of the closed outline). */
export function drawn(p: IconPrimitive): Pt[][] {
  switch (p.t) {
    case 'line': {
      const pts: Pt[] = []
      for (let n = 0; n < p.p.length; n += 2) pts.push([p.p[n] as number, p.p[n + 1] as number])
      if (p.closed || p.f) pts.push(pts[0] as Pt)
      return [pts]
    }
    case 'ellipse': {
      const rx = p.w / 2
      const ry = p.h / 2
      const cx = p.x + rx
      const cy = p.y + ry
      const pts: Pt[] = []
      for (let n = 0; n <= ELLIPSE_STEPS; n++) {
        const a = (n / ELLIPSE_STEPS) * 2 * Math.PI
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
      }
      return [pts]
    }
    case 'rect': {
      const { x, y, w, h } = p
      const r = p.r ? drawnCornerRadius(p.r, w, h) : 0
      if (r === 0)
        return [
          [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
            [x, y],
          ],
        ]
      // Excalidraw's path: M r 0 L w-r 0 Q w 0, w r L w h-r Q w h, w-r h L r h Q 0 h, 0 h-r L 0 r Q 0 0, r 0
      const pts: Pt[] = [[x + r, y]]
      const quad = (c: Pt, to: Pt) => {
        const from = pts[pts.length - 1] as Pt
        for (let n = 1; n <= CORNER_STEPS; n++) {
          const t = n / CORNER_STEPS
          const u = 1 - t
          pts.push([
            u * u * from[0] + 2 * u * t * c[0] + t * t * to[0],
            u * u * from[1] + 2 * u * t * c[1] + t * t * to[1],
          ])
        }
      }
      pts.push([x + w - r, y])
      quad([x + w, y], [x + w, y + r])
      pts.push([x + w, y + h - r])
      quad([x + w, y + h], [x + w - r, y + h])
      pts.push([x + r, y + h])
      quad([x, y + h], [x, y + h - r])
      pts.push([x, y + r])
      quad([x, y], [x + r, y])
      return [pts]
    }
  }
}

// ---- the Hausdorff distance -----------------------------------------------------------------------------------

type Seg = readonly [number, number, number, number]
/** Polylines: each a list of points. */
export type Polylines = readonly (readonly Pt[])[]

function segmentsOf(lines: Polylines): Seg[] {
  const out: Seg[] = []
  for (const line of lines) {
    if (line.length === 1) {
      const p = line[0] as Pt
      out.push([p[0], p[1], p[0], p[1]])
    }
    for (let n = 1; n < line.length; n++) {
      const a = line[n - 1] as Pt
      const b = line[n] as Pt
      out.push([a[0], a[1], b[0], b[1]])
    }
  }
  return out
}

/** Every vertex, and points along every segment at most `step` apart. */
function densify(lines: Polylines, step: number): Pt[] {
  const out: Pt[] = []
  for (const line of lines) {
    if (!line.length) continue
    out.push(line[0] as Pt)
    for (let n = 1; n < line.length; n++) {
      const a = line[n - 1] as Pt
      const b = line[n] as Pt
      const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
      for (let j = 1; j <= k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
    }
  }
  return out
}

function segDistance2(px: number, py: number, s: Seg): number {
  const dx = s[2] - s[0]
  const dy = s[3] - s[1]
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - s[0]) * dx + (py - s[1]) * dy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = s[0] + t * dx - px
  const ey = s[1] + t * dy - py
  return ex * ex + ey * ey
}

const CELL = 0.5

/** Segments bucketed in a uniform grid, for nearest-segment queries. */
class SegGrid {
  readonly cells = new Map<number, number[]>()
  readonly segs: readonly Seg[]
  constructor(segs: readonly Seg[]) {
    this.segs = segs
    segs.forEach((s, n) => {
      const x0 = Math.floor(Math.min(s[0], s[2]) / CELL)
      const x1 = Math.floor(Math.max(s[0], s[2]) / CELL)
      const y0 = Math.floor(Math.min(s[1], s[3]) / CELL)
      const y1 = Math.floor(Math.max(s[1], s[3]) / CELL)
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const key = SegGrid.key(cx, cy)
          const list = this.cells.get(key)
          if (list) list.push(n)
          else this.cells.set(key, [n])
        }
    })
  }
  static key = (cx: number, cy: number) => (cx + 4096) * 8192 + (cy + 4096)
  /** The distance from (px, py) to the nearest segment. */
  nearest(px: number, py: number): number {
    if (!this.segs.length) return Number.POSITIVE_INFINITY
    const cx = Math.floor(px / CELL)
    const cy = Math.floor(py / CELL)
    let best = Number.POSITIVE_INFINITY
    // rings outward: a segment at distance d crosses a cell within ceil(d / CELL) rings
    for (let ring = 0; ring < 200; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++)
        for (let iy = cy - ring; iy <= cy + ring; iy++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy)) !== ring) continue
          const list = this.cells.get(SegGrid.key(ix, iy))
          if (!list) continue
          for (const n of list) {
            const d = segDistance2(px, py, this.segs[n] as Seg)
            if (d < best) best = d
          }
        }
      if (best !== Number.POSITIVE_INFINITY && Math.sqrt(best) <= ring * CELL) break
    }
    return Math.sqrt(best)
  }
}

/** The largest distance from a point of `from` (densified to `step`) to the nearest segment of `to`. */
export function directedHausdorff(from: Polylines, to: Polylines, step = 0.05): number {
  const grid = new SegGrid(segmentsOf(to))
  let worst = 0
  for (const p of densify(from, step)) {
    const d = grid.nearest(p[0], p[1])
    if (d > worst) worst = d
  }
  return worst
}

/** The symmetric Hausdorff distance between two sets of polylines. */
export function hausdorff(a: Polylines, b: Polylines, step = 0.05): number {
  return Math.max(directedHausdorff(a, b, step), directedHausdorff(b, a, step))
}
