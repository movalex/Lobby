import { describe, expect, it } from 'vitest'
import {
  adjacentEntry,
  elementBounds,
  entryOfSelection,
  inReadingOrder,
  isStacked,
  levelEntries,
  levelOfSelection,
  readingOrder,
} from './reading-order.ts'
import { el, frame, input, note, text } from './test-kit.ts'

const keys = (order: { key: string }[]) => order.map((e) => e.key)
const box = (key: string, x: number, y: number) => ({
  key,
  bounds: { x: x - 5, y: y - 5, width: 10, height: 10 },
})

describe('reading order (tldraw 5.4.2 _getShapesInReadingOrder)', () => {
  it('reads rows top to bottom, each row left to right', () => {
    const order = inReadingOrder([box('c', 500, 20), box('a', 0, 0), box('d', 0, 300), box('b', 250, -40)])
    expect(keys(order)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('starts a new row once a centre is 100 px or more below the row', () => {
    expect(keys(inReadingOrder([box('low', 0, 100), box('high', 50, 0)]))).toEqual(['high', 'low'])
    expect(keys(inReadingOrder([box('right', 50, 99), box('left', 0, 0)]))).toEqual(['left', 'right'])
  })

  it('W5-59: a heading is read before the line under it, whatever their widths (stacked boxes start a new row)', () => {
    const wide = (key: string, x: number, y: number, width: number, height: number) => ({
      key,
      bounds: { x, y, width, height },
    })
    // the Lobby tour's "1 · Welcome": a heading as wide as the frame, a slightly narrower subtitle under it,
    // then three cards side by side
    const order = inReadingOrder([
      wide('subtitle', 40, 95, 600, 40),
      wide('card-2', 260, 160, 200, 90),
      wide('heading', 40, 40, 640, 50),
      wide('card-1', 40, 160, 200, 90),
      wide('card-3', 480, 160, 200, 90),
    ])
    expect(keys(order)).toEqual(['heading', 'subtitle', 'card-1', 'card-2', 'card-3'])
    // side by side (sharing height) and scattered (sharing no width) still make one row
    expect(isStacked({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 60, width: 80, height: 20 })).toBe(
      true,
    )
    expect(isStacked({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 30, width: 80, height: 50 })).toBe(
      false,
    )
    expect(isStacked({ x: 0, y: 0, width: 10, height: 10 }, { x: 250, y: 40, width: 10, height: 10 })).toBe(
      false,
    )
  })

  it('swaps a nearer entry two places on forward when it is at a shallow angle', () => {
    // sorted by x: a (0,0), b (100,95), c (110,0); c is nearer to a than b and level with it
    const order = inReadingOrder([box('b', 100, 95), box('a', 0, 0), box('c', 110, 0)])
    expect(keys(order)).toEqual(['a', 'c', 'b'])
  })
})

describe('element bounds (from the fields, no scene lookup)', () => {
  it('a box is its box; a rotated box its turned corners; a line its points', () => {
    expect(elementBounds(el({ x: 10, y: 20, width: 100, height: 50 }))).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    })
    const turned = elementBounds(el({ x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 }))
    expect(turned.width).toBeCloseTo(20)
    expect(turned.height).toBeCloseTo(100)
    expect(turned.x + turned.width / 2).toBeCloseTo(50)
    const arrow = el({
      type: 'arrow',
      x: 100,
      y: 100,
      width: 50,
      height: 30,
      points: [
        [0, 0],
        [-50, 30],
      ],
    })
    expect(elementBounds(arrow)).toEqual({ x: 50, y: 100, width: 50, height: 30 })
  })
})

describe('levels', () => {
  const board = [
    frame('f', 0, 0, 800, 500, 'Retro'),
    ...note('in-1', 400, 100, 'Second inside', { frameId: 'f' }),
    ...note('in-2', 100, 100, 'First inside', { frameId: 'f' }),
    ...note('loose', 1000, 100, 'Loose'),
    text('title', 0, -200, 'Agenda'),
    el({ id: 'g1', x: 0, y: 700, groupIds: ['grp'] }),
    el({ id: 'g2', x: 200, y: 700, groupIds: ['grp'] }),
    el({ id: 'gone', x: 5000, y: 0, isDeleted: true }),
    el({ id: 'hidden', x: -500, y: -500 }),
  ]

  it('the top level: frames, loose items and groups as one stop each; no labels, frame children, hidden or deleted', () => {
    const order = readingOrder(input(board, ['hidden']), null)
    expect(keys(order)).toEqual(['title', 'f', 'loose', 'group:grp'])
    const group = order.find((e) => e.group === 'grp')
    expect(group?.ids).toEqual(['g1', 'g2'])
    expect(group?.bounds).toEqual({ x: 0, y: 700, width: 300, height: 100 })
  })

  it("a frame's level: its children in reading order", () => {
    expect(keys(readingOrder(input(board), 'f'))).toEqual(['in-2', 'in-1'])
    expect(levelEntries(input(board), 'nope')).toEqual([])
  })

  it('the level of a selection: the frame all selected share, labels counting as their notes', () => {
    const get = (id: string) => board.find((e) => e.id === id)
    expect(levelOfSelection(['in-1', 'in-2'], get)).toBe('f')
    expect(levelOfSelection(['in-1-label'], get)).toBe('f')
    expect(levelOfSelection(['in-1', 'loose'], get)).toBeNull()
    expect(levelOfSelection(['loose'], get)).toBeNull()
    expect(levelOfSelection([], get)).toBeNull()
  })

  it('next and previous wrap; with nothing selected next is the first and previous the last', () => {
    const order = readingOrder(input(board, ['hidden']), null)
    expect(adjacentEntry(order, [], 'next')?.key).toBe('title')
    expect(adjacentEntry(order, [], 'prev')?.key).toBe('group:grp')
    expect(adjacentEntry(order, ['title'], 'next')?.key).toBe('f')
    expect(adjacentEntry(order, ['title'], 'prev')?.key).toBe('group:grp')
    expect(adjacentEntry(order, ['g2', 'g1'], 'next')?.key).toBe('title')
    expect(adjacentEntry([], ['title'], 'next')).toBeNull()
  })

  it('the entry of a selection: an exact match first, else the first entry it touches', () => {
    const order = readingOrder(input(board, ['hidden']), null)
    expect(entryOfSelection(order, ['g1', 'g2'])?.key).toBe('group:grp')
    expect(entryOfSelection(order, ['g2'])?.key).toBe('group:grp')
    expect(entryOfSelection(order, ['loose', 'f'])?.key).toBe('f')
    expect(entryOfSelection(order, [])).toBeNull()
  })
})
