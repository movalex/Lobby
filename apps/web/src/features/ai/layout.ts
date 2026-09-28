// Layout math for AI results (docs/WAVE4-CONTRACTS.md §4 ai-assist). Pure: plain rectangles in, plain
// positions out, all in one parent's space (a frame's, or the page's). apply.ts measures the shapes and
// writes the result.
//
// "Group into themes" turns sticky notes into labelled clusters: each cluster is a label over a small
// grid of its notes. Clusters are packed bottom-left (each goes to the highest, then leftmost, free spot)
// into the room to the right of and below where the notes were, never over anything that stays (the
// frame's heading, other shapes, connectors) and never over each other. Several arrangements are tried
// (how many columns each cluster gets, how far apart clusters sit); the one that fits the frame without
// growing it, and then the most compact one, wins. If nothing fits, the frame grows as little as needed.
//
// New results (a summary, a set of notes) stay in the frame the target is (or is in): beside the
// selection when there is room there, else under the frame's content, aligned with its left edge, the
// frame growing downwards to take them (appendInFrame). Outside frames they go beside the selection:
// the first free spot to its right, below, left or above, sliding along each side, never over a frame's
// name label (FRAME_LABEL_BAND).

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

/** Between notes of one cluster. */
export const NOTE_GAP = 16
/** Between a cluster's label and its first row of notes. */
export const LABEL_GAP = 14
/** Clusters apart, tried in this order of preference (more air reads better). */
export const CLUSTER_GAPS = [64, 48, 32] as const
/** Around shapes that stay where they are. */
export const CLEARANCE = 28
/** Keep this far inside a frame's edges. */
export const FRAME_MARGIN = 40
/** Obstacles considered at most (the nearest to the anchor). */
const MAX_OBSTACLES = 160

export const right = (r: Rect) => r.x + r.w
export const bottom = (r: Rect) => r.y + r.h

/** Rectangles closer than `margin` count as touching. */
export function collides(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < right(b) + margin && b.x < right(a) + margin && a.y < bottom(b) + margin && b.y < bottom(a) + margin
  )
}

export function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, right(r))
    y1 = Math.max(y1, bottom(r))
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---- Group into themes ---------------------------------------------------------------------------------

export interface ClusterNote {
  id: string
  w: number
  h: number
}

export interface ClusterInput {
  key: string
  notes: ClusterNote[]
  /** The label's height when it is `w` wide (apply.ts measures real text; tests pass a formula). */
  labelH(w: number): number
}

export interface ThemesLayoutInput {
  clusters: ClusterInput[]
  /** Where the notes were: the top-left of their bounds. Clusters start here. */
  anchor: { x: number; y: number }
  /**
   * The room: from minX to maxX across; down to maxY (a frame's inner bottom) or without a floor
   * (maxY null: the open canvas, where maxX is a width budget rather than a wall).
   */
  region: { minX: number; maxX: number; maxY: number | null }
  /** Everything that stays where it is, in the same space. */
  obstacles: readonly Rect[]
}

export interface ClusterPlacement {
  key: string
  label: Rect
  notes: { id: string; x: number; y: number }[]
  box: Rect
  cols: number
}

export interface ThemesLayout {
  clusters: ClusterPlacement[]
  bounds: Rect
  /** How far the result reaches past the region (0 when it fits). */
  overflow: { right: number; bottom: number }
  gap: number
}

interface Block {
  key: string
  cols: number
  w: number
  h: number
  labelH: number
  cellW: number
  rowHeights: number[]
  notes: ClusterNote[]
}

function block(c: ClusterInput, colsWanted: number): Block {
  const n = c.notes.length
  const cols = Math.max(1, Math.min(colsWanted, n))
  const cellW = Math.max(...c.notes.map((m) => m.w))
  const rows = Math.ceil(n / cols)
  const rowHeights: number[] = []
  for (let r = 0; r < rows; r++)
    rowHeights.push(Math.max(...c.notes.slice(r * cols, r * cols + cols).map((m) => m.h)))
  const w = cols * cellW + (cols - 1) * NOTE_GAP
  const labelH = Math.max(1, c.labelH(w))
  const h = labelH + LABEL_GAP + rowHeights.reduce((a, b) => a + b, 0) + (rows - 1) * NOTE_GAP
  return { key: c.key, cols, w, h, labelH, cellW, rowHeights, notes: c.notes }
}

/** Column choices per cluster to try: uniform counts, square-ish, and row-capped. */
function strategies(clusters: readonly ClusterInput[]): number[][] {
  const out = new Map<string, number[]>()
  const add = (cols: number[]) => out.set(cols.join(','), cols)
  for (const c of [1, 2, 3, 4]) add(clusters.map((k) => Math.min(c, k.notes.length)))
  add(clusters.map((k) => Math.ceil(Math.sqrt(k.notes.length))))
  for (const rows of [2, 3]) add(clusters.map((k) => Math.ceil(k.notes.length / rows)))
  return [...out.values()]
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b)
}

