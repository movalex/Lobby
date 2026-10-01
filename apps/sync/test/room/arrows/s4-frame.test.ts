// C0 arrow acceptance test s4 (ported from scratchpad/critic-r34/s4-frame.mjs, 3.5 rules): A drags frame
// F, which holds note N and an arrow bound to N with a bend and a free end, through Excalidraw's own
// dragSelectedElements; B holds N's lease and its fit grows N. Both orders of the drag and the fit, and both
// op orders inside A's push, with the arrow start- or end-bound. Pass: the arrow is A's own write (not
// derived); its free end and bend are translated with the frame; its bound end is on N's grown edge; A's
// undo applies.

import { isDerivedArrowChange, sameUserSetGeometry, userSetGeometry } from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  clone,
  cloneScene,
  dragFrame,
  type El,
  followError,
  newArrow,
  newFrame,
  newNote,
  type Scene,
  TOL,
} from './support/excalidraw.ts'
import { patchOf } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

const OFFSET = { x: 120, y: 70 }

function setup(startBound: boolean): { F: El; N: El; A: El } {
  const F = newFrame({ x: -100, y: -100, width: 1000, height: 800 })
  const N = { ...newNote({ x: 0, y: 0, width: 200, height: 200, baseHeight: 200 }), frameId: F.id }
  const A = {
    ...newArrow({ x: 205, y: 100 }),
    frameId: F.id,
    points: [
      [0, 0],
      [150, 200],
      [400, 250],
    ],
    endArrowhead: 'arrow',
    startArrowhead: null,
  }
  if (startBound) bind(A, N, null, [1, 0.5])
  else {
    A.x = 600
    A.y = 400
    A.points = [
      [0, 0],
      [-150, -200],
      [-395, -300],
    ]
    bind(A, null, N, [1, 0.5], [1, 0.5])
  }
  return { F, N, A }
}

describe('s4 client side (groups.ts only)', () => {
  for (const startBound of [true, false])
    it(`${startBound ? 'start' : 'end'}-bound: an arrow a frame drag translated is NOT derived (it is the dragger's write)`, () => {
      const { F, N, A } = setup(startBound)
      const S: Scene = new Map([
        [F.id, F],
        [N.id, N],
        [A.id, A],
      ])
      const conf = cloneScene(S)
      const Am = cloneScene(S)
      dragFrame(Am, F.id, OFFSET)
      expect(Am.get(N.id).x).toBe(N.x + OFFSET.x)
      expect(isDerivedArrowChange(Am.get(A.id), conf.get(A.id), Am, conf)).toBe(false)
      expect(!!(startBound ? Am.get(A.id).startBinding : Am.get(A.id).endBinding)).toBe(true) // still bound
    })
})

describe('s4 against the room', () => {
  for (const startBound of [true, false])
    for (const order of ['A-drag-then-B-fit', 'B-fit-then-A-drag'] as const)
      for (const opOrder of ['N-before-arrow', 'arrow-before-N'] as const)
        it(`${startBound ? 'start' : 'end'}-bound, ${order}, ${opOrder}: free end and bend move with the frame, the bound end on N's grown edge`, async () => {
          const room = await freshBoard(`s4-${startBound}-${order}-${opOrder}`)
          const { F, N, A } = setup(startBound)
          const S = await room.client('S')
          await S.create([F, N, A])
          const Ac = await room.client('A')
          const B = await room.client('B')
          expect((await B.acquire(N.id)).type).toBe('lease.grant')
          const preDrag = clone(Ac.confirmed.get(A.id))
          const preDragUS = userSetGeometry(preDrag, Ac.confirmed)

          const Am = Ac.copy()
          dragFrame(Am, F.id, OFFSET)
          const dragged = userSetGeometry(Am.get(A.id), Am)
          const opF = patchOf(Am.get(F.id), Ac.confirmed.get(F.id))
          const opN = patchOf(Am.get(N.id), Ac.confirmed.get(N.id))
          const opA = patchOf(Am.get(A.id), Ac.confirmed.get(A.id))
          expect(opA).toMatchObject({ g: { path: expect.anything() } })
          const dragOps = opOrder === 'N-before-arrow' ? [opF, opN, opA] : [opF, opA, opN]
          const [baseA, baseB] = [Ac.clock, B.clock]
          const fit = (base: number, pv: number) =>
            B.push([{ k: 'p', id: N.id, pv, fit: { height: 320 } }], base)

          let ackAfter: El
          if (order === 'A-drag-then-B-fit') {
            const ack = await Ac.push(dragOps, baseA)
            expect(ack.r.every((r) => r.ok)).toBe(true)
            ackAfter = clone(Ac.confirmed.get(A.id))
            // B's fit was computed before A's drag wrote N's position: dropped, and B re-fits on the new base
            const dropped = await fit(baseB, B.confirmed.get(N.id).version)
            expect(dropped.r[0]).toMatchObject({ ok: true, fitDropped: true })
            await B.untilClock((await room.snapshot()).clock)
            const refit = await fit(B.clock, B.confirmed.get(N.id).version)
            expect(refit.r[0]).toMatchObject({ ok: true })
            expect((refit.r[0] as { fitDropped?: true }).fitDropped).toBeUndefined()
          } else {
            const applied = await fit(baseB, B.confirmed.get(N.id).version)
            expect((applied.r[0] as { fitDropped?: true }).fitDropped).toBeUndefined()
            const ack = await Ac.push(dragOps, baseA)
            expect(ack.r.every((r) => r.ok)).toBe(true)
            ackAfter = clone(Ac.confirmed.get(A.id))
          }
          let stored = await room.stored()
          expect(stored.get(N.id).height).toBe(320)
          expect(stored.get(N.id).x).toBe(N.x + OFFSET.x)
          expect(sameUserSetGeometry(userSetGeometry(stored.get(A.id), stored), dragged)).toBe(true)
          expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)

          // A's undo of the frame drag: the compare applies, and everything goes back by the offset
          await Ac.untilClock((await room.snapshot()).clock)
          const now = Ac.confirmed
          expect(sameUserSetGeometry(userSetGeometry(now.get(A.id), now), userSetGeometry(ackAfter))).toBe(
            true,
          )
          const Au = Ac.copy()
          for (const id of [F.id, N.id, A.id]) {
            Au.get(id).x -= OFFSET.x
            Au.get(id).y -= OFFSET.y
          }
          const undo = await Ac.push([
            patchOf(Au.get(F.id), now.get(F.id)),
            patchOf(Au.get(N.id), now.get(N.id)),
            patchOf(Au.get(A.id), now.get(A.id)),
          ])
          expect(undo.r.every((r) => r.ok)).toBe(true)
          stored = await room.stored()
          expect(sameUserSetGeometry(userSetGeometry(stored.get(A.id), stored), preDragUS)).toBe(true)
          expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
        })
})
