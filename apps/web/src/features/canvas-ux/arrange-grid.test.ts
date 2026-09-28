import { describe, expect, it } from 'vitest'
import {
  arrangeAsGrid,
  autoColumns,
  clampColumns,
  type GridItem,
  gridGap,
  layoutGrid,
  readingOrder,
  readingRows,
} from './arrange-grid.ts'

const note = (id: string, x: number, y: number, w = 200, h = 200): GridItem => ({ id, x, y, w, h })
const ids = (items: readonly GridItem[]) => items.map((i) => i.id)

/** Bounds of the item `id` after the layout. */
const placedBox = (items: readonly GridItem[], plan: ReturnType<typeof arrangeAsGrid>, id: string) => {
  const it = items.find((i) => i.id === id) as GridItem
  const p = plan?.positions[id] as { x: number; y: number }
  return { x: p.x, y: p.y, w: it.w, h: it.h }
}
const overlaps = (a: GridItem | ReturnType<typeof placedBox>, b: GridItem | ReturnType<typeof placedBox>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('reading order', () => {
  it('reads rows top to bottom and each row left to right', () => {
    const items = [
      note('c', 600, 10),
      note('a', 0, 0),
      note('d', 20, 400),
      note('b', 300, -30),
      note('e', 500, 420),
    ]
    expect(readingRows(items).map(ids)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ])
  })

  it('keeps top-aligned items of different heights in one row', () => {
    const items = [note('tall', 0, 0, 400, 900), note('small', 500, 0, 200, 100), note('under', 0, 1000)]
    expect(readingRows(items).map(ids)).toEqual([['tall', 'small'], ['under']])
  })

  it('a single column reads top to bottom', () => {
    const items = [note('3', 0, 600), note('1', 0, 0), note('2', 10, 300)]
    expect(ids(readingOrder(items))).toEqual(['1', '2', '3'])
  })

  it('is deterministic for identical positions', () => {
    const items = [note('b', 0, 0), note('a', 0, 0)]
    expect(ids(readingOrder(items))).toEqual(['a', 'b'])
  })
})

describe('columns and gap', () => {
  const n = (count: number, w = 200, h = 200) =>
    Array.from({ length: count }, (_, i) => note(`s${i}`, i * (w + 50), 0, w, h))

  it('makes a near-square grid of notes', () => {
    expect([2, 3, 4, 5, 6, 9, 10, 16, 47].map((c) => autoColumns(n(c)))).toEqual([2, 2, 2, 3, 3, 3, 4, 4, 7])
  })

  it('uses fewer columns for wide items and more for tall ones', () => {
    expect(autoColumns(n(16, 800, 200))).toBeLessThan(autoColumns(n(16)))
    expect(autoColumns(n(16, 200, 800))).toBeGreaterThan(autoColumns(n(16)))
  })

  it('balances the last row (10 notes: 4 + 4 + 2, never 5 + 5 + 0)', () => {
    const plan = arrangeAsGrid({ items: n(10) })
    expect(plan?.columns).toBe(4)
    expect(plan?.rows).toBe(3)
  })

  it('gaps like bulk paste for notes, and scale with larger items', () => {
    expect(gridGap(n(4))).toBe(20)
    expect(gridGap(n(4, 1200, 900))).toBe(90)
    expect(gridGap(n(4, 5000, 5000))).toBe(200)
    expect(gridGap(n(4, 20, 20))).toBe(20)
  })

  it('clamps explicit counts', () => {
    expect(clampColumns(0, 5)).toBe(1)
    expect(clampColumns(9, 5)).toBe(5)
    expect(clampColumns(2.6, 5)).toBe(3)
    expect(clampColumns(Number.NaN, 5)).toBe(1)
  })
})

describe('layoutGrid', () => {
  it('sizes columns by their widest item and rows by their tallest', () => {
    const items = [
      note('a', 0, 0, 100, 50),
      note('b', 0, 0, 300, 80),
      note('c', 0, 0, 200, 200),
      note('d', 0, 0, 50, 50),
    ]
    const plan = layoutGrid(items, 2, { x: 10, y: 20 }, 10)
    expect(plan.positions).toEqual({
      a: { x: 10, y: 20 },
      b: { x: 10 + 200 + 10, y: 20 },
      c: { x: 10, y: 20 + 80 + 10 },
      d: { x: 220, y: 110 },
    })
    expect(plan.bounds).toEqual({ x: 10, y: 20, w: 200 + 10 + 300, h: 80 + 10 + 200 })
  })
})