/** Bottom-left packing of `blocks` in the region, around `obstacles`. */
function pack(blocks: readonly Block[], input: ThemesLayoutInput, gap: number): Rect[] {
  const { region, anchor, obstacles } = input
  const placed: Rect[] = []
  for (const b of blocks) {
    const others = [...placed, ...obstacles]
    const xs = uniqueSorted([
      region.minX,
      ...placed.map((r) => right(r) + gap),
      ...obstacles.map((r) => right(r) + CLEARANCE),
    ]).filter((x) => x >= region.minX && x + b.w <= region.maxX)
    const ys = uniqueSorted([
      anchor.y,
      ...placed.map((r) => bottom(r) + gap),
      ...obstacles.map((r) => bottom(r) + CLEARANCE),
    ]).filter((y) => y >= anchor.y)
    let spot: Rect | null = null
    for (const y of ys) {
      for (const x of xs) {
        const r = { x, y, w: b.w, h: b.h }
        const free =
          placed.every((p) => !collides(r, p, gap - 0.01)) &&
          obstacles.every((o) => !collides(r, o, CLEARANCE - 0.01))
        if (free) {
          spot = r
          break
        }
      }
      if (spot) break
    }
    if (!spot) {
      // Nowhere in the room: below everything, at the left edge.
      const floor = Math.max(anchor.y, ...others.map((r) => bottom(r) + gap))
      spot = { x: region.minX, y: floor, w: b.w, h: b.h }
    }
    placed.push(spot)
  }
  return placed
}

function place(b: Block, box: Rect): ClusterPlacement {
  const notes: ClusterPlacement['notes'] = []
  let y = box.y + b.labelH + LABEL_GAP
  b.rowHeights.forEach((rowH, r) => {
    for (let c = 0; c < b.cols; c++) {
      const note = b.notes[r * b.cols + c]
      if (!note) break
      notes.push({ id: note.id, x: box.x + c * (b.cellW + NOTE_GAP), y })
    }
    y += rowH + NOTE_GAP
  })
  return { key: b.key, label: { x: box.x, y: box.y, w: b.w, h: b.labelH }, notes, box, cols: b.cols }
}

function nearest(obstacles: readonly Rect[], anchor: { x: number; y: number }): readonly Rect[] {
  if (obstacles.length <= MAX_OBSTACLES) return obstacles
  const d = (r: Rect) => Math.hypot(Math.max(0, r.x - anchor.x), Math.max(0, r.y - anchor.y))
  return [...obstacles].sort((a, b) => d(a) - d(b)).slice(0, MAX_OBSTACLES)
}

/** Lays out every cluster, choosing the arrangement that fits best (see the header). */
export function layoutThemes(
  input: ThemesLayoutInput,
  opts: { cols?: number[]; gap?: number } = {},
): ThemesLayout {
  const clusters = input.clusters.filter((c) => c.notes.length > 0)
  const fixed = { ...input, obstacles: nearest(input.obstacles, input.anchor) }
  // A region narrower than the widest one-column cluster still takes it (overflowing on the right).
  let best: { layout: ThemesLayout; score: number } | null = null
  const colsChoices = opts.cols ? [opts.cols] : strategies(clusters)
  const gaps = opts.gap !== undefined ? [opts.gap] : CLUSTER_GAPS
  for (const cols of colsChoices) {
    const blocks = clusters.map((c, i) => block(c, cols[i] ?? 1))
    for (const gap of gaps) {
      const rects = pack(blocks, fixed, gap)
      const placed = blocks.map((b, i) => place(b, rects[i] as Rect))
      const bounds = union(rects) ?? { x: input.anchor.x, y: input.anchor.y, w: 0, h: 0 }
      const overflow = {
        right: Math.max(0, right(bounds) - input.region.maxX),
        bottom: input.region.maxY === null ? 0 : Math.max(0, bottom(bounds) - input.region.maxY),
      }
      const score =
        (overflow.right + overflow.bottom) * 100 +
        (bottom(bounds) - input.anchor.y) +
        (right(bounds) - input.anchor.x) * 0.5 +
        (CLUSTER_GAPS[0] - gap) * 4
      if (!best || score < best.score - 0.001)
        best = { layout: { clusters: placed, bounds, overflow, gap }, score }
    }
  }
  return (
    best?.layout ?? {
      clusters: [],
      bounds: { x: input.anchor.x, y: input.anchor.y, w: 0, h: 0 },
      overflow: { right: 0, bottom: 0 },
      gap: CLUSTER_GAPS[0],
    }
  )
}

/**
 * The room "Group into themes" gets inside a frame of `frame` size: to the right of and below the
 * notes' old top-left, inside the frame's margins. A region too narrow for the widest cluster reaches
 * further left, never past the margin.
 */
export function frameRegion(
  frame: Size,
  anchor: { x: number; y: number },
  widest: number,
): ThemesLayoutInput['region'] {
  const maxX = frame.w - FRAME_MARGIN
  let minX = Math.max(FRAME_MARGIN, anchor.x)
  if (maxX - minX < widest) minX = Math.max(FRAME_MARGIN, maxX - widest)
  return { minX, maxX, maxY: frame.h - FRAME_MARGIN }
}

