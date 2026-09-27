import { describe, expect, it } from 'vitest'
import { rectContains, rectsOverlap } from '../features/canvas-ux/placement.ts'
import {
  cameraTargetAfterDrop,
  DROP_LAYOUT,
  type DropContainer,
  fitInSlot,
  layoutCardRows,
  layoutImageGrid,
  planDrop,
  type Rect,
  type Size,
} from './drop-layout.ts'

// A 1280x720 viewport at 100 %, centred on the origin.
const VIEW = { viewport: { x: -640, y: -360, w: 1280, h: 720 }, zoom: 1 }
const PAGE: DropContainer = { id: null, bounds: null, obstacles: [] }
const CARD_GAP = 24

const MIXED: Size[] = [
  { w: 1600, h: 1067 },
  { w: 1080, h: 1350 },
  { w: 1200, h: 1200 },
  { w: 2400, h: 1000 },
  { w: 1080, h: 1920 },
  { w: 3000, h: 2000 },
  { w: 800, h: 600 },
  { w: 1920, h: 1080 },
  { w: 1000, h: 1500 },
  { w: 2560, h: 1440 },
  { w: 640, h: 960 },
  { w: 5000, h: 5000 },
]
const many = (n: number) => Array.from({ length: n }, (_, i) => MIXED[i % MIXED.length] as Size)
const longest = (r: Rect) => Math.max(r.w, r.h)
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const bounds = (rs: Rect[]) => {
  const x = Math.min(...rs.map((r) => r.x))
  const y = Math.min(...rs.map((r) => r.y))
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }
}
function expectNoOverlaps(rs: Rect[]) {
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) expect(rectsOverlap(rs[i] as Rect, rs[j] as Rect)).toBe(false)
}

