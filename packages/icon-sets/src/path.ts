// OWNER: WS1 (wave Q, the icons). The SVG geometry the converter reads, at build time only (docs/WAVE-Q-CONTRACTS.md
// §3.2): a parser of path data (M/L/H/V/C/S/Q/T/A/Z, absolute and relative, implicit repeats, compact arc flags) into
// subpaths of absolute segments, the SVG elements the sets use (path, circle, ellipse, rect, line, polyline,
// polygon) as the same segments, and two ways to turn segments into points:
//
//   flatten()  adaptive: Béziers subdivided until their control points are within `tol` of the chord, arcs cut so the
//              sagitta stays under `tol`. What the converter ships.
//   sample()   uniform in each segment's parameter, at most `step` apart: the dense reference the fidelity tests
//              measure the shipped geometry against (a different walk of the same curves, so a flattening mistake
//              shows up as a distance).
//
// No dependency: nothing here ships to the board (the web gets converted primitives, never path data).

export type Pt = readonly [number, number]

export type Segment =
  | { readonly k: 'L'; readonly p0: Pt; readonly p1: Pt }
  | { readonly k: 'Q'; readonly p0: Pt; readonly c: Pt; readonly p1: Pt }
  | { readonly k: 'C'; readonly p0: Pt; readonly c1: Pt; readonly c2: Pt; readonly p1: Pt }
  | {
      readonly k: 'A'
      readonly p0: Pt
      readonly p1: Pt
      /** centre parameterisation (SVG 1.1 F.6.5), radii already scaled up when too small */
      readonly cx: number
      readonly cy: number
      readonly rx: number
      readonly ry: number
      /** x-axis rotation in radians */
      readonly phi: number
      readonly theta: number
      readonly dtheta: number
    }

export interface Subpath {
  readonly start: Pt
  readonly segments: readonly Segment[]
  /** ended with Z (the closing line, when not zero-length, is the last segment) */
  readonly closed: boolean
}

export class PathError extends Error {}

// ---- the parser -----------------------------------------------------------------------------------------------

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/

