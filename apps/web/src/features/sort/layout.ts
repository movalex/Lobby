// L8-1 and L8-2: the two layouts of the sort feature. Pure: plain rectangles in, plain positions out, all in
// one space (a frame's, or the page's); ./plan.ts reads the canvas and ./apply.ts writes the result.
//
// layoutColumns is the theme cluster layout (../ai/layout.ts layoutThemes, imported and not edited) asked for
// columns: each group is a heading over its notes, one note wide when it can be (a group of more than
// COLUMN_ROWS notes wraps into a second sub-column), the columns side by side from where the notes were,
// clear of everything that stays (the obstacles), inside the room it is given. The first arrangement that fits
// without growing the room wins, in this order: true columns, then wider clusters, then the layout's own
// choice; when none fits, the one that reaches least past the room (a frame grows by that much and no more).
//
// layoutMatrix puts scored notes on a 2x2: a note goes to the quadrant its two scores name (positive is the
// "high" end of its axis; zero counts as low) and, inside it, to the free cell on a grid nearest to where its
// scores say it belongs (the further from the matrix's middle, the more extreme the score). Two notes never
// share a cell and no note overlaps an obstacle, so the output cannot overlap or leave its quadrant; ties go
// to the lower row, then the lower column, and notes are placed most extreme first, then by id, so the same
// input always gives the same output.

import {
  alignRows,
  type ClusterInput,
  collides,
  layoutThemes,
  type Rect,
  type ThemesLayoutInput,
} from '../ai/layout.ts'

export type { Rect }

// ---- columns -------------------------------------------------------------------------------------------------

/** A group of more than this many notes wraps into a second sub-column (its heading stays one). */
export const COLUMN_ROWS = 6

export interface ColumnsGroup {
  readonly key: string
  readonly notes: readonly { readonly id: string; readonly w: number; readonly h: number }[]
}

export interface ColumnsInput {
  readonly groups: readonly ColumnsGroup[]
  /**
   * The height of group `index`'s heading when it is `w` wide (the caller measures real text; a test passes a
   * formula). It includes the heading's own padding.
   */
  labelH(index: number, w: number): number
  /** Where the notes were: the top-left of their bounds. The columns start here. */
  readonly anchor: { readonly x: number; readonly y: number }
  /** The room: across from minX to maxX; down to maxY (a frame's floor) or without one (null: open canvas). */
  readonly region: { readonly minX: number; readonly maxX: number; readonly maxY: number | null }
  /** Everything that stays where it is. */
  readonly obstacles: readonly Rect[]
}

export interface PlacedColumn {
  /** the group's key */
  readonly key: string
  /** the group's index in `ColumnsInput.groups` */
  readonly index: number
  /** the heading's box */
  readonly label: Rect
  readonly notes: readonly { readonly id: string; readonly x: number; readonly y: number }[]
  /** the heading and its notes */
  readonly box: Rect
  /** how many notes wide the column is (1: a true column) */
  readonly cols: number
}

export interface ColumnsLayout {
  readonly columns: readonly PlacedColumn[]
  readonly bounds: Rect
  /** how far the result reaches past the room (0 when it fits) */
  readonly overflow: { readonly right: number; readonly bottom: number }
  readonly gap: number
}

const EMPTY_BOUNDS: Rect = { x: 0, y: 0, w: 0, h: 0 }

/** Per-group column counts to try, most column-like first (see the header). */
function candidateCols(groups: readonly ColumnsGroup[]): number[][] {
  const out = new Map<string, number[]>()
  const add = (cols: number[]) => out.set(cols.join(','), cols)
  for (const base of [1, 2, 3, 4])
    add(groups.map((g) => Math.min(g.notes.length, Math.max(base, Math.ceil(g.notes.length / COLUMN_ROWS)))))
  return [...out.values()]
}

const overflowOf = (l: { overflow: { right: number; bottom: number } }) =>
  l.overflow.right + l.overflow.bottom

