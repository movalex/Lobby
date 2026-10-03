/**
 * Unit tests of the rule-7 helpers (docs/EXCALIDRAW-MIGRATION.md §2.9.4 rule 7) in plain Node: the
 * re-snap of straight, curved, rotated, self-loop and elbow arrows against Excalidraw's own follow, the
 * rounding rule, "equal after rounding writes nothing", and the two Node probes the plan keeps as unit
 * tests: elbow routing without a Scene or a DOM (critic-3.2, r33-check: start y 90 for height 180) and
 * the arrow label's position helper (critic-r33 label-node: (120, 37.5)).
 */
import * as element from '@excalidraw/element'
import { beforeAll, describe, expect, it } from 'vitest'
import { pathUnitOf, sameUserSetGeometry, userSetGeometry } from '../groups.ts'
import { GEOMETRY_TOLERANCE_PX as TOL } from '../limits.ts'
import {
  type ArrowElementLike,
  arrowLabelLayout,
  bindingGap,
  resnapArrow,
  resnapLinearArrow,
  routeElbowArrow,
} from './binding.ts'
import { installServerTextMetrics } from './text-metrics.ts'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element objects, typed loosely on purpose
type El = any
// biome-ignore lint/suspicious/noExplicitAny: the engine module
const X = element as any
const LEE = X.LinearElementEditor

beforeAll(() => {
  installServerTextMetrics()
})

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const fakeScene = (map: Map<string, El>) => ({
  mutateElement: (el: El, u: El, o?: El) => X.mutateElement(el, map, u, o),
  getNonDeletedElementsMap: () => map,
  getElementsMapIncludingDeleted: () => map,
  getNonDeletedElements: () => [...map.values()],
  triggerUpdate: () => {},
})
const rect = (o: El) => X.newElement({ type: 'rectangle', roughness: 0, ...o })
const arrow = (o: El) => X.newArrowElement({ type: 'arrow', roughness: 0, ...o })
function bind(a: El, s: El | null, e: El | null, fs = [1, 0.5], fe = [0, 0.5]) {
  a.startBinding = s ? { elementId: s.id, fixedPoint: fs, mode: 'orbit' } : null
  a.endBinding = e ? { elementId: e.id, fixedPoint: fe, mode: 'orbit' } : null
  for (const t of [s, e]) if (t) t.boundElements = [...(t.boundElements ?? []), { id: a.id, type: 'arrow' }]
  return a
}
const glob = (a: El, i: number, map: Map<string, El>) => {
  const p = LEE.getPointAtIndexGlobalCoordinates(a, i, map)
  return [p[0], p[1]] as [number, number]
}
const dist = (p: number[], q: number[]) =>
  Math.max(Math.abs((p[0] ?? 0) - (q[0] ?? 0)), Math.abs((p[1] ?? 0) - (q[1] ?? 0)))
/** How far one more of Excalidraw's own follows would move the bound ends (0 = on the edge). */
function followError(map: Map<string, El>, id: string): number {
  const m = new Map([...map].map(([k, v]) => [k, clone(v)]))
  const a = m.get(id)
  const ups: [number, { point: number[] }][] = []
  for (const [prop, idx] of [
    ['startBinding', 0],
    ['endBinding', a.points.length - 1],
  ] as const) {
    const b = a[prop]
    if (!b) continue
    const p = X.updateBoundPoint(a, prop, b, m.get(b.elementId), m)
    if (p) ups.push([idx, { point: p }])
  }
  if (!ups.length) return 0
  const before = ups.map(([i]) => glob(map.get(id), i, map))
  const loop = a.startBinding && a.endBinding && a.startBinding.elementId === a.endBinding.elementId
  LEE.movePoints(a, fakeScene(m), new Map(ups), { moveMidPointsWithElement: !!loop })
  return Math.max(...ups.map(([i], k) => dist(glob(a, i, m), before[k] as number[])))
}
/** Applies a result's unit to a copy of the arrow and returns the scene with it. */
function applied(map: Map<string, El>, id: string, unit: object): Map<string, El> {
  const m = new Map([...map].map(([k, v]) => [k, clone(v)]))
  const a = m.get(id)
  for (const f of ['fixedSegments', 'startIsSpecial', 'endIsSpecial']) if (!(f in unit)) delete a[f]
  Object.assign(a, clone(unit))
  return m
}
const decimals2 = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6

function startBound(angle = 0) {
  const T = rect({ x: 0, y: 0, width: 200, height: 100 })
  const A = {
    ...arrow({ x: 205, y: 50 }),
    points: [
      [0, 0],
      [300, 300],
    ],
    width: 300,
    height: 300,
    angle,
    startArrowhead: null,
  }
  bind(A, T, null)
  return { T, A }
}

