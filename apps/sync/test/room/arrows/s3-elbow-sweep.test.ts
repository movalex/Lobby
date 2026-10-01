// C0 arrow acceptance test s3, the sweep (ported from scratchpad/critic-r34/s3-elbow-sweep.mjs, 3.5
// rules): random moves, resizes and rotations of the start target of an elbow arrow with a fixed segment.
// Pass: 0 of Excalidraw's own follows is misclassified by the structural derived test (the flags and the
// segments' numbering are in `path`, and segments are matched by order, orientation and cross position).
// Client side only: it needs groups.ts and the engine, not the room.

import { compareArrowChange } from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  cloneScene,
  editTarget,
  engine,
  fakeScene,
  LinearElementEditor,
  newArrow,
  newRect,
  type Scene,
} from './support/excalidraw.ts'

describe('s3 sweep, client side (groups.ts only)', () => {
  it('1,500 random moves, resizes and rotations of an elbow arrow’s target: none misclassified', () => {
    let seed = 11
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const sides: [number, number][] = [
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
      [0.5, 0],
    ]
    const stats = { move: { n: 0, bad: 0 }, resize: { n: 0, bad: 0 }, rotate: { n: 0, bad: 0 } }
    for (let i = 0; i < 1500; i++) {
      const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
      const Y = newRect({ x: 450 + rnd() * 300, y: 250 + rnd() * 300, width: 200, height: 100 })
      const fs = sides[Math.floor(rnd() * 4)] as [number, number]
      const fe = sides[Math.floor(rnd() * 4)] as [number, number]
      const A = {
        ...newArrow({ x: 0, y: 0, elbowed: true }),
        points: [
          [0, 0],
          [1, 1],
        ],
      }
      bind(A, X, Y, fs, fe)
      const S: Scene = new Map([
        [X.id, X],
        [Y.id, Y],
        [A.id, A],
      ])
      try {
        Object.assign(
          A,
          engine.updateElbowArrowPoints(
            A,
            S,
            {
              points: [
                [0, 0],
                [Y.x - 1, Y.y - 1],
              ],
            },
            {},
          ),
        )
        if (A.points.length < 4) continue
        const idx = Math.floor(A.points.length / 2)
        const mid = [
          A.x + (A.points[idx - 1][0] + A.points[idx][0]) / 2 + 30,
          A.y + (A.points[idx - 1][1] + A.points[idx][1]) / 2 + 30,
        ]
        LinearElementEditor.moveFixedSegment({ elementId: A.id }, idx, mid[0], mid[1], fakeScene(S))
      } catch {
        continue
      }
      const conf = cloneScene(S)
      const kind = (['move', 'resize', 'rotate'] as const)[i % 3] as 'move' | 'resize' | 'rotate'
      const upd =
        kind === 'move'
          ? { x: rnd() * 300 - 150, y: rnd() * 300 - 150 }
          : kind === 'resize'
            ? { width: 40 + rnd() * 400, height: 40 + rnd() * 400 }
            : { angle: rnd() * 2 * Math.PI }
      const B = cloneScene(S)
      try {
        editTarget(B, X.id, upd)
      } catch {
        continue
      }
      stats[kind].n++
      if (!compareArrowChange(B.get(A.id), conf.get(A.id), B, conf).derived) stats[kind].bad++
    }
    expect(stats.move.n + stats.resize.n + stats.rotate.n).toBeGreaterThan(1_000)
    expect(stats.rotate.n).toBeGreaterThan(300)
    expect({ move: stats.move.bad, resize: stats.resize.bad, rotate: stats.rotate.bad }).toEqual({
      move: 0,
      resize: 0,
      rotate: 0,
    })
  })
})
