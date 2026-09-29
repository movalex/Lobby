// C0 arrow acceptance test: the earlier probe scratchpad/lead-r34/elbow-fixed2.mjs, as it reported.
// Through Excalidraw's own follow path (updateBoundPoint + movePoints, as updateBoundElements calls them),
// a vertical fixed segment at scene x 400 stays at x 400 while its ends move from y 50.01 to 150.01 after
// X moves 80 down and grows 40. Against the room: the stored segment stays at x 400 too.

import { describe, expect, it } from 'vitest'
import {
  bind,
  dist,
  editTarget,
  engine,
  fakeScene,
  followError,
  LinearElementEditor,
  newArrow,
  newRect,
  orthogonal,
  type Pt,
  routeElbow,
  type Scene,
  segments,
  TOL,
} from './support/excalidraw.ts'
import { patchOf } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

function setup() {
  const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
  const Y = newRect({ x: 500, y: 300, width: 200, height: 100 })
  const A = {
    ...newArrow({ x: 205, y: 50, elbowed: true }),
    width: 290,
    height: 300,
    points: [
      [0, 0],
      [290, 300],
    ],
  }
  bind(A, X, Y)
  const S: Scene = new Map([
    [X.id, X],
    [Y.id, Y],
    [A.id, A],
  ])
  routeElbow(S, A, { index: 2, x: 400 })
  return { X, Y, A, S }
}

describe('lead-r34 elbow-fixed2, client side (the engine follow)', () => {
  it('x 400 is kept; the segment ends move from y 50.01 to 150.01', () => {
    const { X, Y, A, S } = setup()
    const sc = (p: Pt): Pt => [+(A.x + p[0]).toFixed(2), +(A.y + p[1]).toFixed(2)]
    expect(A.fixedSegments.map((s: { start: Pt; end: Pt }) => [sc(s.start), sc(s.end)])).toEqual([
      [
        [400, 50.01],
        [400, 350.01],
      ],
    ])
    Object.assign(X, { y: 80, height: 140, version: X.version + 1 })
    const ups: [number, { point: Pt }][] = []
    for (const [prop, T, idx] of [
      ['startBinding', X, 0],
      ['endBinding', Y, A.points.length - 1],
    ] as const) {
      const p = engine.updateBoundPoint(A, prop, A[prop], T, S)
      if (p) ups.push([idx, { point: p }])
    }
    LinearElementEditor.movePoints(A, fakeScene(S), new Map(ups), { moveMidPointsWithElement: false })
    const after = A.fixedSegments.map((s: { start: Pt; end: Pt }) => [sc(s.start), sc(s.end)])
    expect(dist(after[0][0], [400, 150.01])).toBeLessThanOrEqual(0.01)
    expect(dist(after[0][1], [400, 350.01])).toBeLessThanOrEqual(0.01)
  })
})

describe('lead-r34 elbow-fixed2 against the room', () => {
  it('X moves 80 down and grows 40: the stored fixed segment stays at x 400 on an orthogonal route', async () => {
    const room = await freshBoard('r34-elbow-fixed')
    const { X, Y, A } = setup()
    const S = await room.client('S')
    await S.create([X, Y, A])
    const B = await room.client('B')
    const Bm = B.copy()
    editTarget(Bm, X.id, { y: 80, height: 140 })
    expect((await B.push([patchOf(Bm.get(X.id), B.confirmed.get(X.id))])).r[0]).toMatchObject({ ok: true })
    const stored = await room.stored()
    const segs = segments(stored.get(A.id))
    expect(segs).toHaveLength(1)
    expect(Math.abs((segs[0]?.cross ?? 0) - 400)).toBeLessThanOrEqual(TOL)
    expect(orthogonal(stored.get(A.id))).toBe(true)
    expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
  })
})