describe('arrangeAsGrid', () => {
  it('needs two items', () => {
    expect(arrangeAsGrid({ items: [note('a', 0, 0)] })).toBeNull()
    expect(arrangeAsGrid({ items: [] })).toBeNull()
  })

  it('tidies a scattered selection in reading order, starting at its top-left, with no overlaps', () => {
    const items = [
      note('n1', 40, 30),
      note('n2', 700, 0),
      note('n3', 1500, 60),
      note('n4', 10, 900),
      note('n5', 800, 950),
      note('n6', 1600, 880),
      note('n7', 300, 1800),
      note('n8', 1200, 1750),
      note('n9', 2000, 1790),
    ]
    const plan = arrangeAsGrid({ items })
    expect(plan?.columns).toBe(3)
    expect(plan?.order).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'])
    expect(plan?.bounds).toEqual({ x: 10, y: 0, w: 640, h: 640 })
    expect(plan?.positions.n1).toEqual({ x: 10, y: 0 })
    expect(plan?.positions.n5).toEqual({ x: 230, y: 220 })
    expect(plan?.positions.n9).toEqual({ x: 450, y: 440 })
    const boxes = items.map((i) => placedBox(items, plan, i.id))
    boxes.forEach((a, i) => {
      for (const b of boxes.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
    })
  })

  it('turns one long row (47 images) into a compact block', () => {
    const items = Array.from({ length: 47 }, (_, i) => note(`img${i}`, i * 1900, 0, 1800, 1200))
    const plan = arrangeAsGrid({ items })
    expect(plan?.order).toEqual(items.map((i) => i.id))
    const b = plan?.bounds as { w: number; h: number }
    expect(b.w / b.h).toBeGreaterThan(0.6)
    expect(b.w / b.h).toBeLessThan(1.7)
    expect(b.w).toBeLessThan(47 * 1900 * 0.2)
  })

  it('keeps a given fill order when the column count changes', () => {
    const items = [note('a', 0, 0), note('b', 220, 0), note('c', 0, 220), note('d', 220, 220)]
    const plan = arrangeAsGrid({ items, columns: 4, order: ['a', 'b', 'c', 'd'] })
    expect(plan?.columns).toBe(4)
    expect(plan?.rows).toBe(1)
    expect(['a', 'b', 'c', 'd'].map((id) => plan?.positions[id]?.x)).toEqual([0, 220, 440, 660])
  })

  describe('inside a frame', () => {
    it('stays where it is when it already fits', () => {
      const items = [note('a', 50, 60), note('b', 400, 80), note('c', 60, 400), note('d', 420, 420)]
      const plan = arrangeAsGrid({ items, frame: { w: 1000, h: 800 } })
      expect(plan?.bounds).toEqual({ x: 50, y: 60, w: 420, h: 420 })
      expect(plan?.frameSize).toBeUndefined()
    })

    it('shifts back inside when the grid would overflow the frame edge', () => {
      const items = [note('a', 700, 500), note('b', 760, 520), note('c', 720, 540), note('d', 780, 560)]
      const plan = arrangeAsGrid({ items, frame: { w: 1000, h: 800 } })
      const b = plan?.bounds as { x: number; y: number; w: number; h: number }
      const gap = plan?.gap ?? Number.NaN
      expect(b.x + b.w).toBeLessThanOrEqual(1000 - gap)
      expect(b.y + b.h).toBeLessThanOrEqual(800 - gap)
      expect(plan?.frameSize).toBeUndefined()
    })

    it('prefers an automatic column count that fits a narrow frame', () => {
      // A tall, narrow frame (one note wide + margins): 4 notes go in one column instead of 2×2.
      const items = [note('a', 20, 20), note('b', 20, 240), note('c', 20, 460), note('d', 20, 680)]
      const plan = arrangeAsGrid({ items, frame: { w: 240, h: 1000 } })
      expect(plan?.columns).toBe(1)
      expect(plan?.frameSize).toBeUndefined()
    })

    it('grows the frame only when nothing fits (never shrinks it)', () => {
      const items = Array.from({ length: 6 }, (_, i) => note(`n${i}`, 20 + i * 10, 20, 200, 200))
      const plan = arrangeAsGrid({ items, frame: { w: 300, h: 300 } })
      expect(plan?.frameSize).toBeDefined()
      const size = plan?.frameSize as { w: number; h: number }
      const b = plan?.bounds as { x: number; y: number; w: number; h: number }
      expect(size.w).toBeGreaterThanOrEqual(b.x + b.w)
      expect(size.h).toBeGreaterThanOrEqual(b.y + b.h)
      expect(size.w).toBeGreaterThanOrEqual(300)
      expect(size.h).toBeGreaterThanOrEqual(300)
    })

    it('an explicit column count is kept even when the frame must grow', () => {
      const items = [note('a', 20, 20), note('b', 20, 240), note('c', 20, 460)]
      const plan = arrangeAsGrid({ items, columns: 3, frame: { w: 240, h: 1000 } })
      expect(plan?.columns).toBe(3)
      expect(plan?.frameSize?.w).toBeGreaterThan(240)
      expect(plan?.frameSize?.h).toBe(1000)
    })
  })
})