describe('layoutImageGrid', () => {
  it('gives one image a longest side of 40 % of the viewport’s shorter side, aspect kept', () => {
    const { items, w, h } = layoutImageGrid([{ w: 6000, h: 4000 }], VIEW)
    expect(items).toHaveLength(1)
    expect(longest(items[0] as Rect)).toBeCloseTo(0.4 * 720, 6)
    expect((items[0] as Rect).w / (items[0] as Rect).h).toBeCloseTo(1.5, 6)
    expect([w, h]).toEqual([(items[0] as Rect).w, (items[0] as Rect).h])
  })

  it('is relative to the screen: at 50 % zoom the page size doubles', () => {
    const at100 = layoutImageGrid(MIXED, VIEW)
    const at50 = layoutImageGrid(MIXED, {
      viewport: { x: 0, y: 0, w: 2560, h: 1440 },
      zoom: 0.5,
    })
    expect(at50.w).toBeCloseTo(at100.w * 2, 6)
    expect(at50.h).toBeCloseTo(at100.h * 2, 6)
  })

  it('puts 12 mixed images in a 4-column grid of equal cells with even 20 px gaps', () => {
    const { items } = layoutImageGrid(MIXED, VIEW)
    expect(items).toHaveLength(12)
    // Every image has the same longest side (the cell), whatever its pixel size or aspect.
    const cell = longest(items[0] as Rect)
    for (const [i, r] of items.entries()) {
      expect(longest(r)).toBeCloseTo(cell, 6)
      const size = MIXED[i] as Size
      expect(r.w / r.h).toBeCloseTo(size.w / size.h, 6)
    }
    // Cell centres step by cell + gap, 4 per row, 3 rows.
    const centres = items.map(center)
    const col = (i: number) => (centres[i] as { x: number }).x
    const row = (i: number) => (centres[i] as { y: number }).y
    expect(col(1) - col(0)).toBeCloseTo(cell + DROP_LAYOUT.gapPx, 6)
    expect(col(3) - col(2)).toBeCloseTo(cell + DROP_LAYOUT.gapPx, 6)
    expect(col(4)).toBeCloseTo(col(0), 6)
    expect(row(4) - row(0)).toBeCloseTo(cell + DROP_LAYOUT.gapPx, 6)
    expect(row(8) - row(4)).toBeCloseTo(cell + DROP_LAYOUT.gapPx, 6)
    expectNoOverlaps(items)
    // And the whole grid fits in the viewport, so the camera does not have to move.
    const b = bounds(items)
    expect(b.w).toBeLessThanOrEqual(VIEW.viewport.w)
    expect(b.h).toBeLessThanOrEqual(VIEW.viewport.h)
  })

  it('keeps a 47-image batch within 2–3 viewports at the current zoom (not 88,000 units wide)', () => {
    const { items, w, h } = layoutImageGrid(many(47), VIEW)
    expect(items).toHaveLength(47)
    expect(w / VIEW.viewport.w).toBeLessThanOrEqual(2)
    expect(h / VIEW.viewport.h).toBeLessThanOrEqual(2)
    expect((w * h) / (VIEW.viewport.w * VIEW.viewport.h)).toBeLessThanOrEqual(3)
    // 7 columns; thumbnails stay at least 20 % of the shorter side.
    expect(new Set(items.map((r) => Math.round(center(r).x))).size).toBe(7)
    for (const r of items) expect(longest(r)).toBeGreaterThanOrEqual(0.2 * 720 - 1e-6)
    expectNoOverlaps(items)
  })

  it('never enlarges a small image past 2 screen px per image px', () => {
    const { items } = layoutImageGrid([{ w: 64, h: 32 }], VIEW)
    expect((items[0] as Rect).w).toBeCloseTo(128, 6)
  })

  it('treats broken sizes as square instead of producing NaN', () => {
    const { items } = layoutImageGrid(
      [
        { w: 0, h: 0 },
        { w: Number.NaN, h: 10 },
      ],
      VIEW,
    )
    for (const r of items) for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('layoutCardRows', () => {
  const card = { w: 260, h: 356 }
  it('wraps into rows before the maximum width, rows centred, tops aligned', () => {
    const { items, w } = layoutCardRows([card, card, card, card, card], { maxRowWidth: 900, gap: 24 })
    // 3 cards = 828 <= 900; the 4th would be 1112.
    expect(items.map((r) => r.y)).toEqual([0, 0, 0, 356 + 24, 356 + 24])
    expect(w).toBe(828)
    expect((items[3] as Rect).x).toBeCloseTo((828 - (2 * 260 + 24)) / 2, 6)
    expectNoOverlaps(items)
  })
  it('keeps at least one card per row', () => {
    const { items } = layoutCardRows([card, card], { maxRowWidth: 10, gap: 24 })
    expect(items.map((r) => r.x)).toEqual([0, 0])
  })
})

describe('planDrop', () => {
  it('centres the grid on the drop point on an empty page, cards under it', () => {
    const plan = planDrop({
      images: MIXED.slice(0, 3),
      cards: [
        { w: 260, h: 356 },
        { w: 360, h: 276 },
      ],
      center: { x: 100, y: 50 },
      view: VIEW,
      containers: [PAGE],
      cardGap: CARD_GAP,
    })
    expect(plan.containerId).toBeNull()
    const grid = bounds(plan.images)
    expect(center(grid).x).toBeCloseTo(100, 6)
    expect(center(grid).y).toBeCloseTo(50, 6)
    for (const c of plan.cards) expect(c.y).toBeGreaterThan(grid.y + grid.h)
    expectNoOverlaps([...plan.images, ...plan.cards])
  })

  it('moves to the nearest empty spot instead of covering existing content', () => {
    const note = { x: -100, y: -100, w: 200, h: 200 }
    const plan = planDrop({
      images: MIXED.slice(0, 4),
      cards: [],
      center: { x: 0, y: 0 },
      view: VIEW,
      containers: [{ id: null, bounds: null, obstacles: [note] }],
      cardGap: CARD_GAP,
    })
    for (const r of plan.images) expect(rectsOverlap(r, note)).toBe(false)
    // Nearby: within one grid size of the drop point.
    const g = bounds(plan.images)
    expect(Math.hypot(center(g).x, center(g).y)).toBeLessThan(Math.max(g.w, g.h) * 1.5)
  })

  it('goes into the frame under the drop point when the whole block fits there', () => {
    const frame = { x: -1000, y: -800, w: 2000, h: 1600 }
    const plan = planDrop({
      images: MIXED.slice(0, 3),
      cards: [{ w: 260, h: 356 }],
      center: { x: 900, y: 0 }, // near the right edge: the block is pulled inside
      view: VIEW,
      containers: [
        { id: 'shape:frame', bounds: frame, obstacles: [] },
        { id: null, bounds: null, obstacles: [frame] },
      ],
      cardGap: CARD_GAP,
    })
    expect(plan.containerId).toBe('shape:frame')
    for (const r of [...plan.images, ...plan.cards]) expect(rectContains(frame, r)).toBe(true)
  })

  it('leaves a frame whose free space is too small and lands on the page, clear of the frame', () => {
    // "3 · Imagery": a 1520 x 900 frame whose slots fill it.
    const frame = { x: 0, y: 760, w: 1520, h: 900 }
    const slots: Rect[] = []
    for (let i = 0; i < 6; i++)
      slots.push({ x: 40 + (i % 3) * 490, y: 760 + 190 + Math.floor(i / 3) * 330, w: 460, h: 300 })
    const heading = { x: 40, y: 792, w: 1440, h: 40 }
    const plan = planDrop({
      images: MIXED,
      cards: [],
      center: { x: 760, y: 1210 },
      view: { viewport: { x: -40, y: 710, w: 1600, h: 1000 }, zoom: 0.72 },
      containers: [
        { id: 'shape:imagery', bounds: frame, obstacles: [heading, ...slots] },
        { id: null, bounds: null, obstacles: [frame, { x: 0, y: 0, w: 760, h: 640 }] },
      ],
      cardGap: CARD_GAP,
    })
    expect(plan.containerId).toBeNull()
    for (const r of plan.images) expect(rectsOverlap(r, frame)).toBe(false)
  })

  it('tries the inner frame, then the outer one, then the page', () => {
    const outer = { x: 0, y: 0, w: 3000, h: 3000 }
    const inner = { x: 100, y: 100, w: 300, h: 300 }
    const plan = planDrop({
      images: MIXED.slice(0, 2),
      cards: [],
      center: { x: 250, y: 250 },
      view: VIEW,
      containers: [
        { id: 'shape:inner', bounds: inner, obstacles: [] },
        { id: 'shape:outer', bounds: outer, obstacles: [inner] },
        { id: null, bounds: null, obstacles: [outer] },
      ],
      cardGap: CARD_GAP,
    })
    expect(plan.containerId).toBe('shape:outer')
    for (const r of plan.images) {
      expect(rectContains(outer, r)).toBe(true)
      expect(rectsOverlap(r, inner)).toBe(false)
    }
  })
})

describe('fitInSlot', () => {
  it('contain-fits a 16:9 frame grab into a slot, centred', () => {
    const slot = { x: 24, y: 84, w: 352, h: 198 }
    const r = fitInSlot({ w: 1920, h: 1080 }, slot)
    const eps = 1e-6
    expect(rectContains({ x: 24 - eps, y: 84 - eps, w: 352 + 2 * eps, h: 198 + 2 * eps }, r)).toBe(true)
    expect(r.w).toBeCloseTo(352, 6)
    const tall = fitInSlot({ w: 1000, h: 2000 }, slot)
    expect(tall.h).toBeCloseTo(198, 6)
    expect(center(tall).x).toBeCloseTo(center(slot).x, 6)
  })
})

describe('cameraTargetAfterDrop', () => {
  const vp = { x: 0, y: 0, w: 1000, h: 600 }
  it('does nothing when everything is in view', () => {
    expect(cameraTargetAfterDrop(vp, { x: 10, y: 10, w: 100, h: 100 })).toBeNull()
  })
  it('zooms out to show the old view and the new content when they are close', () => {
    expect(cameraTargetAfterDrop(vp, { x: 800, y: 400, w: 400, h: 400 })).toEqual({
      x: 0,
      y: 0,
      w: 1200,
      h: 800,
    })
  })
  it('goes to the content alone when it landed far away (never a 5 % view)', () => {
    const far = { x: 50_000, y: 0, w: 400, h: 400 }
    expect(cameraTargetAfterDrop(vp, far)).toEqual(far)
  })
})
