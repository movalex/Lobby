// C0 arrow acceptance test: the earlier probe scratchpad/critic-r33/label-node.mjs, as it reported.
// `LinearElementEditor.getBoundTextElementPosition` runs in plain Node with no Scene and no DOM: (120, 37.5),
// then (220, 137.5) after the arrow grew (its version bumped: the helper caches per arrow and label
// version, E 10345, 11674-11690). Against the room: when the room re-snaps a labelled bound arrow, it moves
// the label as a derived layout write, to where that helper puts it on the stored arrow.

import { describe, expect, it } from 'vitest'
import {
  bind,
  clone,
  type El,
  editTarget,
  LinearElementEditor,
  newArrow,
  newRect,
  newText,
  TOL,
  useServerTextMetrics,
} from './support/excalidraw.ts'
import { patchOf } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

describe('critic-r33 label-node, client side (the engine helper in Node)', () => {
  it('gives (120, 37.5), then (220, 137.5) after the arrow grew', () => {
    const A: El = {
      ...newArrow({ x: 0, y: 0 }),
      width: 300,
      height: 100,
      points: [
        [0, 0],
        [300, 100],
      ],
    }
    const T: El = {
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
    A.boundElements = [{ id: 't1', type: 'text' }]
    const map = new Map<string, El>([
      [A.id, A],
      ['t1', T],
    ])
    expect(LinearElementEditor.getBoundTextElementPosition(A, T, map)).toEqual({ x: 120, y: 37.5 })
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
    map.set(A.id, A2)
    expect(LinearElementEditor.getBoundTextElementPosition(A2, T, map)).toEqual({ x: 220, y: 137.5 })
  })
})

describe('critic-r33 label-node against the room', () => {
  it("a re-snap of a labelled bound arrow moves its label to the helper's position on the stored arrow", async () => {
    useServerTextMetrics()
    const room = await freshBoard('r33-label')
    const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
    const Y = newRect({ x: 600, y: 300, width: 200, height: 100 })
    const A = {
      ...newArrow({ x: 205, y: 50 }),
      points: [
        [0, 0],
        [390, 300],
      ],
      startArrowhead: null,
      endArrowhead: 'arrow',
    }
    bind(A, X, Y)
    const L = newText({
      x: 0,
      y: 0,
      text: 'label',
      fontSize: 20,
      fontFamily: 5,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: A.id,
    })
    A.boundElements = [...(A.boundElements ?? []), { id: L.id, type: 'text' }]
    const S = await room.client('S')
    await S.create([X, Y, A, L])
    const B = await room.client('B')
    const before = clone(B.confirmed.get(L.id))
    const Bm = B.copy()
    editTarget(Bm, Y.id, { x: 700, y: 500 })
    const ack = await B.push([patchOf(Bm.get(Y.id), B.confirmed.get(Y.id))])
    expect(ack.r[0]).toMatchObject({ ok: true })
    const stored = await room.stored()
    const arrow = clone(stored.get(A.id))
    const label = clone(stored.get(L.id))
    // a fresh helper call on copies (a new cache entry), against the stored arrow
    const at = LinearElementEditor.getBoundTextElementPosition(
      arrow,
      label,
      new Map([
        [arrow.id, arrow],
        [label.id, label],
      ]),
    )
    expect(Math.abs(label.x - at.x)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(label.y - at.y)).toBeLessThanOrEqual(TOL)
    // the label moved with the arrow (the arrow's end moved by (100, 200))
    expect(Math.abs(label.x - before.x) + Math.abs(label.y - before.y)).toBeGreaterThan(10)
  })
})