/** The path data `d` as subpaths of absolute segments. Throws PathError on malformed data. */
export function parsePath(d: string): Subpath[] {
  const out: Subpath[] = []
  let i = 0
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i] as string)) i++
  }
  const num = (): number => {
    skip()
    const m = NUMBER.exec(d.slice(i))
    if (!m) throw new PathError(`a number expected at ${i}`)
    i += m[0].length
    const v = Number(m[0])
    if (!Number.isFinite(v)) throw new PathError('a number out of range')
    return v
  }
  const flag = (): boolean => {
    skip()
    const c = d[i]
    if (c !== '0' && c !== '1') throw new PathError(`an arc flag expected at ${i}`)
    i++
    return c === '1'
  }
  let cur: Pt = [0, 0]
  let start: Pt = [0, 0]
  let segs: Segment[] = []
  let open = false
  let closed = false
  // the reflected control point of the previous S/C (cubic) or T/Q (quadratic)
  let lastC: Pt | null = null
  let lastQ: Pt | null = null
  const flush = () => {
    if (open) out.push({ start, segments: segs, closed })
    segs = []
    open = false
    closed = false
  }
  const begin = () => {
    if (!open) {
      start = cur
      open = true
    }
  }
  let cmd = ''
  for (;;) {
    skip()
    if (i >= d.length) break
    const c = d[i] as string
    if (/[a-zA-Z]/.test(c)) {
      if (ARGS[c.toUpperCase()] === undefined) throw new PathError(`unknown command ${c}`)
      if (!cmd && c !== 'M' && c !== 'm') throw new PathError('path data starts with a moveto')
      cmd = c
      i++
    } else if (!cmd || cmd === 'z' || cmd === 'Z') {
      throw new PathError(`a command expected at ${i}`)
    }
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? cur[0] : 0
    const oy = rel ? cur[1] : 0
    switch (C) {
      case 'M': {
        flush()
        cur = [ox + num(), oy + num()]
        start = cur
        open = true
        lastC = lastQ = null
        // pairs after a moveto are linetos of the same relativity
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
      case 'H':
      case 'V': {
        begin()
        const p: Pt =
          C === 'L' ? [ox + num(), oy + num()] : C === 'H' ? [ox + num(), cur[1]] : [cur[0], oy + num()]
        segs.push({ k: 'L', p0: cur, p1: p })
        cur = p
        lastC = lastQ = null
        break
      }
      case 'C':
      case 'S': {
        begin()
        let c1: Pt
        if (C === 'C') c1 = [ox + num(), oy + num()]
        else c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur
        const c2: Pt = [ox + num(), oy + num()]
        const p: Pt = [ox + num(), oy + num()]
        segs.push({ k: 'C', p0: cur, c1, c2, p1: p })
        cur = p
        lastC = c2
        lastQ = null
        break
      }
      case 'Q':
      case 'T': {
        begin()
        let q: Pt
        if (C === 'Q') q = [ox + num(), oy + num()]
        else q = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur
        const p: Pt = [ox + num(), oy + num()]
        segs.push({ k: 'Q', p0: cur, c: q, p1: p })
        cur = p
        lastQ = q
        lastC = null
        break
      }
      case 'A': {
        begin()
        const rx = num()
        const ry = num()
        const rot = num()
        const large = flag()
        const sweep = flag()
        const p: Pt = [ox + num(), oy + num()]
        segs.push(arcSegment(cur, p, rx, ry, rot, large, sweep))
        cur = p
        lastC = lastQ = null
        break
      }
      case 'Z': {
        if (open) {
          if (cur[0] !== start[0] || cur[1] !== start[1]) segs.push({ k: 'L', p0: cur, p1: start })
          closed = true
          cur = start
          flush()
        }
        lastC = lastQ = null
        break
      }
    }
  }
  flush()
  return out
}

/** An arc from endpoint form to centre form (SVG 1.1 F.6.5, F.6.6); a zero radius is a straight line. */
export function arcSegment(
  p0: Pt,
  p1: Pt,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
): Segment {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if ((p0[0] === p1[0] && p0[1] === p1[1]) || rx === 0 || ry === 0) return { k: 'L', p0, p1 }
  const phi = ((rotDeg % 360) * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (p0[0] - p1[0]) / 2
  const dy = (p0[1] - p1[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let co = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) co = -co
  const cxp = (co * rx * y1) / ry
  const cyp = (-co * ry * x1) / rx
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2
  const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const ux = (x1 - cxp) / rx
  const uy = (y1 - cyp) / ry
  const vx = (-x1 - cxp) / rx
  const vy = (-y1 - cyp) / ry
  const theta = angle(1, 0, ux, uy)
  let dtheta = angle(ux, uy, vx, vy)
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI
  return { k: 'A', p0, p1, cx, cy, rx, ry, phi, theta, dtheta }
}

// ---- the SVG elements as segments ---------------------------------------------------------------------------

const KAPPA_TURN = Math.PI / 2

/** A closed ellipse as four quarter arcs (start at the rightmost point, clockwise in SVG's y-down space). */
export function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): Subpath {
  const at = (t: number): Pt => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]
  const segments: Segment[] = []
  for (let q = 0; q < 4; q++) {
    const theta = q * KAPPA_TURN
    segments.push({
      k: 'A',
      p0: at(theta),
      p1: at(theta + KAPPA_TURN),
      cx,
      cy,
      rx,
      ry,
      phi: 0,
      theta,
      dtheta: KAPPA_TURN,
    })
  }
  return { start: at(0), segments, closed: true }
}