describe('resnapLinearArrow', () => {
  for (const angle of [0, 0.6])
    it(`angle ${angle}: after the target grows, the bound start is on the new edge and the free end stays put`, () => {
      const { T, A } = startBound(angle)
      const map = new Map<string, El>([
        [T.id, T],
        [A.id, A],
      ])
      const freeBefore = glob(A, -1, map)
      const inputs = clone([T, A])
      T.height = 180
      const r = resnapLinearArrow(A as ArrowElementLike, map)
      expect(r.changed).toBe(true)
      const m = applied(map, A.id, r.path)
      expect(followError(m, A.id)).toBeLessThanOrEqual(TOL)
      expect(dist(glob(m.get(A.id), -1, m), freeBefore)).toBeLessThanOrEqual(TOL)
      // rounding: points always; x, y only unrotated
      for (const [px, py] of r.path.points) expect(decimals2(px) && decimals2(py)).toBe(true)
      expect(decimals2(r.path.x) && decimals2(r.path.y)).toBe(
        angle === 0 ? true : decimals2(r.path.x) && decimals2(r.path.y),
      )
      // the whole unit, never a part
      expect(Object.keys(r.path).sort()).toEqual(Object.keys(pathUnitOf(A)).sort())
      // inputs untouched (the helpers work on copies)
      expect(clone(A)).toEqual(inputs[1])
      // a second re-snap of the result writes nothing
      const again = resnapLinearArrow(m.get(A.id), m)
      expect(again.changed).toBe(false)
    })

  it('a rotated arrow keeps full precision in x, y (rounding them would make the free end creep)', () => {
    const { T, A } = startBound(0.6)
    const map = new Map<string, El>([
      [T.id, T],
      [A.id, A],
    ])
    T.height = 137.123
    const r = resnapLinearArrow(A as ArrowElementLike, map)
    expect(decimals2(r.path.x) && decimals2(r.path.y)).toBe(false)
  })

  it('a curved arrow keeps its midpoint in scene coordinates when both targets move', () => {
    const T = rect({ x: 0, y: 0, width: 200, height: 100 })
    const U = rect({ x: 500, y: 300, width: 200, height: 100 })
    const A = {
      ...arrow({ x: 205, y: 50 }),
      roundness: { type: 2 },
      points: [
        [0, 0],
        [150, 50],
        [290, 300],
      ],
      startArrowhead: null,
    }
    bind(A, T, U)
    const map = new Map<string, El>([
      [T.id, T],
      [U.id, U],
      [A.id, A],
    ])
    const mid = glob(A, 1, map)
    Object.assign(T, { x: 40, y: 90 })
    Object.assign(U, { x: 600, y: 500 })
    const r = resnapArrow(A as ArrowElementLike, map)
    const m = applied(map, A.id, r.path)
    expect(dist(glob(m.get(A.id), 1, m), mid)).toBeLessThanOrEqual(TOL)
    expect(followError(m, A.id)).toBeLessThanOrEqual(TOL)
  })

  it('an unbound arrow, or one whose target is gone, is left where it is', () => {
    const { T, A } = startBound()
    const free = { ...A, startBinding: null }
    expect(resnapArrow(free as ArrowElementLike, new Map([[A.id, free]])).changed).toBe(false)
    expect(resnapArrow(A as ArrowElementLike, new Map([[A.id, A]])).changed).toBe(false) // target missing
    const gone = { ...T, isDeleted: true, height: 500 }
    expect(
      resnapArrow(
        A as ArrowElementLike,
        new Map<string, El>([
          [T.id, gone],
          [A.id, A],
        ]),
      ).changed,
    ).toBe(false)
  })

  it('a self-loop settles in one call (at most 4 re-snaps) and its midpoints keep their offset from the start', () => {
    const T = rect({ x: 0, y: 0, width: 200, height: 100 })
    const A = {
      ...arrow({ x: 205, y: 30 }),
      roundness: { type: 2 },
      points: [
        [0, 0],
        [80, -60],
        [60, 50],
      ],
      startArrowhead: null,
    }
    bind(A, T, T, [1, 0.3], [1, 0.7])
    const map = new Map<string, El>([
      [T.id, T],
      [A.id, A],
    ])
    const rel = userSetGeometry(A, map)
    Object.assign(T, { x: 40, y: 150 })
    const r = resnapArrow(A as ArrowElementLike, map)
    const m = applied(map, A.id, r.path)
    expect(sameUserSetGeometry(userSetGeometry(m.get(A.id), m), rel)).toBe(true)
    const again = resnapArrow(m.get(A.id), m)
    const m2 = applied(m, A.id, again.path)
    expect(dist(glob(m2.get(A.id), 0, m2), glob(m.get(A.id), 0, m))).toBeLessThanOrEqual(TOL)
  })
})

