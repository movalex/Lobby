// Plain geometry of a mind map on the new canvas (pure): topic boxes from elements, and the elbow line
// from a parent's side to its child's (the tldraw map bound its lines at the middle of the parent's outer
// side and of the child's inner side, ../runtime.ts anchorsFor; the converter keeps those fixed points).

import type { MindmapSide } from '@draftroom/contracts'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import type { Box } from '../model.ts'

/** The fixed points of a line: [x, y] as fractions of the parent's and the child's box. */
export function anchorsFor(side: MindmapSide): { parent: [number, number]; child: [number, number] } {
  return side === 'right' ? { parent: [1, 0.5], child: [0, 0.5] } : { parent: [0, 0.5], child: [1, 0.5] }
}

/**
 * A topic's box: its own fields when it is not rotated (the common case, and what the layout places),
 * else `bounds` (the axis-aligned box the canvas computes, rotation included).
 */
export function boxOf(
  el: CanvasElement,
  bounds?: (id: string) => { x: number; y: number; width: number; height: number } | null,
): Box {
  if (!el.angle || !bounds) return { x: el.x, y: el.y, w: el.width, h: el.height }
  const b = bounds(el.id)
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: el.x, y: el.y, w: el.width, h: el.height }
}

export interface LineGeometry {
  x: number
  y: number
  width: number
  height: number
  points: [number, number][]
}

/**
 * The elbow line from `parent` to `child` on `side`: from the middle of the parent's outer side,
 * horizontally to half-way, vertically to the child's middle, horizontally into the child's inner side.
 * The server re-routes a bound elbow arrow when its ends move (docs/EXCALIDRAW-MIGRATION.md §2.4.4); this
 * is the geometry the client writes with a move, so the line follows at once.
 */
export function elbowLine(parent: Box, child: Box, side: MindmapSide): LineGeometry {
  const a = anchorsFor(side)
  const sx = parent.x + parent.w * a.parent[0]
  const sy = parent.y + parent.h * a.parent[1]
  const ex = child.x + child.w * a.child[0]
  const ey = child.y + child.h * a.child[1]
  const dx = ex - sx
  const dy = ey - sy
  const mx = dx / 2
  const points: [number, number][] =
    Math.abs(dy) < 0.5
      ? [
          [0, 0],
          [dx, 0],
        ]
      : [
          [0, 0],
          [mx, 0],
          [mx, dy],
          [dx, dy],
        ]
  return { x: sx, y: sy, width: Math.abs(dx), height: Math.abs(dy), points }
}

const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps

/** Whether two line geometries draw the same (half a pixel of slack). */
export function sameLine(
  el: { x: number; y: number; points?: readonly (readonly number[])[] },
  g: LineGeometry,
): boolean {
  const pts = el.points ?? []
  if (!near(el.x, g.x) || !near(el.y, g.y) || pts.length !== g.points.length) return false
  return g.points.every(
    (p, i) => near(pts[i]?.[0] ?? Number.NaN, p[0]) && near(pts[i]?.[1] ?? Number.NaN, p[1]),
  )
}
