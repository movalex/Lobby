// C0 arrow acceptance test s2 (ported from scratchpad/critic-r34/s2-midpoint.mjs and s2-selfloop.mjs,
// 3.5 rules): a curved arrow X → Y whose midpoint C drags while B moves X (the start: x, y move and the
// points are rebased) or Y, in both orders; and a self-loop. Pass: the midpoint is kept in both orders with
// both undos applied; a self-loop's midpoints are kept relative to its start, and its repeated re-snaps
// settle within 4 writes. Every geometry within GEOMETRY_TOLERANCE_PX.

import {
  isDerivedArrowChange,
  pathUnitOf,
  sameUserSetGeometry,
  userSetGeometry,
} from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  clone,
  cloneScene,
  dist,
  dragPoint,
  type El,
  editTarget,
  engine,
  fakeScene,
  followError,
  glob,
  LinearElementEditor,
  newArrow,
  newRect,
  type Pt,
  type Scene,
  TOL,
} from './support/excalidraw.ts'
import { patchOf, pathOp } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

function curved() {
  const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
  const Y = newRect({ x: 500, y: 300, width: 200, height: 100 }, 'ellipse')
  const A = {
    ...newArrow({ x: 205, y: 50 }),
    roundness: { type: 2 },
    points: [
      [0, 0],
      [150, 50],
      [290, 300],
    ],
    startArrowhead: null,
    endArrowhead: 'arrow',
  }
  bind(A, X, Y)
  return { X, Y, A }
}
function selfLoop() {
  const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
  const A = {
    ...newArrow({ x: 205, y: 30 }),
    roundness: { type: 2 },
    points: [
      [0, 0],
      [80, -60],
      [60, 50],
    ],
    startArrowhead: null,
    endArrowhead: 'arrow',
  }
  bind(A, X, X, [1, 0.3], [1, 0.7])
  return { X, A }
}
/** The probes' local snap of both ends. */
function snapLocally(S: Scene, A: El) {
  const ups: [number, { point: Pt }][] = []
  for (const [prop, idx] of [
    ['startBinding', 0],
    ['endBinding', A.points.length - 1],
  ] as const) {
    const p = engine.updateBoundPoint(A, prop, A[prop], S.get(A[prop].elementId), S)
    if (p) ups.push([idx, { point: p }])
  }
  const loop = A.startBinding.elementId === A.endBinding.elementId
  LinearElementEditor.movePoints(A, fakeScene(S), new Map(ups), { moveMidPointsWithElement: loop })
}

describe('s2 client side (groups.ts only)', () => {
  for (const who of ['X', 'Y'] as const)
    it(`moving ${who} (${who === 'X' ? 'the start' : 'the end'}): the mover's follow is derived; C's midpoint drag is not`, () => {
      const { X, Y, A } = curved()
      const S: Scene = new Map([
        [X.id, X],
        [Y.id, Y],
        [A.id, A],
      ])
      snapLocally(S, A)
      const conf = cloneScene(S)
      const T = who === 'X' ? X : Y
      const B = cloneScene(S)
      editTarget(B, T.id, { x: T.x + 40, y: T.y + 90 })
      expect(isDerivedArrowChange(B.get(A.id), conf.get(A.id), B, conf)).toBe(true)
      const C = cloneScene(S)
      dragPoint(C, A.id, 1, [300, 30])
      expect(isDerivedArrowChange(C.get(A.id), conf.get(A.id), C, conf)).toBe(false)
    })

  it("a self-loop's follow of its target's move is derived (midpoints relative to the start)", () => {
    const { X, A } = selfLoop()
    const S: Scene = new Map([
      [X.id, X],
      [A.id, A],
    ])
    snapLocally(S, A)
    const conf = cloneScene(S)
    const B = cloneScene(S)
    editTarget(B, X.id, { x: 40, y: 150 })
    expect(isDerivedArrowChange(B.get(A.id), conf.get(A.id), B, conf)).toBe(true)
  })
})

