/**
 * Contract tests of groups.ts (spike B contracts step C0; docs/EXCALIDRAW-MIGRATION.md §3.2, §6.1).
 * Samples come from the pinned engine's own constructors, as spike A's history coverage test built them,
 * so an Excalidraw bump that adds a field fails the coverage test instead of silently never syncing it.
 */
import {
  LinearElementEditor,
  mutateElement,
  newArrowElement,
  newElement,
  newFrameElement,
  newFreeDrawElement,
  newImageElement,
  newLinearElement,
  newStickyNoteElement,
  newTextElement,
  setCustomTextMetricsProvider,
  updateBoundElements,
  updateElbowArrowPoints,
} from '@excalidraw/element'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  compareArrowChange,
  coverageProblems,
  ELEMENT_KINDS,
  FIELD_GROUPS,
  fieldGroupOf,
  fieldsOfGroup,
  isDerivedArrowChange,
  kindOf,
  overlayPatch,
  pathUnitOf,
  pathUnitProblem,
  sameUserSetGeometry,
  stripEngineArtifacts,
  type UserSetGeometry,
  userSetGeometry,
  userSetGeometryDelta,
} from './groups.ts'
import { GEOMETRY_TOLERANCE_PX } from './limits.ts'
import { GROUP_FIELDS } from './protocol.ts'

// biome-ignore lint/suspicious/noExplicitAny: the engine's own element objects, built by its constructors
type Any = any
const base = { x: 0, y: 0, width: 100, height: 100 }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const cloneMap = (m: Map<string, Any>) => new Map([...m].map(([k, v]) => [k, clone(v)]))
const fakeScene = (map: Map<string, Any>) => ({
  mutateElement: (el: Any, u: Any, o?: Any) => (mutateElement as Any)(el, map, u, o),
  getNonDeletedElementsMap: () => map,
  getElementsMapIncludingDeleted: () => map,
  getNonDeletedElements: () => [...map.values()],
  triggerUpdate: () => {},
})

beforeAll(() => {
  setCustomTextMetricsProvider({ getLineWidth: (t: string) => t.length * 10 } as never)
})

/** One sample of every kind, built by the engine (spike A's samples). */
const samples = (): Any[] => [
  newElement({ ...base, type: 'rectangle' } as never),
  newElement({ ...base, type: 'ellipse' } as never),
  newElement({ ...base, type: 'diamond' } as never),
  newStickyNoteElement({ ...base, type: 'stickynote' } as never),
  newTextElement({ ...base, text: 'x' } as never),
  newTextElement({ ...base, text: 'x', containerId: 'c' } as never),
  newArrowElement({ ...base, type: 'arrow' } as never),
  newArrowElement({ ...base, type: 'arrow', elbowed: true } as never),
  newLinearElement({ ...base, type: 'line' } as never),
  newFreeDrawElement({ ...base, type: 'freedraw', simulatePressure: true } as never),
  newImageElement({ ...base, type: 'image' } as never),
  newFrameElement({ ...base } as never),
]

