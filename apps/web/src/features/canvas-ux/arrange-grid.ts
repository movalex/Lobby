// "Arrange as grid" (MAK-18): pure layout for a multi-selection, in the coordinate space of the parent
// the grid lives in (the page, or the frame / group every item shares). No editor here; the wiring is
// arrange-grid-runtime.ts.
//
// Rules:
//  - Reading order is kept: items are grouped into visual rows (top to bottom), each row read left to
//    right; the grid is filled row by row in that order.
//  - Column count: near-square overall (ceil(sqrt(n × cellH / cellW)) from the cell size), then
//    balanced so the last row is as full as it can be. An explicit count (the stepper) wins.
//  - Cells: every column is as wide as the widest item, so columns share one centre line and one pitch
//    (mixed portrait / landscape images and cards no longer leave ragged columns). Each row is as tall
//    as its tallest item (F2-06: a row of landscape photos is not spaced as if they were portrait), and
//    each item is centred in its cell. One even gap between cells: max(20, 10% of the median item's
//    shorter side), at most 200 (notes: 20, like bulk paste).
//  - The grid starts at the selection's top-left, so the arranged block stays where it was.
//  - F2-03: arranging part of a board must not grow over its neighbours (the unselected shapes in the
//    same parent, `obstacles`). An automatic column count that stays clear of them is preferred (closest
//    to the near-square one); when none does, the neighbours the grid still covers move down below it.
//  - Inside a frame the grid must stay inside it: it is shifted to fit, an automatic column count that
//    fits is preferred, and only when nothing fits does the frame grow (never shrink).

import { DEFAULT_NOTE_GAP } from './deps.ts'
import type { Rect } from './placement.ts'

export interface GridItem {
  id: string
  /** Axis-aligned bounds in the grid parent's space. */
  x: number
  y: number
  w: number
  h: number
}

export interface GridLayout {
  /** Item ids in fill order (reading order). */
  order: string[]
  columns: number
  rows: number
  gap: number
  /** New top-left of each item's bounds, in the parent's space. */
  positions: Record<string, { x: number; y: number }>
  /** The whole grid, in the parent's space. */
  bounds: Rect
}

const MAX_GAP = 200

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/** Vertical overlap of two spans. */
function overlapY(a: { y: number; h: number }, b: { y: number; h: number }): number {
  return Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
}

/**
 * Visual rows, top to bottom, each left to right. An item joins a row when it overlaps the row's
 * vertical band by at least half of the shorter of the two (so top-aligned items of different heights
 * and slightly staggered notes share a row; the next grid row, below a gap, does not).
 */
export function readingRows(items: readonly GridItem[]): GridItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1))
  const rows: { band: { y: number; h: number }; items: GridItem[] }[] = []
  for (const item of sorted) {
    let target: (typeof rows)[number] | undefined
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i] as (typeof rows)[number]
      const needed = 0.5 * Math.max(1e-6, Math.min(item.h, row.band.h))
      if (overlapY(item, row.band) >= needed) {
        target = row
        break
      }
    }
    if (target) {
      target.items.push(item)
      const top = Math.min(target.band.y, item.y)
      const bottom = Math.max(target.band.y + target.band.h, item.y + item.h)
      target.band = { y: top, h: bottom - top }
    } else rows.push({ band: { y: item.y, h: item.h }, items: [item] })
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1)))
}

export function readingOrder(items: readonly GridItem[]): GridItem[] {
  return readingRows(items).flat()
}

export function gridGap(items: readonly GridItem[]): number {
  const side = median(items.map((i) => Math.min(i.w, i.h)))
  return Math.round(Math.min(MAX_GAP, Math.max(DEFAULT_NOTE_GAP, side * 0.1)))
}

/** The uniform cell: as wide as the widest item, as tall as the tallest. */
export function gridCell(items: readonly GridItem[]): { w: number; h: number } {
  let w = 0
  let h = 0
  for (const item of items) {
    w = Math.max(w, item.w)
    h = Math.max(h, item.h)
  }
  return { w, h }
}

/** Each row's height (its tallest item) when `ordered` fills `cols` columns. */
function rowHeights(ordered: readonly GridItem[], cols: number): number[] {
  const heights: number[] = []
  ordered.forEach((item, i) => {
    const r = Math.floor(i / cols)
    heights[r] = Math.max(heights[r] ?? 0, item.h)
  })
  return heights
}