describe('routeElbowArrow (elbow routing in plain Node, no Scene, no DOM)', () => {
  function elbow(fixAt?: number) {
    const T = rect({ x: 0, y: 0, width: 200, height: 100 })
    const U = rect({ x: 500, y: 300, width: 200, height: 100 })
    const A = {
      ...arrow({ x: 205, y: 50, elbowed: true }),
      points: [
        [0, 0],
        [290, 300],
      ],
    }
    bind(A, T, U)
    const map = new Map<string, El>([
      [T.id, T],
      [U.id, U],
      [A.id, A],
    ])
    Object.assign(A, X.updateElbowArrowPoints(A, map, { points: A.points }, {}))
    if (fixAt !== undefined) LEE.moveFixedSegment({ elementId: A.id }, 2, fixAt, 0, fakeScene(map))
    return { T, U, A, map }
  }
  const orthogonal = (a: El) =>
    a.points
      .slice(1)
      .every(
        (p: [number, number], i: number) =>
          Math.abs(p[0] - a.points[i][0]) < 1e-6 || Math.abs(p[1] - a.points[i][1]) < 1e-6,
      )

  it("the critic's probe: X grows to 180 high, the route follows (start y 90), orthogonal, the router's whole output", () => {
    const { T, A, map } = elbow()
    T.height = 180
    const r = routeElbowArrow(A as ArrowElementLike, map)
    expect(r.changed).toBe(true)
    const m = applied(map, A.id, r.path)
    const a = m.get(A.id)
    expect(glob(a, 0, m)[1]).toBeCloseTo(90, 1)
    expect(orthogonal(a)).toBe(true)
    expect(r.path.angle).toBe(0)
    for (const f of [
      'x',
      'y',
      'points',
      'width',
      'height',
      'angle',
      'elbowed',
      'startIsSpecial',
      'endIsSpecial',
    ])
      expect(f in r.path).toBe(true)
    expect(followError(m, A.id)).toBeLessThanOrEqual(TOL)
  })

  it('the lead-r34 probe: a fixed segment at x 400 stays at x 400 when X moves 80 down and grows 40', () => {
    const { T, A, map } = elbow(400)
    Object.assign(T, { y: 80, height: 140 })
    const r = routeElbowArrow(A as ArrowElementLike, map)
    const segs = (r.path.fixedSegments ?? []).map((s) => r.path.x + s.start[0])
    expect(segs).toHaveLength(1)
    expect(Math.abs((segs[0] ?? 0) - 400)).toBeLessThanOrEqual(TOL)
    const m = applied(map, A.id, r.path)
    expect(orthogonal(m.get(A.id))).toBe(true)
  })

  it('refuses the wrong kind', () => {
    const { A, map } = elbow()
    expect(() => resnapLinearArrow(A as ArrowElementLike, map)).toThrow(/elbow/)
    const s = startBound()
    expect(() => routeElbowArrow(s.A as ArrowElementLike, new Map([[s.A.id, s.A]]))).toThrow(/not an elbow/)
  })
})

describe('arrowLabelLayout', () => {
  it("the critic's label-node probe: (120, 37.5), then (220, 137.5) after the arrow grew", () => {
    const A = {
      ...arrow({ x: 0, y: 0 }),
      width: 300,
      height: 100,
      points: [
        [0, 0],
        [300, 100],
      ],
      boundElements: [{ id: 't1', type: 'text' }],
    }
    const T = {
      id: 't1',
      type: 'text',
      x: 0,
      y: 0,
      width: 60,
      height: 25,
      containerId: A.id,
      labelPosition: null,
      version: 1,
      angle: 0,
    }
    expect(arrowLabelLayout(A as ArrowElementLike, T as never, new Map(), { leased: true })).toEqual({
      x: 120,
      y: 37.5,
    })
    const A2 = {
      ...A,
      version: A.version + 1,
      points: [
        [0, 0],
        [500, 300],
      ],
      width: 500,
      height: 300,
    }
    expect(arrowLabelLayout(A2 as ArrowElementLike, T as never, new Map(), { leased: true })).toEqual({
      x: 220,
      y: 137.5,
    })
  })

  it('unleased: re-wraps the words to the arrow and returns the box; fontSize and originalText never change', () => {
    const A = {
      ...arrow({ x: 0, y: 0 }),
      width: 120,
      height: 0,
      points: [
        [0, 0],
        [120, 0],
      ],
    }
    const T = X.newTextElement({
      text: 'a label that is long',
      originalText: 'a label that is long',
      fontSize: 20,
      fontFamily: 5,
      containerId: A.id,
      textAlign: 'center',
      verticalAlign: 'middle',
    })
    const lay = arrowLabelLayout(A as ArrowElementLike, T, new Map(), { leased: false })
    expect(lay.text).toEqual(expect.any(String))
    expect((lay.text ?? '').replace(/\n/g, ' ')).toBe('a label that is long')
    expect(lay.width).toBeGreaterThan(0)
    expect(lay.height).toBeGreaterThan(0)
    expect(T.fontSize).toBe(20)
  })
})

describe('W5-53: one binding gap', () => {
  it("is the pinned engine's own getBindingGap (BASE_BINDING_GAP + strokeWidth / 2) for every stroke", () => {
    for (const strokeWidth of [0, 1, 2, 3.5, 4, 8.25])
      expect(bindingGap({ strokeWidth })).toBe(X.getBindingGap({ strokeWidth }))
    expect(bindingGap({ strokeWidth: 2 })).toBe(X.BASE_BINDING_GAP + 1)
    // a stored element with a missing or bad stroke width reads as 0 (as the room's copies did)
    expect(bindingGap({ strokeWidth: Number.NaN })).toBe(X.BASE_BINDING_GAP)
  })
})