describe('the field-group map (§3.2)', () => {
  it('coverage: every key of every element type is in exactly one group, or server-owned, local-only or customData', () => {
    const report = Object.fromEntries(
      samples().map((e) => [
        `${e.type}${e.containerId ? ':label' : ''}${e.elbowed ? ':elbow' : ''}`,
        coverageProblems(e),
      ]),
    )
    for (const [kind, r] of Object.entries(report)) {
      expect(r.unclassified, `${kind} unclassified`).toEqual([])
      expect(r.doubled, `${kind} doubled`).toEqual([])
    }
  })

  it('covers every kind, and every map field is in its group of the wire vocabulary', () => {
    expect(new Set(samples().map((e) => kindOf(e)))).toEqual(new Set(ELEMENT_KINDS))
    for (const [kind, map] of Object.entries(FIELD_GROUPS))
      for (const [field, group] of Object.entries(map))
        expect(GROUP_FIELDS[group], `${kind}.${field}`).toContain(field)
  })

  it('an arrow and a line keep their whole geometry in `path`; `angle` is in `shape` for every other kind', () => {
    expect(fieldsOfGroup('arrow', 'path').sort()).toEqual(
      [
        'x',
        'y',
        'points',
        'width',
        'height',
        'angle',
        'fixedSegments',
        'startIsSpecial',
        'endIsSpecial',
        'elbowed',
      ].sort(),
    )
    expect(fieldsOfGroup('line', 'path').sort()).toEqual(
      ['x', 'y', 'points', 'width', 'height', 'angle', 'polygon'].sort(),
    )
    for (const kind of ELEMENT_KINDS) {
      if (kind === 'arrow' || kind === 'line') expect(fieldsOfGroup(kind, 'shape')).not.toContain('angle')
      else expect(FIELD_GROUPS[kind].angle, kind).toBe('shape')
    }
    expect(fieldsOfGroup('arrow', 'pos')).toEqual([])
    expect(fieldsOfGroup('line', 'pos')).toEqual([])
  })

  it('the engine’s stray moveMidPointsWithElement (written by movePoints via updateBoundElements) is in no group and is stripped', () => {
    const { X, A, S } = startBound(0)
    const B = cloneMap(S)
    ;(mutateElement as Any)(B.get(X.id), B, { height: 180 })
    updateBoundElements(B.get(X.id) as never, fakeScene(B) as never)
    const followed = B.get(A.id) as Any
    expect('moveMidPointsWithElement' in followed).toBe(true) // the engine quirk this rule exists for
    expect(fieldGroupOf(followed, 'moveMidPointsWithElement')).toBeNull()
    expect(coverageProblems(followed)).toEqual({ unclassified: [], doubled: [] })
    const clean = stripEngineArtifacts(followed)
    expect('moveMidPointsWithElement' in clean).toBe(false)
    expect(stripEngineArtifacts(A)).toBe(A)
  })

  it('a bound label’s position, size and font size are layout; a free text’s box is layout and its x, y pos', () => {
    const label = { type: 'text', containerId: 'c' }
    const free = { type: 'text', containerId: null }
    for (const f of ['x', 'y', 'width', 'height', 'fontSize', 'text'])
      expect(fieldGroupOf(label, f), f).toBe('layout')
    expect(fieldGroupOf(free, 'x')).toBe('pos')
    expect(fieldGroupOf(free, 'width')).toBe('layout')
    expect(fieldGroupOf(free, 'fontSize')).toBe('textStyle')
    expect(fieldGroupOf(free, 'originalText')).toBe('text')
    expect(fieldGroupOf({ type: 'image' }, 'status')).toBeNull()
    expect(fieldGroupOf({ type: 'rectangle' }, 'version')).toBeNull()
    expect(fieldGroupOf({ type: 'rectangle' }, 'customData')).toBeNull()
  })
})