/** The automatic column count: a near-square grid, balanced so no row is much emptier than needed. */
export function autoColumns(items: readonly GridItem[], gap = gridGap(items)): number {
  const n = items.length
  if (n <= 1) return 1
  const cell = gridCell(items)
  const cw = cell.w + gap
  const ch = cell.h + gap
  const raw = Math.ceil(Math.sqrt((n * ch) / Math.max(cw, 1e-6)) - 1e-9)
  const cols = Math.min(n, Math.max(1, raw))
  const rows = Math.ceil(n / cols)
  return Math.ceil(n / rows)
}

export function clampColumns(columns: number, n: number): number {
  if (!Number.isFinite(columns)) return 1
  return Math.min(Math.max(1, Math.round(columns)), Math.max(1, n))
}

/** The grid's size only (no positions): cheap enough to try every column count. */
function gridSize(ordered: readonly GridItem[], columns: number, gap: number): { w: number; h: number } {
  const cols = clampColumns(columns, ordered.length)
  const heights = rowHeights(ordered, cols)
  const cell = gridCell(ordered)
  return {
    w: cols * cell.w + gap * (cols - 1),
    h: heights.reduce((s, h) => s + h, 0) + gap * (heights.length - 1),
  }
}

/** Lays `ordered` (already in fill order) out in `columns` columns, starting at `origin`. */
export function layoutGrid(
  ordered: readonly GridItem[],
  columns: number,
  origin: { x: number; y: number },
  gap: number,
): GridLayout {
  const n = ordered.length
  const cols = clampColumns(columns, n)
  const rows = Math.max(1, Math.ceil(n / cols))
  const cell = gridCell(ordered)
  const heights = rowHeights(ordered, cols)
  const rowTops: number[] = []
  let top = origin.y
  for (const h of heights) {
    rowTops.push(top)
    top += h + gap
  }
  const positions: GridLayout['positions'] = {}
  ordered.forEach((item, i) => {
    const r = Math.floor(i / cols)
    const cellX = origin.x + (i % cols) * (cell.w + gap)
    const cellY = rowTops[r] as number
    const cellH = heights[r] as number
    positions[item.id] = { x: cellX + (cell.w - item.w) / 2, y: cellY + (cellH - item.h) / 2 }
  })
  const width = cols * cell.w + gap * (cols - 1)
  const height = heights.reduce((s, h) => s + h, 0) + gap * (rows - 1)
  return {
    order: ordered.map((i) => i.id),
    columns: cols,
    rows,
    gap,
    positions,
    bounds: { x: origin.x, y: origin.y, w: width, h: height },
  }
}

function shiftLayout(layout: GridLayout, dx: number, dy: number): GridLayout {
  if (!dx && !dy) return layout
  const positions: GridLayout['positions'] = {}
  for (const [id, p] of Object.entries(layout.positions)) positions[id] = { x: p.x + dx, y: p.y + dy }
  return {
    ...layout,
    positions,
    bounds: { ...layout.bounds, x: layout.bounds.x + dx, y: layout.bounds.y + dy },
  }
}

export interface ArrangeInput {
  items: readonly GridItem[]
  /** Explicit column count (the stepper); omitted = automatic. */
  columns?: number
  /** Keep this fill order (re-arranging an arranged grid with another column count). */
  order?: readonly string[]
  /**
   * The frame the grid must stay inside, in its own space: its interior is (0, 0, w, h). Omitted when
   * the grid lives on the page or in a group.
   */
  frame?: { w: number; h: number }
  /** F2-03: the unselected shapes in the same parent, in its space (the grid should not cover them). */
  obstacles?: readonly GridItem[]
}

export interface ArrangeResult extends GridLayout {
  /** The frame size the grid needs when it had to grow (only when `frame` was given). */
  frameSize?: { w: number; h: number }
  /** F2-03: neighbours the grid still covered, moved down below it: new top-left per id. */
  pushed?: Record<string, { x: number; y: number }>
}

const rectsOverlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The obstacles the grid's area (with its gap around it) covers. */
function covered(bounds: Rect, gap: number, obstacles: readonly GridItem[]): GridItem[] {
  const area = { x: bounds.x - gap / 2, y: bounds.y - gap / 2, w: bounds.w + gap, h: bounds.h + gap }
  return obstacles.filter((o) => rectsOverlap(area, o))
}

/**
 * Moves the neighbours a grid covers down below it, keeping their order and spacing: every obstacle
 * below the top of the first covered one, in the grid's columns, moves by the same amount.
 */
