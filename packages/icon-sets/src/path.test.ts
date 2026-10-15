// The SVG path parser and the two ways to walk a path (OWNER: WS1, wave Q): every command, relative and absolute,
// implicit repeats, compact numbers and arc flags, the arc's centre form, and flattening within its tolerance.
import { describe, expect, it } from 'vitest'
import {
  arcSegment,
  ellipseSubpath,
  flatten,
  PathError,
  type Pt,
  parsePath,
  parsePoints,
  pointAt,
  rectSubpath,
  type Segment,
  sample,
} from './path.ts'

const close = (a: Pt, b: Pt, eps = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps
const round6 = (p: Pt) => p.map((v) => +v.toFixed(6))
const ends = (d: string) => parsePath(d).map((sp) => [sp.start, ...sp.segments.map((s) => s.p1)].map(round6))

describe('parsePath', () => {
  it('reads lines in every spelling: M/L/H/V, relative, implicit linetos after a moveto, Z back to the start', () => {
    expect(ends('M3 4L5 6H9V2Z')).toEqual([
      [
        [3, 4],
        [5, 6],
        [9, 6],
        [9, 2],
        [3, 4],
      ],
    ])
    expect(ends('m1 1 2 0 0 2h-2z')).toEqual([
      [
        [1, 1],
        [3, 1],
        [3, 3],
        [1, 3],
        [1, 1],
      ],
    ])
    // after Z the pen is at the subpath's start; a relative moveto starts from there
    expect(ends('M2 2h2v2zm4 0h1')).toEqual([
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 2],
      ],
      [
        [6, 2],
        [7, 2],
      ],
    ])
    const [sp] = parsePath('M2 2h2v2z')
    expect(sp?.closed).toBe(true)
  })

  it('reads compact numbers: signs as separators, leading dots, exponents', () => {
    expect(ends('M12 17h.01')).toEqual([
      [
        [12, 17],
        [12.01, 17],
      ],
    ])
    expect(ends('M1-2.5.5.5l-1e1 2E-1')).toEqual([
      [
        [1, -2.5],
        [0.5, 0.5],
        [-9.5, 0.7],
      ],
    ])
  })

  it('reads Béziers, and S and T reflect the previous control point', () => {
    const [sp] = parsePath('M0 0C0 1 1 2 2 2S4 3 4 4Q5 5 6 4T8 4')
    const segs = sp?.segments as Segment[]
    expect(segs.map((s) => s.k)).toEqual(['C', 'C', 'Q', 'Q'])
    const s2 = segs[1] as Extract<Segment, { k: 'C' }>
    // the reflection of (1, 2) about (2, 2)
    expect(s2.c1).toEqual([3, 2])
    const t = segs[3] as Extract<Segment, { k: 'Q' }>
    // the reflection of (5, 5) about (6, 4)
    expect(t.c).toEqual([7, 3])
    // S without a cubic before it takes the current point
    const [s] = parsePath('M0 0S1 1 2 0')
    expect((s?.segments[0] as Extract<Segment, { k: 'C' }> | undefined)?.c1).toEqual([0, 0])
  })

  it('reads arcs with compact flags (Lucide writes "a2 2 0 012 2" and "a.5.5 0 0 1 .923 0")', () => {
    const [a] = parsePath('M10 10a2 2 0 012 2')
    const seg = a?.segments[0] as Extract<Segment, { k: 'A' }>
    expect(seg.k).toBe('A')
    expect(close(seg.p1, [12, 12])).toBe(true)
    expect(close([seg.cx, seg.cy], [10, 12], 1e-9)).toBe(true)
    const [b] = parsePath('m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16')
    expect(b?.segments.map((s) => s.k)).toEqual(['L', 'A', 'L'])
  })

  it('refuses malformed data', () => {
    for (const d of ['M1', 'L1 2', 'M1 2 X3', 'M1 2a1 1 0 2 0 3 3', '12', 'M1 2z3 4'])
      expect(() => parsePath(d), d).toThrow(PathError)
  })
})

describe('arcs', () => {
  it('a semicircle has its centre between its ends and turns half a circle the asked way', () => {
    const s = arcSegment([3, 12], [21, 12], 9, 9, 0, true, true) as Extract<Segment, { k: 'A' }>
    expect(close([s.cx, s.cy], [12, 12], 1e-9)).toBe(true)
    expect(Math.abs(s.dtheta)).toBeCloseTo(Math.PI, 9)
    // sweep=1 is clockwise on screen (y down): through the top, y = 3
    expect(pointAt(s, 0.5)[1]).toBeCloseTo(3, 9)
    const ccw = arcSegment([3, 12], [21, 12], 9, 9, 0, true, false)
    expect(pointAt(ccw, 0.5)[1]).toBeCloseTo(21, 9)
  })

  it('radii too small for the ends are scaled up (SVG F.6.6); a zero radius is a line', () => {
    const s = arcSegment([0, 0], [10, 0], 1, 1, 0, false, true) as Extract<Segment, { k: 'A' }>
    expect(s.rx).toBeCloseTo(5, 9)
    expect(arcSegment([0, 0], [10, 0], 0, 3, 0, false, true).k).toBe('L')
  })

  it("Tabler's two-half-arc circle stays on its circle", () => {
    const [sp] = parsePath('M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0')
    for (const p of sample(sp as never, 0.05)) expect(Math.hypot(p[0] - 12, p[1] - 12)).toBeCloseTo(9, 9)
  })
})

describe('flatten and sample', () => {
  const maxGap = (fine: readonly Pt[], coarse: readonly Pt[]) => {
    let worst = 0
    for (const p of fine) {
      let best = Number.POSITIVE_INFINITY
      for (let n = 1; n < coarse.length; n++) {
        const a = coarse[n - 1] as Pt
        const b = coarse[n] as Pt
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const l2 = dx * dx + dy * dy
        const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
        best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]))
      }
      worst = Math.max(worst, best)
    }
    return worst
  }

  it('keeps every flattened curve within its tolerance of the curve', () => {
    for (const d of [
      'M2 12C2 2 22 2 22 12',
      'M4 20Q12 -4 20 20',
      'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0 -18',
      'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z',
      'M5 5a10 4 30 1 1 14 14',
    ]) {
      const [sp] = parsePath(d)
      if (!sp) throw new Error(d)
      for (const tol of [0.01, 0.04, 0.1]) {
        const coarse = flatten(sp, tol)
        expect(maxGap(sample(sp, 0.005), coarse), `${d} at ${tol}`).toBeLessThanOrEqual(tol + 1e-9)
        expect(coarse[0]).toEqual(sp.start)
      }
    }
  })

  it('the shapes: an ellipse of four quarter arcs, a rect with SVG radii (clamped to half a side)', () => {
    const e = ellipseSubpath(12, 12, 10, 5)
    for (const p of sample(e, 0.05))
      expect(((p[0] - 12) / 10) ** 2 + ((p[1] - 12) / 5) ** 2).toBeCloseTo(1, 9)
    const r = rectSubpath(2, 2, 20, 4, 3)
    // ry defaults to rx (3), clamped to half the height (2)
    const corner = r.segments.find((s) => s.k === 'A') as Extract<Segment, { k: 'A' }>
    expect([corner.rx, corner.ry]).toEqual([3, 2])
    const ptsY = sample(r, 0.05).map((p) => p[1])
    expect(Math.min(...ptsY)).toBeCloseTo(2, 9)
    expect(Math.max(...ptsY)).toBeCloseTo(6, 9)
    expect(parsePoints('1,2 3 4')).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(() => parsePoints('1 2 3')).toThrow(PathError)
  })
})