describe('the path unit (§2.4.2, revisions 3.4 and 3.5)', () => {
  it('pathUnitOf carries the whole unit, with the elbow fields when the arrow has them', () => {
    const plain = newArrowElement({ ...base, type: 'arrow' } as never) as Any
    const elbow = newArrowElement({ ...base, type: 'arrow', elbowed: true } as never) as Any
    const line = newLinearElement({ ...base, type: 'line' } as never) as Any
    expect(Object.keys(pathUnitOf(plain)).sort()).toEqual([
      'angle',
      'elbowed',
      'height',
      'points',
      'width',
      'x',
      'y',
    ])
    expect(Object.keys(pathUnitOf(elbow)).sort()).toEqual(
      [
        'angle',
        'elbowed',
        'endIsSpecial',
        'fixedSegments',
        'height',
        'points',
        'startIsSpecial',
        'width',
        'x',
        'y',
      ].sort(),
    )
    expect(Object.keys(pathUnitOf(line)).sort()).toEqual([
      'angle',
      'height',
      'points',
      'polygon',
      'width',
      'x',
      'y',
    ])
    for (const el of [plain, elbow, line]) expect(pathUnitProblem(pathUnitOf(el))).toBeNull()
    expect(() => pathUnitOf(newElement({ ...base, type: 'rectangle' } as never) as Any)).toThrow()
  })

  it('a path unit missing any field is refused (angle, the elbow flags and polygon included)', () => {
    const elbow = pathUnitOf(newArrowElement({ ...base, type: 'arrow', elbowed: true } as never) as Any)
    const line = pathUnitOf(newLinearElement({ ...base, type: 'line' } as never) as Any)
    for (const f of Object.keys(elbow)) {
      const { [f]: _, ...rest } = elbow
      expect(pathUnitProblem(rest), `arrow without ${f}`).not.toBeNull()
    }
    for (const f of Object.keys(line)) {
      const { [f]: _, ...rest } = line
      expect(pathUnitProblem(rest, 'line'), `line without ${f}`).not.toBeNull()
    }
    expect(pathUnitProblem({ ...elbow, polygon: false })).not.toBeNull()
    expect(pathUnitProblem(line, 'arrow')).not.toBeNull()
  })

  it('overlayPatch applies a path unit whole (a dropped elbow field is removed) and other groups field by field', () => {
    const elbow = newArrowElement({ ...base, type: 'arrow', elbowed: true } as never) as Any
    const unit = { ...pathUnitOf(elbow), elbowed: false }
    for (const f of ['fixedSegments', 'startIsSpecial', 'endIsSpecial']) delete (unit as Any)[f]
    const out = overlayPatch(elbow, { g: { path: unit, style: { strokeColor: '#ff0000' } } })
    expect(out.elbowed).toBe(false)
    expect('fixedSegments' in out).toBe(false)
    expect(out.strokeColor).toBe('#ff0000')
    const withKeys = overlayPatch(elbow, { c: { alt: 'a', kind: 'highlight' } })
    expect(withKeys.customData).toEqual({ lobby: { alt: 'a', kind: 'highlight' } })
    expect(overlayPatch(withKeys, { c: { alt: null, kind: null } }).customData).toBeUndefined()
    const bound = overlayPatch(
      { ...elbow, boundElements: [{ id: 't', type: 'text' }] },
      { b: { add: [{ id: 'a2', type: 'arrow' }], rm: ['t'] } },
    )
    expect(bound.boundElements).toEqual([{ id: 'a2', type: 'arrow' }])
  })
})

// ---- user-set geometry -----------------------------------------------------------------------------------

/** A start-bound arrow with a free end, snapped onto X the way the probes set it up. */
function startBound(angle = 0) {
  const X = newElement({ type: 'rectangle', x: 0, y: 0, width: 200, height: 100 } as never) as Any
  const A = {
    ...(newArrowElement({ type: 'arrow', x: 205, y: 50 } as never) as Any),
    width: 300,
    height: 300,
    points: [
      [0, 0],
      [300, 300],
    ],
    angle,
    startArrowhead: null,
    endArrowhead: 'arrow',
    startBinding: { elementId: X.id, fixedPoint: [1, 0.5], mode: 'orbit' },
    endBinding: null,
  }
  X.boundElements = [{ id: A.id, type: 'arrow' }]
  return {
    X,
    A,
    S: new Map<string, Any>([
      [X.id, X],
      [A.id, A],
    ]),
  }
}

function elbowXY(preFixed: boolean) {
  const X = newElement({ type: 'rectangle', x: 0, y: 0, width: 200, height: 100 } as never) as Any
  const Y = newElement({ type: 'rectangle', x: 500, y: 300, width: 200, height: 100 } as never) as Any
  const A = {
    ...(newArrowElement({ type: 'arrow', x: 205, y: 50, elbowed: true } as never) as Any),
    points: [
      [0, 0],
      [290, 300],
    ],
    startBinding: { elementId: X.id, fixedPoint: [1, 0.5], mode: 'orbit' },
    endBinding: { elementId: Y.id, fixedPoint: [0, 0.5], mode: 'orbit' },
  }
  X.boundElements = [{ id: A.id, type: 'arrow' }]
  Y.boundElements = [{ id: A.id, type: 'arrow' }]
  const S = new Map<string, Any>([
    [X.id, X],
    [Y.id, Y],
    [A.id, A],
  ])
  Object.assign(A, (updateElbowArrowPoints as Any)(A, S, { points: A.points }, {}))
  if (preFixed) (LinearElementEditor as Any).moveFixedSegment({ elementId: A.id }, 2, 400, 0, fakeScene(S))
  return { X, Y, A, S }
}

