/**
 * Pure 2D geometry for the converter: tldraw's parent-chain transforms, linear element geometry as
 * Excalidraw stores it (the geo outlines are in geo-shapes.ts), the bound endpoint of an
 * arrow in orbit mode, and stroke simplification. No engine code; deterministic.
 */
import { bindingGap } from '@draftroom/canvas-schema/engine'
import { round2 } from '@draftroom/canvas-schema/limits'

export interface Pt {
  readonly x: number
  readonly y: number
}

/** A 2D affine matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = readonly [number, number, number, number, number, number]
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

export const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]
/** tldraw's local transform: translate to (x, y), then rotate by r around that point. */
export const local = (x: number, y: number, r: number): Mat => {
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, x, y]
}
export const translate = (dx: number, dy: number): Mat => [1, 0, 0, 1, dx, dy]
export const apply = (m: Mat, x: number, y: number): Pt => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
})
/** The rotation of a matrix in [0, 2π), exactly 0 for (numerically) unrotated ones. */
export const angleOf = (m: Mat): number => {
  const a = Math.atan2(m[1], m[0])
  const t = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return Math.abs(t) < 1e-9 || Math.abs(t - 2 * Math.PI) < 1e-9 ? 0 : t
}

/** An oriented box: its unrotated top-left corner, size and angle about its centre (Excalidraw's model). */
export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly angle: number
  readonly cx: number
  readonly cy: number
}

/** The box of a w × h shape whose local frame is `m` (tldraw rotates about the origin, Excalidraw about the centre). */
export const boxOf = (m: Mat, w: number, h: number): Box => {
  const c = apply(m, w / 2, h / 2)
  return { x: c.x - w / 2, y: c.y - h / 2, w, h, angle: angleOf(m), cx: c.x, cy: c.y }
}

/** Rotates p about c by angle. */
export const rotateAbout = (p: Pt, c: Pt, angle: number): Pt => {
  if (!angle) return p
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/**
 * Linear element geometry as Excalidraw stores it: `x`, `y` = the first point, `points` relative to it
 * (2 decimals, limits.ts roundGeometry), `width`/`height` = the extent of the points (getSizeFromPoints).
 */
export function linearGeometry(pts: readonly Pt[]): {
  x: number
  y: number
  points: [number, number][]
  width: number
  height: number
} {
  const x0 = round2(pts[0]?.x ?? 0)
  const y0 = round2(pts[0]?.y ?? 0)
  const rel = pts.map((q) => [round2(q.x - x0), round2(q.y - y0)] as [number, number])
  if (rel[0]) rel[0] = [0, 0]
  const xs = rel.map((q) => q[0])
  const ys = rel.map((q) => q[1])
  return {
    x: x0,
    y: y0,
    points: rel,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

/** tldraw curved-arrow.ts: middle = med + per(u) × −bend, per(x, y) = (y, −x). */
export function bendMid(a: Pt, b: Pt, bend: number): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  return { x: (a.x + b.x) / 2 + -bend * uy, y: (a.y + b.y) / 2 + -bend * -ux }
}

export type Outline = 'rect' | 'ellipse' | 'diamond'

/** A bindable target as the orbit computation reads it (scene box plus outline kind). */
export interface TargetShape extends Box {
  readonly outline: Outline
  readonly strokeWidth: number
}

/** Excalidraw's `getGlobalFixedPointForBindableElement`: the fixed point in scene coordinates. */
export const fixedPointOnTarget = (t: TargetShape, fp: readonly [number, number]): Pt =>
  rotateAbout({ x: t.x + t.w * fp[0], y: t.y + t.h * fp[1] }, { x: t.cx, y: t.cy }, t.angle)

/** Excalidraw's binding gap: canvas-schema's `bindingGap` (the engine's own `getBindingGap`; W5-53, one gap). */
export { bindingGap }

/**
 * Orbit mode's bound point (Excalidraw `updateBoundPoint`, E 9471-9560, approximated): where the segment
 * from the fixed point toward `toward` leaves the target's outline grown by the binding gap. Returns the
 * fixed point itself when `toward` is inside the grown outline or the segment is degenerate.
 */
export function orbitPoint(t: TargetShape, focus: Pt, toward: Pt): Pt {
  const gap = bindingGap(t)
  const hw = t.w / 2 + gap
  const hh = t.h / 2 + gap
  const toLocal = (p: Pt) => rotateAbout(p, { x: t.cx, y: t.cy }, -t.angle)
  const p0 = toLocal(focus)
  const p1 = toLocal(toward)
  const inside = (x: number, y: number) => {
    const lx = x - t.cx
    const ly = y - t.cy
    if (t.outline === 'ellipse') return (lx / hw) ** 2 + (ly / hh) ** 2 <= 1
    if (t.outline === 'diamond') return Math.abs(lx) / hw + Math.abs(ly) / hh <= 1
    return Math.abs(lx) <= hw && Math.abs(ly) <= hh
  }
  if (!inside(p0.x, p0.y) || inside(p1.x, p1.y)) return focus
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  if (!Math.hypot(dx, dy)) return focus
  let lo = 0
  let hi = 1
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) / 2
    if (inside(p0.x + dx * m, p0.y + dy * m)) lo = m
    else hi = m
  }
  return rotateAbout({ x: p0.x + dx * hi, y: p0.y + dy * hi }, { x: t.cx, y: t.cy }, t.angle)
}

/**
 * Ramer–Douglas–Peucker simplification (§3.5: a stroke over the point cap is simplified at 0.5 px).
 * Iterative (no recursion depth limit); keeps the first and last point.
 */
export function simplifyRdp(pts: readonly Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return [...pts]
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number]
    const pa = pts[a] as Pt
    const pb = pts[b] as Pt
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const len = Math.hypot(dx, dy)
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const p = pts[i] as Pt
      const d = len
        ? Math.abs(dy * p.x - dx * p.y + pb.x * pa.y - pb.y * pa.x) / len
        : Math.hypot(p.x - pa.x, p.y - pa.y)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  return pts.filter((_, i) => keep[i] === 1)
}
