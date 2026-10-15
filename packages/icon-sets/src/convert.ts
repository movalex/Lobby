// OWNER: WS1 (wave Q, the icons). One icon's SVG nodes (its set's nodes file: `[[element, attributes], …]` on the
// 24-unit grid) to IconGeometry: at most ICON_MAX_PRIMITIVES line, ellipse and rect primitives (contracts icons.ts),
// coordinates rounded to ICON_COORD_DECIMALS. Build time only: no path parser ships to the board.
//
//   circle, ellipse                 an ellipse primitive (filled when the node is)
//   a path subpath of arcs only     an ellipse primitive, when the arcs share centre and radii and turn a full circle
//                                   (Tabler draws its circles as two half arcs)
//   rect                            a rect primitive with corner radius r, when Excalidraw's own corner (a quadratic
//                                   through the corner, measure.ts drawn) stays within RECT_BUDGET of the SVG's arc;
//                                   else a closed line through the flattened outline
//   everything else                 a line through the flattened subpath (FLATTEN_TOL), closed when it ends where it
//                                   began; a filled subpath is a closed, filled line
//
// Stroked open lines that meet end to end are joined into one line (the sets draw with round caps and joins, so the
// joint looks the same), which keeps most icons far below the cap. An icon is refused, with a reason the build report
// lists, when a part is filled without a stroke (`stroke="none"`), a fill has a hole or overlapping islands, it uses
// an attribute this converter does not know (opacity, fill rules, transforms), the parts do not fit the caps, or the
// result is further than ICON_MAX_HAUSDORFF from the densely sampled source.

import {
  ICON_COORD_DECIMALS,
  ICON_GRID_MAX,
  ICON_GRID_MIN,
  ICON_MAX_LINE_POINTS,
  ICON_MAX_PRIMITIVES,
  type IconGeometry,
  type IconPrimitive,
} from '@draftroom/contracts'
import type { IconNode } from './index.ts'
import { drawn, hausdorff, ICON_MAX_HAUSDORFF } from './measure.ts'
import {
  ellipseSubpath,
  flatten,
  PathError,
  type Pt,
  parsePath,
  parsePoints,
  polySubpath,
  rectSubpath,
  type Subpath,
  sample,
} from './path.ts'

/** The adaptive flattening tolerance of arcs and Béziers, in grid units (0.4 px at 192 px). */
export const FLATTEN_TOL = 0.04
/** How far Excalidraw's quadratic corner may be from the SVG's arc for a rect to stay a rectangle element. */
export const RECT_BUDGET = 0.13
/** The spacing of the dense reference the fidelity is measured against. */
export const REFERENCE_STEP = 0.02

export type ConvertFailure =
  | 'malformed'
  | 'unsupported-element'
  | 'unsupported-attribute'
  | 'fill-only-part'
  | 'holed-fill'
  | 'empty'
  | 'too-many-parts'
  | 'too-many-points'
  | 'outside-grid'
  | 'fidelity'

export type ConvertResult =
  | {
      readonly ok: true
      readonly geometry: IconGeometry
      /** the Hausdorff distance to the source, when measured */
      readonly hausdorff?: number
    }
  | { readonly ok: false; readonly reason: ConvertFailure; readonly detail: string }

const KNOWN_ATTRS: Readonly<Record<string, readonly string[]>> = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
}
/** Style attributes a node may carry (with the values handled below). */
const STYLE_ATTRS = new Set(['fill', 'stroke'])

const SCALE = 10 ** ICON_COORD_DECIMALS
const r2 = (v: number) => {
  const r = Math.round(v * SCALE) / SCALE
  return r === 0 ? 0 : r // never -0
}
const same = (a: Pt, b: Pt, eps = 1e-6) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps

class Refused extends Error {
  readonly reason: ConvertFailure
  constructor(reason: ConvertFailure, detail: string) {
    super(detail)
    this.reason = reason
  }
}

/** A part of the icon before it becomes primitives. */
interface Part {
  readonly sources: Subpath[]
  readonly filled: boolean
  /** the node was a circle/ellipse or a rect: its own primitive is tried first */
  readonly shape?:
    | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
    | { t: 'rect'; x: number; y: number; w: number; h: number; rx: number; ry: number }
}

