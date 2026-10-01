// C0 arrow acceptance test s7 (ported from scratchpad/critic-r34/s7-angle-mix.mjs, 3.5 rules): B rotates
// a selection holding a free arrow (its x, y and angle change, as rotateMultipleElements writes them) while
// C drags the arrow's free end on the unrotated copy. Both write the arrow's whole `path` unit (`angle`
// included, 3.5), so the stored arrow is one whole version, the later writer's, never a mixture.

import { describe, expect, it } from 'vitest'
import {
  dist,
  dragPoint,
  glob,
  newArrow,
  type Pt,
  rotateArrowAsSelection,
  type Scene,
  TOL,
} from './support/excalidraw.ts'
import { pathOp } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

describe('s7 against the room', () => {
  for (const order of ['B-then-C', 'C-then-B'] as const)
    it(`${order}: the stored arrow is the later writer's whole version`, async () => {
      const room = await freshBoard(`s7-${order}`)
      const A = {
        ...newArrow({ x: 100, y: 100 }),
        points: [
          [0, 0],
          [300, 0],
        ],
        startArrowhead: null,
        endArrowhead: 'arrow',
        startBinding: null,
        endBinding: null,
      }
      const S = await room.client('S')
      await S.create([A])
      const B = await room.client('B')
      const C = await room.client('C')
      // B: rotate the selection 90° about (400, 100): the arrow's centre (250, 100) goes to (400, -50)
      const Bm = B.copy()
      const b0 = Bm.get(A.id)
      rotateArrowAsSelection(Bm, A.id, { x: b0.x + 150, y: b0.y - 150, angle: Math.PI / 2 })
      // C: drag the free end (point 1) from (400, 100) to (400, 160)
      const Cm = C.copy()
      dragPoint(Cm, A.id, 1, [400, 160])
      const ends = (m: Scene): [Pt, Pt] => [glob(m.get(A.id), 0, m), glob(m.get(A.id), -1, m)]
      const versions = { B: ends(Bm), C: ends(Cm) }
      const opB = pathOp(Bm.get(A.id), B.confirmed.get(A.id))
      const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
      const [baseB, baseC] = [B.clock, C.clock]
      if (order === 'B-then-C') {
        await B.push([opB], baseB)
        await C.push([opC], baseC)
      } else {
        await C.push([opC], baseC)
        await B.push([opB], baseB)
      }
      const stored = await room.stored()
      const got = ends(stored)
      const later = order === 'B-then-C' ? versions.C : versions.B
      const earlier = order === 'B-then-C' ? versions.B : versions.C
      expect(Math.max(dist(got[0], later[0]), dist(got[1], later[1]))).toBeLessThanOrEqual(TOL)
      expect(Math.max(dist(got[0], earlier[0]), dist(got[1], earlier[1]))).toBeGreaterThan(TOL)
      expect(stored.get(A.id).angle).toBeCloseTo(order === 'B-then-C' ? 0 : Math.PI / 2, 9)
    })
})