function pushBelow(bounds: Rect, gap: number, obstacles: readonly GridItem[]): ArrangeResult['pushed'] {
  const hit = covered(bounds, gap, obstacles)
  if (!hit.length) return undefined
  const top = Math.min(...hit.map((o) => o.y))
  const dy = bounds.y + bounds.h + gap - top
  if (dy <= 0) return undefined
  const band = { x: bounds.x, w: bounds.w }
  const pushed: NonNullable<ArrangeResult['pushed']> = {}
  for (const o of obstacles) {
    const inBand = o.x < band.x + band.w && band.x < o.x + o.w
    if (inBand && o.y >= top - 1e-6) pushed[o.id] = { x: o.x, y: o.y + dy }
  }
  return pushed
}

/** Orders `items` by `order` (ids missing from it go last, in reading order). */
function applyOrder(items: readonly GridItem[], order: readonly string[] | undefined): GridItem[] {
  const reading = readingOrder(items)
  if (!order?.length) return reading
  const rank = new Map(order.map((id, i) => [id, i]))
  return reading
    .map((item, i) => ({ item, key: rank.get(item.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.item)
}

export function arrangeAsGrid(input: ArrangeInput): ArrangeResult | null {
  const { items } = input
  if (items.length < 2) return null
  const ordered = applyOrder(items, input.order)
  const gap = gridGap(items)
  const origin = {
    x: items.reduce((m, i) => Math.min(m, i.x), Number.POSITIVE_INFINITY),
    y: items.reduce((m, i) => Math.min(m, i.y), Number.POSITIVE_INFINITY),
  }
  const explicit = input.columns !== undefined
  let columns = explicit ? clampColumns(input.columns as number, items.length) : autoColumns(items, gap)
  const frame = input.frame
  // Shapes the selection already overlapped (a zone drawn behind notes, a card among photos) are not
  // neighbours it grows over: only those clear of its old footprint count.
  const footprint = {
    x: origin.x,
    y: origin.y,
    w: items.reduce((m, i) => Math.max(m, i.x + i.w), Number.NEGATIVE_INFINITY) - origin.x,
    h: items.reduce((m, i) => Math.max(m, i.y + i.h), Number.NEGATIVE_INFINITY) - origin.y,
  }
  const obstacles = (input.obstacles ?? []).filter((o) => !rectsOverlap(footprint, o))
  if (!frame) {
    if (!explicit && obstacles.length) {
      // F2-03: the automatic count closest to the near-square one that covers no neighbour.
      const clear = (c: number) =>
        covered(layoutGrid(ordered, c, origin, gap).bounds, gap, obstacles).length === 0
      if (!clear(columns)) {
        // Within half to twice the near-square count: a single long row is no tidier than an overlap.
        const lo = Math.max(1, Math.floor(columns / 2))
        const hi = Math.min(items.length, columns * 2)
        for (let d = 1; columns + d <= hi || columns - d >= lo; d++) {
          const c = [columns + d, columns - d].find((k) => k >= lo && k <= hi && clear(k))
          if (c !== undefined) {
            columns = c
            break
          }
        }
      }
    }
    const layout = layoutGrid(ordered, columns, origin, gap)
    const pushed = pushBelow(layout.bounds, gap, obstacles)
    return pushed ? { ...layout, pushed } : layout
  }

  const pad = gap
  const fits = (s: { w: number; h: number }) => s.w <= frame.w - 2 * pad && s.h <= frame.h - 2 * pad
  if (!explicit && !fits(gridSize(ordered, columns, gap))) {
    // Prefer an automatic column count that fits the frame, closest to the near-square one.
    for (let d = 1; d < items.length; d++) {
      const c = [columns - d, columns + d].find(
        (k) => k >= 1 && k <= items.length && fits(gridSize(ordered, k, gap)),
      )
      if (c !== undefined) {
        columns = c
        break
      }
    }
  }
  let layout = layoutGrid(ordered, columns, origin, gap)
  // Shift it inside the frame (keeping it where it was when it already fits there).
  const maxX = Math.max(pad, frame.w - pad - layout.bounds.w)
  const maxY = Math.max(pad, frame.h - pad - layout.bounds.h)
  const x = Math.min(Math.max(layout.bounds.x, pad), maxX)
  const y = Math.min(Math.max(layout.bounds.y, pad), maxY)
  layout = shiftLayout(layout, x - layout.bounds.x, y - layout.bounds.y)
  const needW = layout.bounds.x + layout.bounds.w + pad
  const needH = layout.bounds.y + layout.bounds.h + pad
  if (needW > frame.w + 1e-6 || needH > frame.h + 1e-6) {
    return { ...layout, frameSize: { w: Math.max(frame.w, needW), h: Math.max(frame.h, needH) } }
  }
  return layout
}