/** An SVG rect (rx/ry as SVG 1.1 resolves them: a missing one equals the other, each at most half the side). */
export function rectSubpath(x: number, y: number, w: number, h: number, rxIn?: number, ryIn?: number): Subpath {
  let rx = rxIn ?? ryIn ?? 0
  let ry = ryIn ?? rxIn ?? 0
  rx = Math.min(Math.max(0, rx), w / 2)
  ry = Math.min(Math.max(0, ry), h / 2)
  const segments: Segment[] = []
  const line = (p0: Pt, p1: Pt) => {
    if (p0[0] !== p1[0] || p0[1] !== p1[1]) segments.push({ k: 'L', p0, p1 })
  }
  if (rx === 0 || ry === 0) {
    const c: Pt[] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ]
    for (let n = 0; n < 4; n++) line(c[n] as Pt, c[(n + 1) % 4] as Pt)
    return { start: [x, y], segments, closed: true }
  }
  const corner = (cx: number, cy: number, theta: number, p0: Pt, p1: Pt) =>
    segments.push({ k: 'A', p0, p1, cx, cy, rx, ry, phi: 0, theta, dtheta: KAPPA_TURN })
  const top0: Pt = [x + rx, y]
  const top1: Pt = [x + w - rx, y]
  const right0: Pt = [x + w, y + ry]
  const right1: Pt = [x + w, y + h - ry]
  const bottom0: Pt = [x + w - rx, y + h]
  const bottom1: Pt = [x + rx, y + h]
  const left0: Pt = [x, y + h - ry]
  const left1: Pt = [x, y + ry]
  line(top0, top1)
  corner(x + w - rx, y + ry, -KAPPA_TURN, top1, right0)
  line(right0, right1)
  corner(x + w - rx, y + h - ry, 0, right1, bottom0)
  line(bottom0, bottom1)
  corner(x + rx, y + h - ry, KAPPA_TURN, bottom1, left0)
  line(left0, left1)
  corner(x + rx, y + ry, Math.PI, left1, top0)
  return { start: top0, segments, closed: true }
}

/** The points of a polyline or polygon's `points` attribute. */
export function parsePoints(points: string): Pt[] {
  const nums = points
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (nums.length < 4 || nums.length % 2 || nums.some((n) => !Number.isFinite(n)))
    throw new PathError('malformed points')
  const out: Pt[] = []
  for (let n = 0; n < nums.length; n += 2) out.push([nums[n] as number, nums[n + 1] as number])
  return out
}

/** Straight segments through `pts`, closed back to the first when `closed`. */
export function polySubpath(pts: readonly Pt[], closed: boolean): Subpath {
  const segments: Segment[] = []
  for (let n = 1; n < pts.length; n++) segments.push({ k: 'L', p0: pts[n - 1] as Pt, p1: pts[n] as Pt })
  const first = pts[0] as Pt
  const last = pts[pts.length - 1] as Pt
  if (closed && (first[0] !== last[0] || first[1] !== last[1])) segments.push({ k: 'L', p0: last, p1: first })
  return { start: first, segments, closed }
}

// ---- evaluation ------------------------------------------------------------------------------------------------

export function arcPoint(s: Extract<Segment, { k: 'A' }>, t: number): Pt {
  const a = s.theta + s.dtheta * t
  const cos = Math.cos(s.phi)
  const sin = Math.sin(s.phi)
  const x = s.rx * Math.cos(a)
  const y = s.ry * Math.sin(a)
  return [s.cx + cos * x - sin * y, s.cy + sin * x + cos * y]
}