describe('userSetGeometry (§2.9.4 rule 7, revision 3.5)', () => {
  it('a start-bound arrow: only its free end, in scene coordinates (rotation counts)', () => {
    const plain = startBound(0)
    const u = userSetGeometry(plain.A as never, plain.S)
    expect(u).toEqual({ kind: 'points', points: [{ index: 1, at: [505, 350] }] })
    const rot = startBound(0.6)
    const r = userSetGeometry(rot.A as never, rot.S) as Extract<UserSetGeometry, { kind: 'points' }>
    // the naive x + p reading would say (505, 350); the rotation-aware one does not (s1-rot-literal)
    expect(Math.abs((r.points[0]?.at[0] ?? 0) - 505)).toBeGreaterThan(10)
    const expected = (LinearElementEditor as Any).getPointAtIndexGlobalCoordinates(rot.A, 1, rot.S)
    expect(r.points[0]?.at[0]).toBeCloseTo(expected[0], 9)
    expect(r.points[0]?.at[1]).toBeCloseTo(expected[1], 9)
  })

  it('a curved arrow bound at both ends: its midpoints only', () => {
    const { X, S } = startBound(0)
    const Y = newElement({ type: 'ellipse', x: 500, y: 300, width: 200, height: 100 } as never) as Any
    const A = {
      ...(newArrowElement({ type: 'arrow', x: 205, y: 50 } as never) as Any),
      roundness: { type: 2 },
      points: [
        [0, 0],
        [150, 50],
        [290, 300],
      ],
      startBinding: { elementId: X.id, fixedPoint: [1, 0.5], mode: 'orbit' },
      endBinding: { elementId: Y.id, fixedPoint: [0, 0.5], mode: 'orbit' },
    }
    S.set(Y.id, Y).set(A.id, A)
    const u = userSetGeometry(A as never, S)
    expect(u.kind).toBe('points')
    expect((u as Extract<UserSetGeometry, { kind: 'points' }>).points.map((p) => p.index)).toEqual([1])
  })

  it('a self-loop: its midpoints relative to its start', () => {
    const { X, S } = startBound(0)
    const A = {
      ...(newArrowElement({ type: 'arrow', x: 205, y: 30 } as never) as Any),
      roundness: { type: 2 },
      points: [
        [0, 0],
        [80, -60],
        [60, 50],
      ],
      startBinding: { elementId: X.id, fixedPoint: [1, 0.3], mode: 'orbit' },
      endBinding: { elementId: X.id, fixedPoint: [1, 0.7], mode: 'orbit' },
    }
    S.set(A.id, A)
    const u = userSetGeometry(A as never, S)
    expect(u.kind).toBe('selfloop')
    const moved = { ...clone(A), x: A.x + 40, y: A.y + 150 }
    expect(sameUserSetGeometry(u, userSetGeometry(moved as never))).toBe(true) // a translation keeps relative midpoints
  })

  it('a line: every point', () => {
    const L = {
      ...(newLinearElement({ ...base, type: 'line' } as never) as Any),
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    }
    const u = userSetGeometry(L as never)
    expect(u).toEqual({
      kind: 'points',
      points: [0, 1, 2].map((index) => ({ index, at: [L.points[index][0], L.points[index][1]] })),
    })
  })

  it('an elbow arrow: its fixed segments by order, orientation and cross-axis position', () => {
    const { A, S } = elbowXY(true)
    const u = userSetGeometry(A as never, S)
    expect(u).toMatchObject({
      kind: 'elbow',
      start: null,
      end: null,
      segments: [{ orientation: 'vertical' }],
    })
    expect((u as Extract<UserSetGeometry, { kind: 'elbow' }>).segments[0]?.cross).toBeCloseTo(400, 6)
  })

  it('fixed segments are matched by order across a heading flip (index 2 → 3 is equal)', () => {
    const { X, A, S } = elbowXY(true)
    const conf = cloneMap(S)
    const B = cloneMap(S)
    ;(mutateElement as Any)(B.get(X.id), B, { angle: Math.PI / 2 })
    updateBoundElements(B.get(X.id) as never, fakeScene(B) as never)
    const before = conf.get(A.id) as Any
    const after = B.get(A.id) as Any
    expect(before.fixedSegments[0].index).toBe(2)
    expect(after.fixedSegments[0].index).toBe(3) // the router renumbered it
    expect(after.startIsSpecial).toBe(true)
    expect(sameUserSetGeometry(userSetGeometry(after, B), userSetGeometry(before, conf))).toBe(true)
    expect(isDerivedArrowChange(after as never, before as never, B, conf)).toBe(true)
  })

  it('a changed orientation or number of fixed segments is a difference, whatever the tolerance', () => {
    const e = (segments: Extract<UserSetGeometry, { kind: 'elbow' }>['segments']) =>
      ({ kind: 'elbow', start: null, end: null, segments }) as UserSetGeometry
    const one = e([{ orientation: 'vertical', cross: 400 }])
    expect(userSetGeometryDelta(one, e([{ orientation: 'horizontal', cross: 400 }]))).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(userSetGeometryDelta(one, e([]))).toBe(Number.POSITIVE_INFINITY)
    expect(sameUserSetGeometry(one, e([{ orientation: 'vertical', cross: 400.4 }]))).toBe(true)
    expect(sameUserSetGeometry(one, e([{ orientation: 'vertical', cross: 401 }]))).toBe(false)
  })
})

