// Align and distribute (./align.ts): the plan, the units (groups, frames, labels, locks) and the moves.
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { alignDeltas, distributeDeltas, moveUnits, type Unit, unitsOf } from './align.ts'

const u = (id: string, x: number, y: number, width: number, height: number): Unit => ({
  id,
  members: [id],
  bounds: { x, y, width, height },
})

describe('alignDeltas', () => {
  const units = [u('a', 0, 0, 100, 50), u('b', 200, 100, 50, 50), u('c', 50, 300, 200, 100)]
  it('lines every unit up on the selection’s edge or centre', () => {
    const left = alignDeltas(units, 'left')
    expect([...left]).toEqual([
      ['b', { dx: -200, dy: 0 }],
      ['c', { dx: -50, dy: 0 }],
    ])
    const bottom = alignDeltas(units, 'bottom')
    expect(bottom.get('a')).toEqual({ dx: 0, dy: 350 })
    expect(bottom.has('c')).toBe(false)
    const mid = alignDeltas(units, 'center-horizontal')
    // the selection spans 0..250: its centre is 125
    expect(mid.get('a')).toEqual({ dx: 75, dy: 0 })
    expect(mid.get('b')).toEqual({ dx: -100, dy: 0 })
  })
  it('does nothing for fewer than two units', () => {
    expect(alignDeltas([u('a', 0, 0, 1, 1)], 'left').size).toBe(0)
  })
})

describe('distributeDeltas', () => {
  it('equal gaps between the units, the outer ones stay', () => {
    const d = distributeDeltas(
      [u('a', 0, 0, 100, 10), u('c', 900, 0, 100, 10), u('b', 150, 0, 200, 10)],
      'horizontal',
    )
    // span 0..1000, 400 of widths: gap 300, so b starts at 400
    expect([...d]).toEqual([['b', { dx: 250, dy: 0 }]])
    const v = distributeDeltas(
      [u('a', 0, 0, 10, 100), u('b', 0, 100, 10, 100), u('c', 0, 900, 10, 100)],
      'vertical',
    )
    expect(v.get('b')).toEqual({ dx: 0, dy: 350 })
  })
  it('needs three units', () => {
    expect(distributeDeltas([u('a', 0, 0, 1, 1), u('b', 5, 0, 1, 1)], 'horizontal').size).toBe(0)
  })
})

const el = (id: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    x,
    y,
    width: 100,
    height: 100,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    ...extra,
  }) as unknown as CanvasElement

function fake(els: CanvasElement[]) {
  const map = new Map(els.map((e) => [e.id, e]))
  return {
    get: (id: string) => map.get(id),
    items: () => [...map.values()],
    bounds: (id: string) => {
      const e = map.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    isLocked: (id: string) => map.get(id)?.locked === true,
  }
}

describe('units and moves', () => {
  const els = [
    el('n', 'stickynote', 0, 0, { boundElements: [{ id: 'nl', type: 'text' }] }),
    el('nl', 'text', 10, 40, { containerId: 'n' }),
    el('g1', 'rectangle', 300, 0, { groupIds: ['G'] }),
    el('g2', 'rectangle', 450, 50, { groupIds: ['G'] }),
    el('f', 'frame', 0, 400),
    el('fc', 'rectangle', 20, 420, { frameId: 'f' }),
    el('lk', 'rectangle', 900, 900, { locked: true }),
  ]
  it('a label counts as its container, a group is one unit, a framed child goes with its frame, a lock stays out', () => {
    const c = fake(els)
    const units = unitsOf(c, ['nl', 'g1', 'g2', 'f', 'fc', 'lk'])
    expect(units.map((x) => x.id).sort()).toEqual(['f', 'group:G', 'n'])
    expect(units.find((x) => x.id === 'group:G')?.bounds).toEqual({ x: 300, y: 0, width: 250, height: 150 })
  })
  it('moves each member with its label and a frame with its children, never a locked element', () => {
    const c = fake([
      ...els,
      el('lf', 'frame', 2000, 0, { locked: true }),
      el('lfc', 'rectangle', 2010, 10, { frameId: 'lf' }),
    ])
    const writes: [string, Record<string, unknown>][] = []
    const units = [
      ...unitsOf(c, ['n', 'f']),
      { id: 'lf', members: ['lf'], bounds: { x: 2000, y: 0, width: 100, height: 100 } },
    ]
    const d = { dx: 5, dy: 7 }
    moveUnits(
      c,
      { update: (id, p) => void writes.push([id, p]) },
      units,
      new Map(units.map((x) => [x.id, d])),
    )
    expect(Object.fromEntries(writes)).toEqual({
      n: { x: 5, y: 7 },
      nl: { x: 15, y: 47 },
      f: { x: 5, y: 407 },
      fc: { x: 25, y: 427 },
    })
  })
})
