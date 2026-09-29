// C0 arrow acceptance test s3 (ported from scratchpad/critic-r34/s3-elbow.mjs, s3-elbow-race.mjs,
// s3-elbow-pathonly.mjs and lead-r35/s3-elbow-undo.mjs, 3.5 rules): an elbow arrow X → Y whose middle
// segment C drags while B moves, resizes or rotates X by 60° or 90° (a heading flip: the router sets
// startIsSpecial and renumbers the segment). Pass: C's segment is kept across its axis in both orders on an
// orthogonal route, the rotator's follow is derived, a unit landing on top of a flipped flag (and an
// offline replay of it) keeps the segment on an orthogonal route and is not STALE, C's undo after the flip
// applies by order, and B's undo of the rotation leaves C's segment in place.

import { isDerivedArrowChange, sameUserSetGeometry, userSetGeometry } from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  clone,
  cloneScene,
  dragSegment,
  type El,
  editTarget,
  followError,
  newArrow,
  newRect,
  orthogonal,
  routeElbow,
  type Scene,
  segments,
  TOL,
} from './support/excalidraw.ts'
import { patchOf, pathOp } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

function setup(preFixed: boolean): { X: El; Y: El; A: El } {
  const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
  const Y = newRect({ x: 500, y: 300, width: 200, height: 100 })
  const A = {
    ...newArrow({ x: 205, y: 50, elbowed: true }),
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
  routeElbow(S, A, preFixed ? { index: 2, x: 400 } : undefined)
  return { X, Y, A }
}

const ACTIONS: Record<string, (X: El) => Record<string, number>> = {
  'move X down 80': (X) => ({ y: X.y + 80 }),
  'resize X': () => ({ width: 260, height: 160 }),
  'rotate X 90°': () => ({ angle: Math.PI / 2 }),
  'rotate X 60°': () => ({ angle: Math.PI / 3 }),
}

describe('s3 client side (groups.ts only)', () => {
  for (const preFixed of [false, true])
    for (const [name, act] of Object.entries(ACTIONS))
      it(`${preFixed ? 'fixed segment at x 400' : 'no fixed segment'}, ${name}: B's follow is derived`, () => {
        const { X, Y, A } = setup(preFixed)
        const S: Scene = new Map([
          [X.id, X],
          [Y.id, Y],
          [A.id, A],
        ])
        const conf = cloneScene(S)
        const B = cloneScene(S)
        editTarget(B, X.id, act(X))
        expect(isDerivedArrowChange(B.get(A.id), conf.get(A.id), B, conf)).toBe(true)
      })
})

describe('s3 against the room', () => {
  for (const preFixed of [false, true])
    for (const [name, act] of Object.entries(ACTIONS))
      for (const order of ['C-then-B', 'B-then-C'] as const)
        it(`${preFixed ? 'fixed at 400' : 'no fixed segment'}, B: ${name}, ${order}: C's segment is kept across its axis`, async () => {
          const room = await freshBoard(`s3-${preFixed}-${name}-${order}`)
          const { X, Y, A } = setup(preFixed)
          const S = await room.client('S')
          await S.create([X, Y, A])
          const C = await room.client('C')
          const B = await room.client('B')
          const cX = preFixed ? 450 : 420
          const Cm = C.copy()
          dragSegment(Cm, A.id, 2, cX)
          expect(segments(Cm.get(A.id))[0]?.cross).toBeCloseTo(cX, 6)
          const Bm = B.copy()
          editTarget(Bm, X.id, act(B.confirmed.get(X.id)))
          expect(isDerivedArrowChange(Bm.get(A.id), B.confirmed.get(A.id), Bm, B.confirmed)).toBe(true) // B pushes X only
          const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
          const opB = patchOf(Bm.get(X.id), B.confirmed.get(X.id))
          const [baseC, baseB] = [C.clock, B.clock]
          if (order === 'C-then-B') {
            expect((await C.push([opC], baseC)).r[0]).toMatchObject({ ok: true })
            expect((await B.push([opB], baseB)).r[0]).toMatchObject({ ok: true })
          } else {
            expect((await B.push([opB], baseB)).r[0]).toMatchObject({ ok: true })
            expect((await C.push([opC], baseC)).r[0]).toMatchObject({ ok: true })
          }
          const stored = await room.stored()
          const a = stored.get(A.id)
          const segs = segments(a)
          expect(segs).toHaveLength(1)
          expect(segs[0]?.v).toBe(true)
          expect(Math.abs((segs[0]?.cross ?? 0) - cX)).toBeLessThanOrEqual(TOL)
          expect(orthogonal(a)).toBe(true)
          expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
        })

  for (const replay of [false, true])
    it(`C's unit lands on top of a flipped flag${replay ? ' as an offline replay' : ''}: the segment stays on an orthogonal route${replay ? ', not STALE' : ''}`, async () => {
      const room = await freshBoard(`s3-pathonly-${replay}`)
      const { X, Y, A } = setup(true)
      const S = await room.client('S')
      await S.create([X, Y, A])
      const C = await room.client('C')
      const B = await room.client('B')
      const Cm = C.copy() // C's copy from before the rotation
      dragSegment(Cm, A.id, 2, 450)
      const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id), replay ? { off: 11 * 60_000 } : {})
      const baseC = C.clock
      const Bm = B.copy()
      editTarget(Bm, X.id, { angle: Math.PI / 2 })
      await B.push([patchOf(Bm.get(X.id), B.confirmed.get(X.id))])
      let stored = await room.stored()
      expect(stored.get(A.id).startIsSpecial).toBe(true) // the router flipped the heading
      const ack = await C.push([opC], baseC)
      expect(ack.r[0]).toMatchObject({ ok: true })
      stored = await room.stored()
      const a = stored.get(A.id)
      const segs = segments(a)
      expect(segs).toHaveLength(1)
      expect(Math.abs((segs[0]?.cross ?? 0) - 450)).toBeLessThanOrEqual(TOL)
      expect(orthogonal(a)).toBe(true)
      expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
    })

  for (const deg of [60, 90])
    for (const order of ['C-then-B', 'B-then-C'] as const)
      it(`rotation ${deg}°, ${order}: C's undo finds the renumbered segment by order and applies; B's undo leaves C's segment`, async () => {
        const room = await freshBoard(`s3-undo-${deg}-${order}`)
        const { X, Y, A } = setup(true)
        const S = await room.client('S')
        await S.create([X, Y, A])
        const C = await room.client('C')
        const B = await room.client('B')
        const Cm = C.copy()
        dragSegment(Cm, A.id, 2, 450)
        const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
        const Bm = B.copy()
        editTarget(Bm, X.id, { angle: (deg * Math.PI) / 180 })
        const opB = patchOf(Bm.get(X.id), B.confirmed.get(X.id))
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
        await C.untilClock((await room.snapshot()).clock)
        // the compare by order, orientation and cross-axis position: no "change kept"
        expect(
          sameUserSetGeometry(userSetGeometry(C.confirmed.get(A.id), C.confirmed), userSetGeometry(cAfter)),
        ).toBe(true)
        // B's undo of the rotation (X's angle back to 0) keeps C's segment
        await B.untilClock((await room.snapshot()).clock)
        const Bu = B.copy()
        Bu.get(X.id).angle = 0
        await B.push([patchOf(Bu.get(X.id), B.confirmed.get(X.id))])
        let stored = await room.stored()
        expect(Math.abs((segments(stored.get(A.id))[0]?.cross ?? 0) - 450)).toBeLessThanOrEqual(TOL)
        expect(orthogonal(stored.get(A.id))).toBe(true)
        // C's undo: the first fixed segment, at its CURRENT index, back to x 400
        await C.untilClock((await room.snapshot()).clock)
        const Cu = C.copy()
        const seg = segments(Cu.get(A.id))[0]
        expect(seg).toBeDefined()
        dragSegment(Cu, A.id, seg?.index ?? -1, 400)
        await C.push([pathOp(Cu.get(A.id), C.confirmed.get(A.id))])
        stored = await room.stored()
        expect(Math.abs((segments(stored.get(A.id))[0]?.cross ?? 0) - 400)).toBeLessThanOrEqual(TOL)
        expect(orthogonal(stored.get(A.id))).toBe(true)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
      })
})