export function layoutColumns(input: ColumnsInput): ColumnsLayout {
  const groups = input.groups.filter((g) => g.notes.length > 0)
  if (!groups.length) {
    return {
      columns: [],
      bounds: { ...EMPTY_BOUNDS, x: input.anchor.x, y: input.anchor.y },
      overflow: { right: 0, bottom: 0 },
      gap: 0,
    }
  }
  const clusters = (labelH: (i: number) => (w: number) => number): ClusterInput[] =>
    groups.map((g, i) => ({
      key: String(i),
      notes: g.notes.map((n) => ({ id: n.id, w: n.w, h: n.h })),
      labelH: labelH(i),
    }))
  const first: ThemesLayoutInput = {
    clusters: clusters(() => (w) => Math.max(...groups.map((_, i) => input.labelH(i, w)))),
    anchor: input.anchor,
    region: input.region,
    obstacles: input.obstacles,
  }
  // the first arrangement in the order of preference that needs no more room than there is
  let pick: { cols: number[] | null; layout: ReturnType<typeof layoutThemes> } | null = null
  for (const cols of candidateCols(groups)) {
    const layout = layoutThemes(first, { cols })
    if (!pick || overflowOf(layout) < overflowOf(pick.layout) - 0.001) pick = { cols, layout }
    if (overflowOf(layout) <= 0) break
  }
  if (pick && overflowOf(pick.layout) > 0) {
    // nothing fitted as columns: the layout's own choice may fit (it tries squarer clusters)
    const own = layoutThemes(first)
    if (overflowOf(own) < overflowOf(pick.layout) - 0.001) pick = { cols: null, layout: own }
  }
  const chosen = (pick as NonNullable<typeof pick>).layout
  // the headings as they will be (measured at their column's width), then once more with the tallest one's
  // true height, and one line for the headings of columns side by side
  const band = Math.max(1, ...chosen.clusters.map((c) => input.labelH(Number(c.key), c.label.w)))
  const final: ThemesLayoutInput = { ...first, clusters: clusters(() => () => band) }
  const layout = alignRows(
    layoutThemes(final, { cols: chosen.clusters.map((c) => c.cols), gap: chosen.gap }),
    final,
  )
  const columns: PlacedColumn[] = layout.clusters
    .map((c) => {
      const index = Number(c.key)
      return {
        key: groups[index]?.key ?? c.key,
        index,
        label: c.label,
        notes: c.notes,
        box: c.box,
        cols: c.cols,
      }
    })
    .sort((a, b) => a.index - b.index)
  return { columns, bounds: layout.bounds, overflow: layout.overflow, gap: layout.gap }
}

// ---- the 2x2 ----------------------------------------------------------------------------------------------------

/** `<x end>-<y end>`: where a note lands, by the end of each axis its score is on (zero counts as low). */
export type QuadrantKey = 'low-low' | 'high-low' | 'low-high' | 'high-high'
export const QUADRANT_KEYS: readonly QuadrantKey[] = ['low-high', 'high-high', 'low-low', 'high-low']

export const quadrantOf = (x: number, y: number): QuadrantKey =>
  `${x > 0 ? 'high' : 'low'}-${y > 0 ? 'high' : 'low'}` as QuadrantKey

/** Between two notes on the matrix's grid. */
export const MATRIX_GAP = 16

export interface MatrixNote {
  readonly id: string
  readonly w: number
  readonly h: number
  /** the score on the first axis (-5 to 5; positive is the axis's high end) */
  readonly x: number
  /** the score on the second axis (-5 to 5; positive is its high end) */
  readonly y: number
}

export interface MatrixInput {
  /** The four areas notes may land in (the room inside each quadrant), in one space. */
  readonly quadrants: Readonly<Record<QuadrantKey, Rect>>
  readonly notes: readonly MatrixNote[]
  /** Things that stay inside the quadrants (a template's example notes). */
  readonly obstacles?: readonly Rect[]
  readonly gap?: number
}

export interface MatrixPlacement {
  readonly id: string
  readonly quadrant: QuadrantKey
  /** the note's new top-left */
  readonly x: number
  readonly y: number
}

export interface MatrixLayout {
  readonly placed: readonly MatrixPlacement[]
  /** notes whose quadrant has no free cell left, in the order they were tried */
  readonly unplaced: readonly { readonly id: string; readonly quadrant: QuadrantKey }[]
  /** per quadrant: the height its area would need to hold every note it was given (it grows by the difference) */
  readonly heightNeeded: Readonly<Record<QuadrantKey, number>>
}

/** How far out a score reaches, 0 (the matrix's middle) to 1 (the outer edge): 1 is near, 5 is the edge. */
export const reach = (score: number): number => Math.min(1, Math.max(0, (Math.abs(score) - 0.5) / 4.5))

interface Cell {
  col: number
  row: number
  x: number
  y: number
  cx: number
  cy: number
}

/** Cells that fit in `span` when each takes `size` and they are `gap` apart (at least one). */
const fitCount = (span: number, size: number, gap: number) =>
  Math.max(1, Math.floor((span + gap) / (size + gap)))