/** The point of `s` at parameter t in [0, 1]. */
export function pointAt(s: Segment, t: number): Pt {
  if (t <= 0) return s.p0
  if (t >= 1) return s.p1
  const u = 1 - t
  switch (s.k) {
    case 'L':
      return [s.p0[0] + (s.p1[0] - s.p0[0]) * t, s.p0[1] + (s.p1[1] - s.p0[1]) * t]
    case 'Q':
      return [
        u * u * s.p0[0] + 2 * u * t * s.c[0] + t * t * s.p1[0],
        u * u * s.p0[1] + 2 * u * t * s.c[1] + t * t * s.p1[1],
      ]
    case 'C':
      return [
        u * u * u * s.p0[0] + 3 * u * u * t * s.c1[0] + 3 * u * t * t * s.c2[0] + t * t * t * s.p1[0],
        u * u * u * s.p0[1] + 3 * u * u * t * s.c1[1] + 3 * u * t * t * s.c2[1] + t * t * t * s.p1[1],
      ]
    case 'A':
      return arcPoint(s, t)
  }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** An upper bound of a segment's length (its control polygon; the arc's radius times its sweep). */
function lengthBound(s: Segment): number {
  switch (s.k) {
    case 'L':
      return dist(s.p0, s.p1)
    case 'Q':
      return dist(s.p0, s.c) + dist(s.c, s.p1)
    case 'C':
      return dist(s.p0, s.c1) + dist(s.c1, s.c2) + dist(s.c2, s.p1)
    case 'A':
      return Math.max(s.rx, s.ry) * Math.abs(s.dtheta)
  }
}

/** The subpath as points uniformly spaced in each segment's parameter, at most about `step` apart. */
export function sample(sp: Subpath, step: number): Pt[] {
  const out: Pt[] = [sp.start]
  for (const s of sp.segments) {
    if (s.k === 'L') {
      out.push(s.p1)
      continue
    }
    const n = Math.max(2, Math.ceil(lengthBound(s) / step))
    for (let j = 1; j <= n; j++) out.push(pointAt(s, j / n))
  }
  return out
}

/** Distance of `p` from the infinite line through a and b (from a, when a = b). */
function lineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return dist(p, a)
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len
}

function flattenCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, tol: number, out: Pt[], depth: number): void {
  if (depth >= 18 || Math.max(lineDistance(c1, p0, p1), lineDistance(c2, p0, p1)) <= tol) {
    out.push(p1)
    return
  }
  // de Casteljau at the middle
  const m = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const a = m(p0, c1)
  const b = m(c1, c2)
  const c = m(c2, p1)
  const d = m(a, b)
  const e = m(b, c)
  const f = m(d, e)
  flattenCubic(p0, a, d, f, tol, out, depth + 1)
  flattenCubic(f, e, c, p1, tol, out, depth + 1)
}

/**
 * The subpath as a polyline within `tol` of the curve: a Bézier is cut until its control points are within `tol`
 * of the chord (the curve lies in their hull), an arc into equal steps whose sagitta is at most `tol`.
 */
export function flatten(sp: Subpath, tol: number): Pt[] {
  const out: Pt[] = [sp.start]
  for (const s of sp.segments) {
    switch (s.k) {
      case 'L':
        out.push(s.p1)
        break
      case 'Q': {
        // the cubic of the same curve
        const c1: Pt = [s.p0[0] + (2 / 3) * (s.c[0] - s.p0[0]), s.p0[1] + (2 / 3) * (s.c[1] - s.p0[1])]
        const c2: Pt = [s.p1[0] + (2 / 3) * (s.c[0] - s.p1[0]), s.p1[1] + (2 / 3) * (s.c[1] - s.p1[1])]
        flattenCubic(s.p0, c1, c2, s.p1, tol, out, 0)
        break
      }
      case 'C':
        flattenCubic(s.p0, s.c1, s.c2, s.p1, tol, out, 0)
        break
      case 'A': {
        const r = Math.max(s.rx, s.ry)
        // the largest step whose sagitta r(1 - cos(step/2)) is at most tol
        const maxStep = r <= tol ? Math.PI / 2 : 2 * Math.acos(1 - tol / r)
        const n = Math.max(1, Math.ceil(Math.abs(s.dtheta) / maxStep))
        for (let j = 1; j < n; j++) out.push(arcPoint(s, j / n))
        out.push(s.p1)
        break
      }
    }
  }
  return out
}