describe('s2 against the room', () => {
  for (const who of ['X', 'Y'] as const)
    for (const order of ['C-then-B', 'B-then-C'] as const)
      it(`curved midpoint, B moves ${who}, ${order}: the midpoint is kept, both undos apply`, async () => {
        const room = await freshBoard(`s2-${who}-${order}`)
        const { X, Y, A } = curved()
        const T = who === 'X' ? X : Y
        const S = await room.client('S')
        await S.create([X, Y, A])
        const C = await room.client('C')
        const B = await room.client('B')
        const before = glob(C.confirmed.get(A.id), 1, C.confirmed)
        const tBefore = { x: B.confirmed.get(T.id).x, y: B.confirmed.get(T.id).y }
        const Cm = C.copy()
        dragPoint(Cm, A.id, 1, [300, 30])
        const cDrop = glob(Cm.get(A.id), 1, Cm)
        const Bm = B.copy()
        editTarget(Bm, T.id, { x: tBefore.x + 40, y: tBefore.y + 90 })
        expect(isDerivedArrowChange(Bm.get(A.id), B.confirmed.get(A.id), Bm, B.confirmed)).toBe(true)
        const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
        const opB = patchOf(Bm.get(T.id), B.confirmed.get(T.id))
        const [baseC, baseB] = [C.clock, B.clock]
        let cAfter: El
        if (order === 'C-then-B') {
          await C.push([opC], baseC)
          cAfter = clone(C.confirmed.get(A.id))
          await B.push([opB], baseB)
        } else {
          await B.push([opB], baseB)
          await C.push([opC], baseC)
          cAfter = clone(C.confirmed.get(A.id))
        }
        let stored = await room.stored()
        expect(dist(glob(stored.get(A.id), 1, stored), cDrop)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)

        // B's undo (T back): C's midpoint stays
        const Bu = B.copy()
        Object.assign(Bu.get(T.id), tBefore)
        await B.push([patchOf(Bu.get(T.id), B.confirmed.get(T.id))])
        stored = await room.stored()
        expect(dist(glob(stored.get(A.id), 1, stored), cDrop)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)

        // C's undo applies (no "change kept") and brings the midpoint back
        await C.untilClock((await room.snapshot()).clock)
        expect(
          sameUserSetGeometry(userSetGeometry(C.confirmed.get(A.id), C.confirmed), userSetGeometry(cAfter)),
        ).toBe(true)
        const Cu = C.copy()
        dragPoint(Cu, A.id, 1, before)
        await C.push([pathOp(Cu.get(A.id), C.confirmed.get(A.id))])
        stored = await room.stored()
        expect(dist(glob(stored.get(A.id), 1, stored), before)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
      })

  it("a self-loop's repeated re-snaps settle within 4 writes, then write nothing", async () => {
    const room = await freshBoard('s2-selfloop-settle')
    const { X, A } = selfLoop()
    const S = await room.client('S')
    await S.create([X, A])
    const moves: number[] = []
    const unchanged: boolean[] = []
    for (let i = 0; i < 6; i++) {
      const cur = S.confirmed.get(A.id)
      const start = glob(cur, 0, S.confirmed)
      const unitBefore = JSON.stringify(pathUnitOf(cur))
      // re-pushing the stored unit unchanged is a write to the arrow's path: the room re-snaps it
      expect((await S.push([pathOp(cur, cur)])).r[0]).toMatchObject({ ok: true })
      const stored = await room.stored()
      moves.push(dist(glob(stored.get(A.id), 0, stored), start))
      unchanged.push(JSON.stringify(pathUnitOf(stored.get(A.id))) === unitBefore)
    }
    for (const m of moves) expect(m).toBeLessThanOrEqual(TOL)
    expect(unchanged.slice(4)).toEqual([true, true])
  })

  for (const order of ['C-then-B', 'B-then-C'] as const)
    it(`a self-loop's midpoint, relative to its start, survives B's move of X (${order})`, async () => {
      const room = await freshBoard(`s2-selfloop-${order}`)
      const { X, A } = selfLoop()
      const S = await room.client('S')
      await S.create([X, A])
      const C = await room.client('C')
      const B = await room.client('B')
      const Cm = C.copy()
      dragPoint(Cm, A.id, 1, [320, -60])
      const cRel = userSetGeometry(Cm.get(A.id), Cm)
      const Bm = B.copy()
      editTarget(Bm, X.id, { x: 40, y: 150 })
      expect(isDerivedArrowChange(Bm.get(A.id), B.confirmed.get(A.id), Bm, B.confirmed)).toBe(true)
      const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
      const opB = patchOf(Bm.get(X.id), B.confirmed.get(X.id))
      const [baseC, baseB] = [C.clock, B.clock]
      if (order === 'C-then-B') {
        await C.push([opC], baseC)
        await B.push([opB], baseB)
      } else {
        await B.push([opB], baseB)
        await C.push([opC], baseC)
      }
      const stored = await room.stored()
      expect(sameUserSetGeometry(userSetGeometry(stored.get(A.id), stored), cRel)).toBe(true)
      // no edge check here: Excalidraw's own follow of a self-loop is not a fixed point right after its
      // target moved (on the recheck's own model, repeated re-snaps after X moved shift the start by 21.8,
      // 1.53, 0.1, 0.01 px before it settles), so the recheck's condition is the relative midpoints, and the
      // settling of repeated re-snaps above
    })
})