export function layoutMatrix(input: MatrixInput): MatrixLayout {
  const gap = input.gap ?? MATRIX_GAP
  const obstacles = input.obstacles ?? []
  const quads = input.quadrants
  const middle = {
    x: QUADRANT_KEYS.reduce((s, k) => s + quads[k].x + quads[k].w / 2, 0) / QUADRANT_KEYS.length,
    y: QUADRANT_KEYS.reduce((s, k) => s + quads[k].y + quads[k].h / 2, 0) / QUADRANT_KEYS.length,
  }
  const placed: MatrixPlacement[] = []
  const unplaced: { id: string; quadrant: QuadrantKey }[] = []
  const heightNeeded = {} as Record<QuadrantKey, number>
  for (const key of QUADRANT_KEYS) {
    const area = quads[key]
    const mine = input.notes.filter((n) => quadrantOf(n.x, n.y) === key)
    const cw = Math.max(1, ...mine.map((n) => n.w))
    const ch = Math.max(1, ...mine.map((n) => n.h))
    const cols = fitCount(area.w, cw, gap)
    const rows = fitCount(area.h, ch, gap)
    heightNeeded[key] = mine.length
      ? Math.ceil(mine.length / cols) * ch + (Math.ceil(mine.length / cols) - 1) * gap
      : 0
    // the grid is centred in the area
    const gridW = cols * cw + (cols - 1) * gap
    const gridH = rows * ch + (rows - 1) * gap
    const ox = area.x + (area.w - gridW) / 2
    const oy = area.y + (area.h - gridH) / 2
    const free: Cell[] = []
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++) {
        const x = ox + col * (cw + gap)
        const y = oy + row * (ch + gap)
        const cell = { x, y, w: cw, h: ch }
        if (obstacles.some((o) => collides(cell, o, gap / 2 - 0.01))) continue
        free.push({ col, row, x, y, cx: x + cw / 2, cy: y + ch / 2 })
      }
    // away from the matrix's middle: +1 to the right of / below it, -1 to the left of / above it
    const awayX = Math.sign(area.x + area.w / 2 - middle.x) || 1
    const awayY = Math.sign(area.y + area.h / 2 - middle.y) || 1
    const order = [...mine].sort(
      (a, b) => Math.abs(b.x) + Math.abs(b.y) - (Math.abs(a.x) + Math.abs(a.y)) || (a.id < b.id ? -1 : 1),
    )
    // note centres range over the area less half a cell on every side
    const near = {
      x: awayX > 0 ? area.x + cw / 2 : area.x + area.w - cw / 2,
      y: awayY > 0 ? area.y + ch / 2 : area.y + area.h - ch / 2,
    }
    const far = {
      x: awayX > 0 ? area.x + area.w - cw / 2 : area.x + cw / 2,
      y: awayY > 0 ? area.y + area.h - ch / 2 : area.y + ch / 2,
    }
    for (const n of order) {
      const ideal = {
        x: near.x + (far.x - near.x) * reach(n.x),
        y: near.y + (far.y - near.y) * reach(n.y),
      }
      let best = -1
      let bestD = Number.POSITIVE_INFINITY
      free.forEach((c, i) => {
        const d = (c.cx - ideal.x) ** 2 + (c.cy - ideal.y) ** 2
        const better =
          d < bestD - 1e-9 ||
          (Math.abs(d - bestD) <= 1e-9 &&
            best >= 0 &&
            (c.row < (free[best] as Cell).row ||
              (c.row === (free[best] as Cell).row && c.col < (free[best] as Cell).col)))
        if (better) {
          best = i
          bestD = d
        }
      })
      const cell = free[best]
      if (!cell) {
        unplaced.push({ id: n.id, quadrant: key })
        continue
      }
      free.splice(best, 1)
      // a note smaller than the cell sits in its middle
      placed.push({ id: n.id, quadrant: key, x: cell.cx - n.w / 2, y: cell.cy - n.h / 2 })
    }
  }
  return { placed, unplaced, heightNeeded }
}

/**
 * The size of a matrix frame this feature makes: each quadrant holds the busiest quadrant's notes on a grid
 * of cells `cell` big, `cols` wide, with room round them; the frame adds a band for the axis labels.
 */
export function matrixFrameSize(
  busiest: number,
  cell: { w: number; h: number },
  gap = MATRIX_GAP,
): { quadW: number; quadH: number; cols: number; rows: number } {
  const n = Math.max(1, busiest)
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(n))))
  const rows = Math.max(2, Math.ceil(n / cols))
  return {
    cols,
    rows,
    quadW: cols * cell.w + (cols + 1) * gap,
    quadH: rows * cell.h + (rows + 1) * gap,
  }
}

/** Whether two rectangles overlap (touching does not count). */
export const overlaps = (a: Rect, b: Rect): boolean => collides(a, b, 0)
