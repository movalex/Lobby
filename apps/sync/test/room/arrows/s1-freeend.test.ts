// C0 arrow acceptance test s1 (docs/EXCALIDRAW-MIGRATION.md §8.6.2; ported from the recheck's
// scratchpad/critic-r34/s1-freeend.mjs and s1-rot-literal.mjs, 3.5 rules as in lead-r35/): C drags the
// free end of a start-bound arrow while B resizes the start target X, in both commit orders, plain and
// rotated. Pass: the free end is stored at C's drop (605, 400), the start is on X's new edge, the
// resizer's follow is derived, and both undos apply. Every geometry within GEOMETRY_TOLERANCE_PX.

import {
  compareArrowChange,
  isDerivedArrowChange,
  sameUserSetGeometry,
  userSetGeometry,
} from '@draftroom/canvas-schema/groups'
import { hashElements } from '@draftroom/canvas-schema/hash'
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

const DROP: Pt = [605, 400]

function setup(variant: 'plain' | 'rot'): { X: El; A: El } {
  const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
  const A = {
    ...newArrow({ x: 205, y: 50 }),
    width: 300,
    height: 300,
    points: [
      [0, 0],
      [300, 300],
    ],
    startArrowhead: null,
    endArrowhead: 'arrow',
  }
  if (variant === 'rot') A.angle = 0.6
  bind(A, X, null, [1, 0.5])
  return { X, A }
}

/** The probes' own snap of the start (updateBoundPoint + movePoints), for the client-side checks. */
function snapLocally(scene: Scene, arrowId: string): void {
  const a = scene.get(arrowId)
  const p = engine.updateBoundPoint(
    a,
    'startBinding',
    a.startBinding,
    scene.get(a.startBinding.elementId),
    scene,
  )
  if (p) LinearElementEditor.movePoints(a, fakeScene(scene), new Map([[0, { point: p }]]))
}

describe('s1 client side (groups.ts only)', () => {
  for (const variant of ['plain', 'rot'] as const)
    it(`${variant}: the resizer's follow of X's resize is derived (bound end only)`, () => {
      const { X, A } = setup(variant)
      const S: Scene = new Map([
        [X.id, X],
        [A.id, A],
      ])
      snapLocally(S, A.id)
      const conf = cloneScene(S)
      const B = cloneScene(S)
      editTarget(B, X.id, { height: 180 })
      const c = compareArrowChange(B.get(A.id), conf.get(A.id), B, conf)
      expect(c.otherGroupsChanged).toEqual([])
      expect(c.userSetDelta).toBeLessThanOrEqual(TOL)
      expect(c.derived).toBe(true)
      // and C's own drag of the free end is not
      const C = cloneScene(S)
      dragPoint(C, A.id, 1, DROP)
      expect(isDerivedArrowChange(C.get(A.id), conf.get(A.id), C, conf)).toBe(false)
    })

  it("rotated arrow: the literal rebase formula moves the free end about 12 px (14.2 px at the old 6 px gap, W5-53), Excalidraw's movePoints 0 (negative control)", () => {
    const { X, A } = setup('rot')
    const S: Scene = new Map([
      [X.id, X],
      [A.id, A],
    ])
    const freeBefore = glob(A, -1, S)
    Object.assign(X, { height: 180 })
    const p = engine.updateBoundPoint(A, 'startBinding', A.startBinding, X, S)
    const E = clone(A)
    const Sm: Scene = new Map([
      [X.id, X],
      [E.id, E],
    ])
    LinearElementEditor.movePoints(E, fakeScene(Sm), new Map([[0, { point: p }]]))
    const s = LinearElementEditor.getPointGlobalCoordinates(A, p, S)
    const L = clone(A)
    const off = [s[0] - A.x, s[1] - A.y]
    L.x = s[0]
    L.y = s[1]
    L.points = A.points.map((q: Pt, i: number) =>
      i === 0 ? [0, 0] : [q[0] - (off[0] ?? 0), q[1] - (off[1] ?? 0)],
    )
    const Lm: Scene = new Map([
      [X.id, X],
      [L.id, L],
    ])
    expect(dist(glob(E, -1, Sm), freeBefore)).toBeLessThan(1e-6)
    expect(dist(glob(L, -1, Lm), freeBefore)).toBeGreaterThan(10)
  })
})

describe('s1 against the room', () => {
  for (const variant of ['plain', 'rot'] as const)
    for (const order of ['C-then-B', 'B-then-C'] as const)
      it(`${variant}, ${order}: C's free end is stored at (605, 400), the start on X's new edge, both undos apply`, async () => {
        const room = await freshBoard(`s1-${variant}-${order}`)
        const { X, A } = setup(variant)
        const S = await room.client('S')
        await S.create([X, A])
        const C = await room.client('C')
        const B = await room.client('B')
        const before = glob(C.confirmed.get(A.id), -1, C.confirmed)

        const Cm = C.copy()
        dragPoint(Cm, A.id, 1, DROP)
        const cDrop = glob(Cm.get(A.id), -1, Cm)
        expect(dist(cDrop, DROP)).toBeLessThan(1e-6)
        const Bm = B.copy()
        editTarget(Bm, X.id, { height: 180 })
        expect(isDerivedArrowChange(Bm.get(A.id), B.confirmed.get(A.id), Bm, B.confirmed)).toBe(true) // B pushes X only
        const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
        const opB = patchOf(Bm.get(X.id), B.confirmed.get(X.id))
        const [baseC, baseB] = [C.clock, B.clock]

        let cAfter: El
        if (order === 'C-then-B') {
          expect((await C.push([opC], baseC)).r[0]).toMatchObject({ ok: true })
          cAfter = clone(C.confirmed.get(A.id))
          expect((await B.push([opB], baseB)).r[0]).toMatchObject({ ok: true })
        } else {
          expect((await B.push([opB], baseB)).r[0]).toMatchObject({ ok: true })
          expect((await C.push([opC], baseC)).r[0]).toMatchObject({ ok: true })
          cAfter = clone(C.confirmed.get(A.id))
        }
        let stored = await room.stored()
        expect(stored.get(X.id).height).toBe(180)
        expect(dist(glob(stored.get(A.id), -1, stored), cDrop)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
        await C.untilClock((await room.snapshot()).clock)
        expect(await hashElements(C.confirmed.values())).toBe(await hashElements(stored.values()))

        // B undoes the resize: the free end stays at C's drop, the start follows X back
        const Bu = B.copy()
        Bu.get(X.id).height = 100
        expect((await B.push([patchOf(Bu.get(X.id), B.confirmed.get(X.id))])).r[0]).toMatchObject({
          ok: true,
        })
        stored = await room.stored()
        expect(dist(glob(stored.get(A.id), -1, stored), cDrop)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)

        // C undoes its drag: the compare against the entry's `after` applies (no "change kept"), and the
        // free end goes back to where it was
        await C.untilClock((await room.snapshot()).clock)
        const cConf = C.confirmed
        expect(
          sameUserSetGeometry(
            userSetGeometry(cConf.get(A.id), cConf),
            userSetGeometry(cAfter, new Map([[A.id, cAfter]])),
          ),
        ).toBe(true)
        const Cu = C.copy()
        dragPoint(Cu, A.id, 1, before)
        expect((await C.push([pathOp(Cu.get(A.id), cConf.get(A.id))])).r[0]).toMatchObject({ ok: true })
        stored = await room.stored()
        expect(dist(glob(stored.get(A.id), -1, stored), before)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
      })
})
