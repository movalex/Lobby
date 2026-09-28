// "Arrange as grid" (MAK-18): pure layout for a multi-selection, in the coordinate space of the parent
// the grid lives in (the page, or the frame / group every item shares). No editor here; the wiring is
// arrange-grid-runtime.ts.
//
// Rules:
//  - Reading order is kept: items are grouped into visual rows (top to bottom), each row read left to
//    right; the grid is filled row by row in that order.
//  - Column count: near-square overall (ceil(sqrt(n × cellH / cellW)) from the median item size), then
//    balanced so the last row is as full as it can be. An explicit count (the stepper) wins.
//  - Cells: every column is as wide as its widest item, every row as tall as its tallest; items sit at
//    their cell's top-left, so row tops and column left edges line up. One even gap everywhere:
//    max(20, 10% of the median item's shorter side), at most 200 (notes: 20, like bulk paste).
//  - The grid starts at the selection's top-left, so the arranged block stays where it was.
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

/** The automatic column count: a near-square grid, balanced so no row is much emptier than needed. */
export function autoColumns(items: readonly GridItem[], gap = gridGap(items)): number {
  const n = items.length
  if (n <= 1) return 1
  const cw = median(items.map((i) => i.w)) + gap
  const ch = median(items.map((i) => i.h)) + gap
  const raw = Math.ceil(Math.sqrt((n * ch) / Math.max(cw, 1e-6)) - 1e-9)
  const cols = Math.min(n, Math.max(1, raw))
  const rows = Math.ceil(n / cols)
  return Math.ceil(n / rows)
}

export function clampColumns(columns: number, n: number): number {
  if (!Number.isFinite(columns)) return 1
  return Math.min(Math.max(1, Math.round(columns)), Math.max(1, n))
}

/** Column widths and row heights of `ordered` in `cols` columns (widest / tallest item of each). */
function tracks(ordered: readonly GridItem[], cols: number): { colW: number[]; rowH: number[] } {
  const rows = Math.max(1, Math.ceil(ordered.length / cols))
  const colW = new Array<number>(cols).fill(0)
  const rowH = new Array<number>(rows).fill(0)
  ordered.forEach((item, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    colW[c] = Math.max(colW[c] as number, item.w)
    rowH[r] = Math.max(rowH[r] as number, item.h)
  })
  return { colW, rowH }
}

/** The grid's size only (no positions): cheap enough to try every column count. */
function gridSize(ordered: readonly GridItem[], columns: number, gap: number): { w: number; h: number } {
  const cols = clampColumns(columns, ordered.length)
  const { colW, rowH } = tracks(ordered, cols)
  return {
    w: colW.reduce((s, w) => s + w, 0) + gap * (colW.length - 1),
    h: rowH.reduce((s, h) => s + h, 0) + gap * (rowH.length - 1),
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
  const { colW, rowH } = tracks(ordered, cols)
  const colX: number[] = []
  let x = origin.x
  for (const w of colW) {
    colX.push(x)
    x += w + gap
  }
  const rowY: number[] = []
  let y = origin.y
  for (const h of rowH) {
    rowY.push(y)
    y += h + gap
  }
  const positions: GridLayout['positions'] = {}
  ordered.forEach((item, i) => {
    positions[item.id] = { x: colX[i % cols] as number, y: rowY[Math.floor(i / cols)] as number }
  })
  const width = colW.reduce((s, w) => s + w, 0) + gap * (cols - 1)
  const height = rowH.reduce((s, h) => s + h, 0) + gap * (rows - 1)
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
}

export interface ArrangeResult extends GridLayout {
  /** The frame size the grid needs when it had to grow (only when `frame` was given). */
  frameSize?: { w: number; h: number }
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
  if (!frame) return layoutGrid(ordered, columns, origin, gap)

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