/** On the open canvas: about as wide as the notes were, and at least a roughly square arrangement. */
export function openRegion(
  anchor: { x: number; y: number },
  notesBounds: Rect,
  areaOfNotes: number,
  widest: number,
) {
  const budget = Math.max(notesBounds.w, widest, Math.sqrt(areaOfNotes) * 1.8)
  return { minX: anchor.x, maxX: anchor.x + budget, maxY: null }
}

// ---- new results beside the selection --------------------------------------------------------------

/** Between the selection and what AI adds next to it. */
export const BESIDE_GAP = 48
const SLIDE_STEP = 40
const SLIDES = 30
const RINGS = 6

export type Side = 'right' | 'below' | 'left' | 'above'
const ALL_SIDES: readonly Side[] = ['right', 'below', 'left', 'above']

/**
 * The first free spot for a `size` block beside `anchor`: right, below, left, above (or only `sides`),
 * each sliding along that side, then further out. Inside `region` when given (a frame's inner box);
 * null when no spot is free there.
 */
export function placeBeside(
  size: Size,
  anchor: Rect,
  obstacles: readonly Rect[],
  region: Rect | null,
  sides: readonly Side[] = ALL_SIDES,
): { x: number; y: number } | null {
  const fits = (r: Rect) =>
    (!region ||
      (r.x >= region.x && r.y >= region.y && right(r) <= right(region) && bottom(r) <= bottom(region))) &&
    obstacles.every((o) => !collides(r, o, BESIDE_GAP / 2 - 0.01))
  const on = new Set(sides)
  for (let ring = 0; ring < RINGS; ring++) {
    const out = BESIDE_GAP + ring * SLIDE_STEP * 3
    for (let k = 0; k < SLIDES; k++) {
      const s = k * SLIDE_STEP
      const candidates: [Side, Rect][] = [
        ['right', { x: right(anchor) + out, y: anchor.y + s, ...size }],
        ['below', { x: anchor.x + s, y: bottom(anchor) + out, ...size }],
        ['left', { x: anchor.x - out - size.w, y: anchor.y + s, ...size }],
        ['above', { x: anchor.x + s, y: anchor.y - out - size.h, ...size }],
        ['right', { x: right(anchor) + out, y: anchor.y - s, ...size }],
      ]
      for (const [side, c] of candidates) if (on.has(side) && fits(c)) return { x: c.x, y: c.y }
    }
  }
  return null
}

/** Centred on a point when that is free (nothing selected: ideas land in the middle of the view). */
export function placeAround(size: Size, center: { x: number; y: number }, obstacles: readonly Rect[]) {
  const r = { x: center.x - size.w / 2, y: center.y - size.h / 2, ...size }
  if (obstacles.every((o) => !collides(r, o, BESIDE_GAP / 2))) return { x: r.x, y: r.y }
  return placeBeside(size, { x: center.x, y: center.y, w: 0, h: 0 }, obstacles, null) ?? { x: r.x, y: r.y }
}

/** Room kept above a frame for its name label (tldraw draws it just over the frame's top edge). */
export const FRAME_LABEL_BAND = 40

/**
 * Where a `size` block goes at the end of a frame (reviewer finding DANA-07): below everything in it
 * (`content`, in the frame's space), aligned with the content's left edge, BESIDE_GAP clear of it and
 * FRAME_MARGIN inside the frame's sides. `h` is the frame height that holds it: the frame's own when it
 * fits, else taller (frames grow downwards only, so neighbours to the side are never crowded).
 */
export function appendInFrame(
  size: Size,
  frame: Size,
  content: readonly Rect[],
): { x: number; y: number; h: number } {
  const inner = union(content)
  const left = inner ? Math.max(FRAME_MARGIN, inner.x) : FRAME_MARGIN
  const x = Math.max(FRAME_MARGIN, Math.min(left, frame.w - FRAME_MARGIN - size.w))
  const y = inner ? Math.max(FRAME_MARGIN, bottom(inner) + BESIDE_GAP) : FRAME_MARGIN
  return { x, y, h: Math.max(frame.h, Math.ceil(y + size.h + FRAME_MARGIN)) }
}

/** Columns for `n` cells `cellW` wide: `wanted`, or fewer when the grid would be wider than `maxW`. */
export function fitCols(n: number, wanted: number, cellW: number, maxW: number | null, gap = NOTE_GAP) {
  let c = Math.max(1, Math.min(wanted, n))
  while (maxW !== null && c > 1 && c * cellW + (c - 1) * gap > maxW) c--
  return c
}

/** A grid of `n` cells, `cols` wide, relative to its top-left. */
export function grid(n: number, cols: number, cell: Size, gap = NOTE_GAP) {
  const c = Math.max(1, Math.min(cols, n))
  const cells = Array.from({ length: n }, (_, i) => ({
    x: (i % c) * (cell.w + gap),
    y: Math.floor(i / c) * (cell.h + gap),
  }))
  const rows = Math.ceil(n / c)
  return { cells, w: c * cell.w + (c - 1) * gap, h: rows * cell.h + (rows - 1) * gap }
}
