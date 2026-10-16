import { describe, expect, it } from 'vitest'
import {
  appendPlacement,
  type CardBox,
  clampY,
  columnCounts,
  dropPlacement,
  KANBAN_GAP,
  KANBAN_HEADER_H,
  KANBAN_PAD,
  mismatches,
  newKanbanSize,
  tidyPlan,
  withHidden,
  withLabel,
  withWip,
} from './layout.ts'

const FRAME = { x: 0, y: 0, width: 1500, height: 900 }
const TOP = KANBAN_HEADER_H + KANBAN_PAD
const card = (id: string, status: CardBox['status'], x: number, y: number, w = 200, h = 200): CardBox => ({
  id,
  status,
  x,
  y,
  width: w,
  height: h,
})

describe('the Kanban drop', () => {
  it('the column under the card’s centre gives its status; the card snaps into it under the header', () => {
    // five columns of 300: "In progress" is 300..600; a card whose centre is at 470
    const d = dropPlacement(FRAME, {}, { x: 370, y: 10, width: 200, height: 200 })
    expect(d).toEqual({ status: 'doing', at: { x: 350, y: TOP } })
    // past the right edge: the last column; the y is kept when it is inside
    expect(dropPlacement(FRAME, {}, { x: 1490, y: 400, width: 200, height: 200 })).toEqual({
      status: 'done',
      at: { x: 1250, y: 400 },
    })
  })

  it('hidden columns take no band: the visible ones share the frame', () => {
    const d = dropPlacement(
      FRAME,
      { hidden: ['review', 'blocked'] },
      { x: 1100, y: 300, width: 200, height: 200 },
    )
    expect(d?.status).toBe('done')
    expect(d?.at.x).toBe(1150)
  })

  it('a card is kept above the bottom when it fits, and never above the header', () => {
    expect(clampY(FRAME, 200, 2000)).toBe(900 - 200 - KANBAN_PAD)
    expect(clampY(FRAME, 200, -50)).toBe(TOP)
    // taller than the frame: under the header
    expect(clampY({ ...FRAME, height: 200 }, 400, 50)).toBe(TOP)
  })
})

describe('a status change moves the card to the bottom of its column', () => {
  it('under the cards already there, the frame growing to hold it', () => {
    const others = [card('a', 'done', 1250, TOP, 200, 200), card('b', 'done', 1250, TOP + 216, 200, 600)]
    const moving = card('m', 'done', 50, TOP, 200, 200)
    const p = appendPlacement(FRAME, {}, 'done', moving, [...others, moving])
    expect(p?.at).toEqual({ x: 1250, y: TOP + 216 + 600 + KANBAN_GAP })
    expect(p?.frameHeight).toBe(Math.ceil((p?.at.y ?? 0) + 200 + KANBAN_PAD))
  })

  it('an empty column: the top; a hidden one: nowhere', () => {
    const m = card('m', 'todo', 50, 500)
    expect(appendPlacement(FRAME, {}, 'review', m, [m])).toEqual({
      at: { x: 650, y: TOP },
      frameHeight: null,
    })
    expect(appendPlacement(FRAME, { hidden: ['review'] }, 'review', m, [m])).toBeNull()
  })
})

describe('Tidy and the mismatch hint', () => {
  const cards = [
    card('t1', 'todo', 40, 500),
    card('t2', 'todo', 60, 120),
    // a rev-13 tab moved this "To do" card into "Done": the status stays canonical
    card('x', 'todo', 1260, 300),
    card('d1', 'done', 1250, TOP),
  ]

  it('counts the cards in another column than their status’s, by the column they stand in', () => {
    expect(mismatches(FRAME, {}, cards)).toEqual(new Map([['done', ['x']]]))
    // a card whose status's column is hidden is no mismatch
    expect(mismatches(FRAME, { hidden: ['todo'] }, cards).size).toBe(0)
  })

  it('stacks every column from the top in the order its cards stand, and moves the strays home', () => {
    const { moves, frameHeight } = tidyPlan(FRAME, {}, cards)
    expect(Object.fromEntries(moves)).toEqual({
      t2: { x: 50, y: TOP },
      x: { x: 50, y: TOP + 200 + KANBAN_GAP },
      t1: { x: 50, y: TOP + 2 * (200 + KANBAN_GAP) },
    })
    expect(frameHeight).toBeNull()
    // a tidy board stays as it is
    const after = cards.map((c) => ({ ...c, ...(moves.get(c.id) ?? {}) }))
    expect(tidyPlan(FRAME, {}, after).moves.size).toBe(0)
    expect(mismatches(FRAME, {}, after).size).toBe(0)
  })

  it('counts per status and those in hidden columns', () => {
    const { counts, hidden } = columnCounts({ hidden: ['done'] }, cards)
    expect(counts.get('todo')).toBe(3)
    expect(hidden).toBe(1)
  })
})

describe('the kanban value', () => {
  it('labels: a default or an empty label removes it', () => {
    expect(withLabel({}, 'doing', 'Shooting', 'In progress')).toEqual({ labels: { doing: 'Shooting' } })
    expect(withLabel({ labels: { doing: 'Shooting' } }, 'doing', ' In progress ', 'In progress')).toEqual({})
    expect(withLabel({}, 'todo', 'x'.repeat(60), 'To do').labels?.todo).toHaveLength(40)
  })

  it('hidden: one column at least stays visible', () => {
    let v = {}
    for (const s of ['todo', 'doing', 'review', 'blocked'] as const) v = withHidden(v, s, true) ?? v
    expect(v).toEqual({ hidden: ['todo', 'doing', 'review', 'blocked'] })
    expect(withHidden(v, 'done', true)).toBeNull()
    expect(withHidden({ hidden: ['todo'] }, 'todo', false)).toEqual({})
  })

  it('WIP limits 1-99; anything else removes it', () => {
    expect(withWip({}, 'doing', 3)).toEqual({ wip: { doing: 3 } })
    expect(withWip({ wip: { doing: 3 } }, 'doing', 0)).toEqual({})
    expect(withWip({}, 'doing', 120)).toEqual({})
  })

  it('a new Kanban is a column width per visible column', () => {
    expect(newKanbanSize({})).toEqual({ width: 1500, height: 960 })
    expect(newKanbanSize({ hidden: ['blocked'] }).width).toBe(1200)
  })
})
