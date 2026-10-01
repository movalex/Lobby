// Bulk paste (COL-05): multi-line / TSV / CSV text asks "Paste as sticky notes or as text?".
// Pure decision + layout; the canvas wiring is ported/navigation/bulk-paste.tsx (handler + prompt).
//
// RETRO-01 layout: a spreadsheet COLUMN (or row) of more than 3 cells becomes a compact grid of
// ceil(sqrt(n)) columns in source order instead of one tall strip; true 2-D selections keep their
// rows and columns. The grid is centred on the paste point (the pointer), then moved to the nearest
// empty spot: inside the frame under the paste point when it fits there (clear of that frame's
// children), else on the page (clear of the page's shapes).

import { DEFAULT_MAX_NOTES, DEFAULT_NOTE_GAP, NOTE_SIZE, parseBulkText } from '@draftroom/board-ops/elements'
import { findEmptySpot, findEmptySpotWithin, type Point, type Rect } from './placement.ts'

export interface PasteSourceLike {
  type: string
  subtype?: string
  data?: unknown
}

/**
 * The plain text to split. Spreadsheet copies carry HTML (a table) plus text/plain (TSV); a paste
 * pipeline may hand the handler `text` = the HTML stripped of tags (no tabs), so prefer the plain
 * text source when there is one.
 */
export function pickPlainText(content: { text: string; sources?: readonly PasteSourceLike[] }): string {
  const plain = content.sources?.find((s) => s.type === 'text' && s.subtype === 'text')
  return typeof plain?.data === 'string' && plain.data.trim() ? plain.data : content.text
}

export interface BulkPasteAnalysis {
  /** Non-empty cells (= notes that "Paste as notes" would try to create, before the cap). */
  cells: number
  rows: number
}

/**
 * Null when this paste is not a bulk paste (one cell or less: single-line text, a URL, a sentence
 * with commas): the caller then leaves the paste to the canvas's default text/URL handling.
 */
export function analyzeBulkPaste(text: string): BulkPasteAnalysis | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const rows = parseBulkText(text)
  const cells = rows.reduce((n, r) => n + r.length, 0)
  return cells >= 2 ? { cells, rows: rows.length } : null
}

/** Distance between neighbouring notes' origins in a pasted grid. */
export const NOTE_STEP = NOTE_SIZE + DEFAULT_NOTE_GAP

/**
 * RETRO-01: grid positions (origin at 0,0, NOTE_STEP apart) for `positions` when they form a single
 * column or a single row of more than 3 cells: ceil(sqrt(n)) columns, filled row by row in source
 * order. Null for anything else (a 2-D selection keeps its layout).
 */
export function reflowLine(positions: readonly Point[]): Point[] | null {
  const n = positions.length
  if (n <= 3) return null
  const xs = new Set(positions.map((p) => p.x))
  const ys = new Set(positions.map((p) => p.y))
  if (xs.size !== 1 && ys.size !== 1) return null
  const cols = Math.ceil(Math.sqrt(n))
  return positions.map((_, i) => ({ x: (i % cols) * NOTE_STEP, y: Math.floor(i / cols) * NOTE_STEP }))
}

/** Clearance between a pasted grid and a frame's edges / the content already in that frame. */
export const FRAME_MARGIN = 20
export const FRAME_GAP = 40
/** Clearance from the page's shapes when the grid goes on the page. */
export const PAGE_GAP = 80

export interface GridPlacement {
  /** Where the grid's top-left goes (page space). */
  topLeft: Point
  /** The grid lies inside `frame` (parent the notes into it). */
  inFrame: boolean
}

/**
 * RETRO-01: where a pasted grid of `size` goes. With a `frame` under the paste point that can hold it:
 * the empty spot nearest `center` inside the frame, clear of `frameObstacles` (that frame's children).
 * Otherwise (no frame, or no room in it): the empty spot nearest `center` on the page, clear of
 * `pageObstacles`. Never overlaps an obstacle.
 */
export function placeBulkGrid(opts: {
  size: { w: number; h: number }
  center: Point
  frame?: Rect | null
  frameObstacles?: readonly Rect[]
  pageObstacles: readonly Rect[]
}): GridPlacement {
  const { size, center, frame } = opts
  if (frame) {
    const inner = {
      x: frame.x + FRAME_MARGIN,
      y: frame.y + FRAME_MARGIN,
      w: frame.w - FRAME_MARGIN * 2,
      h: frame.h - FRAME_MARGIN * 2,
    }
    if (size.w <= inner.w && size.h <= inner.h) {
      const spot = findEmptySpotWithin(size, center, opts.frameObstacles ?? [], inner, { gap: FRAME_GAP })
      if (spot) return { topLeft: spot, inFrame: true }
    }
  }
  return { topLeft: findEmptySpot(size, center, opts.pageObstacles, { gap: PAGE_GAP }), inFrame: false }
}

/** The notice shown after a capped paste (the checklist wants "how many were left out"). */
export function truncationMessage(
  created: number,
  omitted: number,
  textShortened: boolean,
  cap: number = DEFAULT_MAX_NOTES,
): string | null {
  if (omitted > 0) {
    return `Pasted the first ${created} notes. ${omitted} more ${omitted === 1 ? 'cell was' : 'cells were'} left out (limit: ${cap} notes per paste).`
  }
  if (textShortened) return 'Some very long cells were shortened to fit a note.'
  return null
}