const numAttr = (a: Readonly<Record<string, string | number>>, k: string, fallback?: number): number => {
  const v = a[k]
  if (v === undefined) {
    if (fallback === undefined) throw new Refused('malformed', `missing ${k}`)
    return fallback
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new Refused('malformed', `${k} is not a number`)
  return n
}

function partOf(node: IconNode): Part | null {
  const [el, attrs] = node
  const known = KNOWN_ATTRS[el]
  if (!known) throw new Refused('unsupported-element', el)
  for (const k of Object.keys(attrs))
    if (!known.includes(k) && !STYLE_ATTRS.has(k)) throw new Refused('unsupported-attribute', `${el} ${k}`)
  const fill = attrs.fill
  const stroke = attrs.stroke
  if (fill !== undefined && fill !== 'none' && fill !== 'currentColor')
    throw new Refused('unsupported-attribute', `fill ${String(fill)}`)
  if (stroke !== undefined && stroke !== 'none' && stroke !== 'currentColor')
    throw new Refused('unsupported-attribute', `stroke ${String(stroke)}`)
  const filled = fill === 'currentColor'
  if (stroke === 'none') {
    if (filled) throw new Refused('fill-only-part', el)
    return null // neither stroked nor filled: draws nothing
  }
  try {
    switch (el) {
      case 'path':
        return { sources: parsePath(String(attrs.d ?? '')), filled }
      case 'circle': {
        const r = numAttr(attrs, 'r')
        const cx = numAttr(attrs, 'cx', 0)
        const cy = numAttr(attrs, 'cy', 0)
        if (r <= 0) return null
        return {
          sources: [ellipseSubpath(cx, cy, r, r)],
          filled,
          shape: { t: 'ellipse', cx, cy, rx: r, ry: r },
        }
      }
      case 'ellipse': {
        const rx = numAttr(attrs, 'rx')
        const ry = numAttr(attrs, 'ry')
        const cx = numAttr(attrs, 'cx', 0)
        const cy = numAttr(attrs, 'cy', 0)
        if (rx <= 0 || ry <= 0) return null
        return { sources: [ellipseSubpath(cx, cy, rx, ry)], filled, shape: { t: 'ellipse', cx, cy, rx, ry } }
      }
      case 'rect': {
        const x = numAttr(attrs, 'x', 0)
        const y = numAttr(attrs, 'y', 0)
        const w = numAttr(attrs, 'width')
        const h = numAttr(attrs, 'height')
        if (w <= 0 || h <= 0) return null
        const rxA = attrs.rx === undefined ? undefined : numAttr(attrs, 'rx')
        const ryA = attrs.ry === undefined ? undefined : numAttr(attrs, 'ry')
        const rx = Math.min(Math.max(0, rxA ?? ryA ?? 0), w / 2)
        const ry = Math.min(Math.max(0, ryA ?? rxA ?? 0), h / 2)
        return {
          sources: [rectSubpath(x, y, w, h, rxA, ryA)],
          filled,
          shape: { t: 'rect', x, y, w, h, rx, ry },
        }
      }
      case 'line': {
        const p0: Pt = [numAttr(attrs, 'x1', 0), numAttr(attrs, 'y1', 0)]
        const p1: Pt = [numAttr(attrs, 'x2', 0), numAttr(attrs, 'y2', 0)]
        return { sources: [polySubpath([p0, p1], false)], filled }
      }
      case 'polyline':
      case 'polygon':
        return { sources: [polySubpath(parsePoints(String(attrs.points ?? '')), el === 'polygon')], filled }
    }
  } catch (e) {
    if (e instanceof PathError) throw new Refused('malformed', e.message)
    throw e
  }
  throw new Refused('unsupported-element', el)
}

/** The full ellipse a subpath of arcs only draws (shared centre and radii, a full turn, back at its start). */
function arcsEllipse(sp: Subpath): { cx: number; cy: number; rx: number; ry: number } | null {
  const first = sp.segments[0]
  if (first?.k !== 'A') return null
  let turn = 0
  for (const s of sp.segments) {
    if (s.k !== 'A') return null
    const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    if (!eq(s.cx, first.cx) || !eq(s.cy, first.cy) || !eq(s.rx, first.rx) || !eq(s.ry, first.ry)) return null
    if (!eq(s.rx, s.ry) && Math.abs(Math.sin(s.phi)) > 1e-9) return null
    if (Math.sign(s.dtheta) !== Math.sign(first.dtheta)) return null
    turn += s.dtheta
  }
  const last = sp.segments[sp.segments.length - 1] as { p1: Pt }
  if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3 || !same(last.p1, sp.start, 1e-3)) return null
  return { cx: first.cx, cy: first.cy, rx: first.rx, ry: first.ry }
}

const endOf = (sp: Subpath): Pt =>
  sp.segments.length ? (sp.segments[sp.segments.length - 1] as { p1: Pt }).p1 : sp.start

