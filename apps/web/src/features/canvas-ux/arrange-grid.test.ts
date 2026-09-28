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
  it('uses one column width (the widest item), rows as tall as their tallest item, items centred', () => {
    const items = [
      note('a', 0, 0, 100, 50),
      note('b', 0, 0, 300, 80),
      note('c', 0, 0, 200, 200),
      note('d', 0, 0, 50, 50),
    ]
    // Columns 300 wide, gap 10: x 10 / 320. Row 1 is 80 tall (y 20), row 2 is 200 tall (y 110).
    const plan = layoutGrid(items, 2, { x: 10, y: 20 }, 10)
    expect(plan.positions).toEqual({
      a: { x: 10 + 100, y: 20 + 15 },
      b: { x: 320, y: 20 },
      c: { x: 10 + 50, y: 110 },
      d: { x: 320 + 125, y: 110 + 75 },
    })
    expect(plan.bounds).toEqual({ x: 10, y: 20, w: 300 + 10 + 300, h: 80 + 10 + 200 })
  })

  it('F2-06: a grid of landscape photos has even gutters (rows as tall as the photos)', () => {
    const items = Array.from({ length: 6 }, (_, i) => note(`p${i}`, i * 700, 0, 631, 473))
    const plan = layoutGrid(items, 3, { x: 0, y: 0 }, 37)
    const p = (id: string) => plan.positions[id] as { x: number; y: number }
    const horizontalGap = p('p1').x - (p('p0').x + 631)
    const verticalGap = p('p3').y - (p('p0').y + 473)
    expect(horizontalGap).toBe(37)
    expect(verticalGap).toBe(37)
  })

  it('F7: mixed portrait, landscape and card sizes line up on shared centre lines (no ragged columns)', () => {
    // 170-wide landscape and portrait images plus a 360-wide video card, as in the mood-board review.
    const sizes: [number, number][] = [
      [170, 113],
      [113, 170],
      [360, 276],
      [170, 128],
      [128, 170],
      [170, 170],
    ]
    const items = sizes.map(([w, h], i) => note(`i${i}`, i * 400, 0, w, h))
    const plan = layoutGrid(items, 3, { x: 0, y: 0 }, 20)
    const centre = (id: string) => {
      const it = items.find((i) => i.id === id) as GridItem
      const p = plan.positions[id] as { x: number; y: number }
      return { x: p.x + it.w / 2, y: p.y + it.h / 2 }
    }
    // Column centres match row to row; row centres match across a row; the column pitch is uniform.
    for (let c = 0; c < 3; c++) expect(centre(`i${c}`).x).toBeCloseTo(centre(`i${c + 3}`).x)
    for (let r = 0; r < 2; r++) {
      const ys = [0, 1, 2].map((c) => centre(`i${r * 3 + c}`).y)
      expect(new Set(ys).size).toBe(1)
    }
    const pitch1 = centre('i1').x - centre('i0').x
    const pitch2 = centre('i2').x - centre('i1').x
    expect(pitch1).toBe(pitch2)
    expect(pitch1).toBe(360 + 20)
    // Nothing overlaps.
    const boxes = items.map((i) => ({ ...plan.positions[i.id], w: i.w, h: i.h }) as GridItem)
    boxes.forEach((a, i) => {
      for (const b of boxes.slice(i + 1)) expect(overlaps(a, b)).toBe(false)
    })
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

  describe('F2-03: a subset next to other shapes', () => {
    // 23 photos in a 6 × 4 block, three file cards just below it (the review's Halden board).
    const photos = Array.from({ length: 23 }, (_, i) =>
      note(`h${i}`, (i % 6) * 150, Math.floor(i / 6) * 150, 136, 136),
    )
    const cards = [
      note('pdf', 0, 620, 100, 120),
      note('img', 150, 620, 136, 80),
      note('mp4', 300, 620, 136, 80),
    ]

    it('picks a column count that stays clear of the neighbours', () => {
      const plan = arrangeAsGrid({ items: photos, obstacles: cards })
      expect(plan?.pushed).toBeUndefined()
      for (const p of photos)
        for (const c of cards)
          expect(overlaps(placedBox(photos, plan, p.id), c), `${p.id} over ${c.id}`).toBe(false)
    })

    it('moves the neighbours below down when no count stays clear (an explicit count)', () => {
      const plan = arrangeAsGrid({ items: photos, columns: 3, obstacles: cards })
      expect(plan?.columns).toBe(3)
      const pushed = plan?.pushed ?? {}
      expect(Object.keys(pushed).sort()).toEqual(['img', 'mp4', 'pdf'])
      const bottom = (plan?.bounds.y ?? 0) + (plan?.bounds.h ?? 0)
      for (const c of cards) expect(pushed[c.id]?.y).toBeGreaterThanOrEqual(bottom)
      // They keep their row: the same distance moved for each.
      expect(new Set(cards.map((c) => (pushed[c.id]?.y ?? 0) - c.y)).size).toBe(1)
    })

    it('ignores shapes the selection already overlapped (a zone drawn behind the notes)', () => {
      const zone = note('zone', -20, -20, 1000, 700)
      const plan = arrangeAsGrid({ items: photos, obstacles: [zone] })
      expect(plan?.pushed).toBeUndefined()
      expect(plan?.columns).toBe(autoColumns(photos))
    })
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
