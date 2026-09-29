// C0 arrow acceptance test: the earlier probe scratchpad/critic-r33/freeend-rel.mjs, as it reported. C's
// free-end write, computed before B's resize of the start target, commits after it. With `x`, `y` in C's
// op (the whole `path` unit) the free end lands where C dropped it, (605, 400); a points-only write would
// have stored (606, 445.13), so the room refuses a `path` patch that is not whole (INVALID).

import { pathUnitOf } from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  dist,
  editTarget,
  fakeScene,
  followError,
  glob,
  LinearElementEditor,
  newArrow,
  newRect,
  TOL,
} from './support/excalidraw.ts'
import { patchOf, pathOp } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

describe('critic-r33 freeend-rel against the room', () => {
  it('C’s unit, committed after B’s resize, stores the free end at (605, 400); a points-only path patch is INVALID', async () => {
    const room = await freshBoard('r33-freeend')
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
    bind(A, X, null, [1, 0.5])
    const S = await room.client('S')
    await S.create([X, A])
    const C = await room.client('C')
    const B = await room.client('B')
    // C drags the free end to scene (605, 400); Excalidraw keeps x, y (point 0 not moved)
    const Cm = C.copy()
    const a = Cm.get(A.id)
    const local = LinearElementEditor.createPointAt(a, Cm, 605, 400, null)
    LinearElementEditor.movePoints(a, fakeScene(Cm), new Map([[1, { point: local }]]))
    expect(dist(glob(a, -1, Cm), [605, 400])).toBeLessThan(1e-6)
    const baseC = C.clock
    const Bm = B.copy()
    editTarget(Bm, X.id, { height: 180 })
    await B.push([patchOf(Bm.get(X.id), B.confirmed.get(X.id))])

    // the points-only write the probe showed landing shifted: refused, nothing stored
    const { points } = pathUnitOf(a) as { points: unknown }
    const partial = await C.push(
      [{ k: 'p', id: A.id, pv: C.confirmed.get(A.id).version, g: { path: { points } } }],
      baseC,
    )
    expect(partial.r[0]).toMatchObject({ ok: false, code: 'INVALID' })

    const ack = await C.push([pathOp(a, C.confirmed.get(A.id))], baseC)
    expect(ack.r[0]).toMatchObject({ ok: true })
    const stored = await room.stored()
    expect(dist(glob(stored.get(A.id), -1, stored), [605, 400])).toBeLessThanOrEqual(TOL)
    expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
  })
})