/** Continuous subpaths (the next one starts where the last ended: `m0 0`) as one. */
function joinContinuous(sps: readonly Subpath[]): Subpath[] {
  const out: Subpath[] = []
  for (const sp of sps) {
    const prev = out[out.length - 1]
    if (prev && !prev.closed && same(endOf(prev), sp.start)) {
      const segments = [...prev.segments, ...sp.segments]
      const last = segments[segments.length - 1] as { p1: Pt } | undefined
      // closed only when the joined path is back at its own start (the second one's Z closed the second one)
      out[out.length - 1] = { start: prev.start, segments, closed: !!last && same(last.p1, prev.start) }
    } else out.push(sp)
  }
  return out
}

/** Whether `p` is inside the polygon `poly` (even-odd; the polygon's last point joins its first). */
function inside(p: Pt, poly: readonly Pt[]): boolean {
  let hit = false
  for (let n = 0, m = poly.length - 1; n < poly.length; m = n++) {
    const a = poly[n] as Pt
    const b = poly[m] as Pt
    const aAbove = a[1] > p[1]
    const bAbove = b[1] > p[1]
    if (aAbove !== bAbove && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit
  }
  return hit
}

/** A primitive with its dense reference (what it must stay close to). */
interface Piece {
  prim: IconPrimitive
  /** open stroked lines may be joined end to end */
  joinable: boolean
  pts?: Pt[]
}

function lineFrom(pts: Pt[], closed: boolean, filled: boolean): Piece {
  let rounded = pts.map(([x, y]) => [r2(x), r2(y)] as Pt)
  rounded = rounded.filter((p, n) => n === 0 || !same(p, rounded[n - 1] as Pt))
  let isClosed = closed || filled
  if (rounded.length > 1 && same(rounded[0] as Pt, rounded[rounded.length - 1] as Pt)) {
    rounded.pop()
    isClosed = true
  }
  if (rounded.length < 3) isClosed = false
  // a dot (the sets draw them as a 0.01 long stroke): at least two points, so it is drawn with its round cap
  if (rounded.length === 1) {
    const p = rounded[0] as Pt
    rounded.push([r2(p[0] + 1 / SCALE), p[1]])
  }
  const line = { t: 'line' as const, p: rounded.flatMap((p) => [p[0], p[1]]) }
  if (!isClosed) return { prim: line, joinable: !filled, pts: rounded }
  const prim: IconPrimitive = filled ? { ...line, closed: true, f: true } : { ...line, closed: true }
  return { prim, joinable: false, pts: rounded }
}

function ellipsePrim(e: { cx: number; cy: number; rx: number; ry: number }, filled: boolean): IconPrimitive {
  const x = r2(e.cx - e.rx)
  const y = r2(e.cy - e.ry)
  const w = r2(2 * e.rx)
  const h = r2(2 * e.ry)
  return filled ? { t: 'ellipse', x, y, w, h, f: true } : { t: 'ellipse', x, y, w, h }
}

function partPieces(part: Part): Piece[] {
  const { shape, filled } = part
  if (shape?.t === 'ellipse') return [{ prim: ellipsePrim(shape, filled), joinable: false }]
  if (shape?.t === 'rect') {
    const x = r2(shape.x)
    const y = r2(shape.y)
    const w = r2(shape.w)
    const h = r2(shape.h)
    const base = { t: 'rect' as const, x, y, w, h }
    // SVG draws square corners when either radius is 0
    const square = shape.rx === 0 || shape.ry === 0
    const plain: IconPrimitive = square ? base : { ...base, r: r2(shape.rx) }
    const prim: IconPrimitive = filled ? { ...plain, f: true } : plain
    const ref = part.sources.map((sp) => sample(sp, REFERENCE_STEP))
    if ((square || shape.rx === shape.ry) && hausdorff(ref, drawn(prim)) <= RECT_BUDGET)
      return [{ prim, joinable: false }]
    // Excalidraw cannot draw this corner closely enough (an elliptic corner, or a radius over a quarter of the
    // shorter side): the outline as a line
  }
  const sources = joinContinuous(part.sources).filter((sp) => sp.segments.length > 0)
  if (filled && sources.length > 1) {
    // islands are separate fills; a ring inside another is a hole Excalidraw cannot draw
    const rings = sources.map((sp) => flatten(sp, FLATTEN_TOL))
    for (let a = 0; a < rings.length; a++)
      for (let b = 0; b < rings.length; b++)
        if (a !== b && inside(rings[a]?.[0] as Pt, rings[b] as Pt[]))
          throw new Refused('holed-fill', 'nested rings')
  }
  return sources.map((sp) => {
    const ell = arcsEllipse(sp)
    if (ell) return { prim: ellipsePrim(ell, filled), joinable: false }
    return lineFrom(flatten(sp, FLATTEN_TOL), sp.closed || same(endOf(sp), sp.start, 1e-3), filled)
  })
}

/** Joins open stroked lines that meet end to end (first found, in drawing order), within the point cap. */
function joinLines(pieces: Piece[]): Piece[] {
  const out = [...pieces]
  let joined = true
  while (joined) {
    joined = false
    outer: for (let a = 0; a < out.length; a++) {
      const A = out[a] as Piece
      if (!A.joinable || !A.pts) continue
      for (let b = a + 1; b < out.length; b++) {
        const B = out[b] as Piece
        if (!B.joinable || !B.pts) continue
        if (A.pts.length + B.pts.length - 1 > ICON_MAX_LINE_POINTS) continue
        const a0 = A.pts[0] as Pt
        const a1 = A.pts[A.pts.length - 1] as Pt
        const b0 = B.pts[0] as Pt
        const b1 = B.pts[B.pts.length - 1] as Pt
        let pts: Pt[] | null = null
        if (same(a1, b0)) pts = [...A.pts, ...B.pts.slice(1)]
        else if (same(a1, b1)) pts = [...A.pts, ...[...B.pts].reverse().slice(1)]
        else if (same(a0, b1)) pts = [...B.pts, ...A.pts.slice(1)]
        else if (same(a0, b0)) pts = [...[...B.pts].reverse(), ...A.pts.slice(1)]
        if (!pts) continue
        out[a] = lineFrom(pts, false, false)
        out.splice(b, 1)
        joined = true
        break outer
      }
    }
  }
  return out
}

function inGrid(v: number) {
  return v >= ICON_GRID_MIN && v <= ICON_GRID_MAX
}

function checkCaps(geometry: readonly IconPrimitive[]): void {
  if (!geometry.length) throw new Refused('empty', 'no visible part')
  if (geometry.length > ICON_MAX_PRIMITIVES)
    throw new Refused('too-many-parts', `${geometry.length} parts (at most ${ICON_MAX_PRIMITIVES})`)
  for (const p of geometry) {
    if (p.t === 'line') {
      if (p.p.length / 2 > ICON_MAX_LINE_POINTS)
        throw new Refused('too-many-points', `${p.p.length / 2} points`)
      if (!p.p.every(inGrid)) throw new Refused('outside-grid', 'a point outside the grid')
    } else if (!inGrid(p.x) || !inGrid(p.y) || !inGrid(p.x + p.w) || !inGrid(p.y + p.h))
      throw new Refused('outside-grid', `${p.t} outside the grid`)
  }
}

/** The dense reference of an icon's visible nodes (filled parts as their closed outline). */
export function referenceOf(nodes: readonly IconNode[]): Pt[][] {
  const out: Pt[][] = []
  for (const node of nodes) {
    let part: Part | null
    try {
      part = partOf(node)
    } catch {
      continue
    }
    if (!part) continue
    for (const sp of part.sources) {
      const pts = sample(sp, REFERENCE_STEP)
      if (part.filled && pts.length > 1) pts.push(pts[0] as Pt)
      out.push(pts)
    }
  }
  return out
}

export interface ConvertOptions {
  /** measure the Hausdorff distance to the dense source and refuse over ICON_MAX_HAUSDORFF (default true) */
  readonly measure?: boolean
}

/** One icon's nodes to its geometry, or why Excalidraw's elements cannot draw it. Never throws. */
export function convertIcon(nodes: readonly IconNode[], opts: ConvertOptions = {}): ConvertResult {
  try {
    const parts = nodes.map(partOf).filter((p): p is Part => p !== null)
    const geometry = joinLines(parts.flatMap(partPieces)).map((p) => p.prim)
    checkCaps(geometry)
    if (opts.measure === false) return { ok: true, geometry }
    const d = hausdorff(referenceOf(nodes), geometry.flatMap(drawn))
    if (!(d <= ICON_MAX_HAUSDORFF))
      return { ok: false, reason: 'fidelity', detail: `${d.toFixed(3)} units from the source` }
    return { ok: true, geometry, hausdorff: d }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason, detail: e.message }
    return { ok: false, reason: 'malformed', detail: e instanceof Error ? e.message : String(e) }
  }
}