describe('the compare within GEOMETRY_TOLERANCE_PX (revision 3.5)', () => {
  it('floating-point noise and the server’s 2-decimal rounding are equal; a 1 px move is not', () => {
    const { A, S } = startBound(0)
    const u = userSetGeometry(A as never, S)
    const noisy = {
      ...clone(A),
      points: A.points.map(([x, y]: [number, number]) => [x + 5.7e-14, y - 5.7e-14]),
    }
    const rounded = {
      ...clone(A),
      x: 205.004,
      points: [
        [0, 0],
        [300.004, 299.996],
      ],
    }
    const moved = {
      ...clone(A),
      points: [
        [0, 0],
        [301, 300],
      ],
    }
    expect(sameUserSetGeometry(u, userSetGeometry(noisy as never))).toBe(true)
    expect(sameUserSetGeometry(u, userSetGeometry(rounded as never))).toBe(true)
    expect(sameUserSetGeometry(u, userSetGeometry(moved as never))).toBe(false)
    expect(GEOMETRY_TOLERANCE_PX).toBe(0.5)
  })

  it('a resizer’s own follow is derived (bound ends only); a translation and a point edit are not', () => {
    for (const angle of [0, 0.6]) {
      const { X, A, S } = startBound(angle)
      const conf = cloneMap(S)
      const B = cloneMap(S)
      ;(mutateElement as Any)(B.get(X.id), B, { height: 180 })
      updateBoundElements(B.get(X.id) as never, fakeScene(B) as never)
      const c = compareArrowChange(B.get(A.id) as never, conf.get(A.id) as never, B, conf)
      expect(c.derived, `angle ${angle}`).toBe(true)
      expect(c.userSetDelta).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX)
      const translated = { ...clone(conf.get(A.id) as Any), x: A.x + 120, y: A.y + 70 }
      expect(isDerivedArrowChange(translated as never, conf.get(A.id) as never)).toBe(false)
      const recoloured = { ...clone(B.get(A.id) as Any), strokeColor: '#e03131' }
      expect(
        compareArrowChange(recoloured as never, conf.get(A.id) as never, B, conf).otherGroupsChanged,
      ).toEqual(['strokeColor'])
    }
  })

  it('a customData.lobby change is another group', () => {
    const { A } = startBound(0)
    const tagged = { ...clone(A), customData: { lobby: { alt: 'x' } } }
    expect(compareArrowChange(tagged as never, A as never).otherGroupsChanged).toEqual(['c:alt'])
  })
})
