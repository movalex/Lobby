// Bulk paste (COL-05): multi-line / TSV / CSV text asks "Paste as sticky notes or as text?".
// Pure decision + layout; the editor wiring is bulk-paste-handler.ts (handler) + Overlay.tsx (prompt).

import type { TLPageId, TLShape } from 'tldraw'
import { DEFAULT_MAX_NOTES, NOTE_SIZE, notesFromText, parseBulkText } from './deps.ts'
import { offsetToCenter, type Point, type Rect, unionRects } from './placement.ts'

export interface PasteSourceLike {
  type: string
  subtype?: string
  data?: unknown
}

/**
 * The plain text to split. Spreadsheet copies carry HTML (a table) plus text/plain (TSV); tldraw's
 * paste pipeline hands the handler `text` = the HTML stripped of tags (no tabs), so prefer the plain
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
 * with commas): the caller then leaves the paste to tldraw's default text/URL handling.
 */
export function analyzeBulkPaste(text: string): BulkPasteAnalysis | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const rows = parseBulkText(text)
  const cells = rows.reduce((n, r) => n + r.length, 0)
  return cells >= 2 ? { cells, rows: rows.length } : null
}

export interface BulkNotesResult {
  /** Note shapes (page children, no index: the editor stacks them on top). */
  shapes: TLShape[]
  /** Page-space bounds of the grid (note height grows with long text after render). */
  bounds: Rect
  /** Cells left out by the cap (plus a flag when long cells were shortened). */
  omitted: number
  textShortened: boolean
}

export function buildBulkNotes(
  text: string,
  opts: { center: Point; pageId: string; color?: string; maxNotes?: number },
): BulkNotesResult {
  const maxNotes = opts.maxNotes ?? DEFAULT_MAX_NOTES
  const { shapes, truncated } = notesFromText(text, {
    origin: { x: 0, y: 0 },
    pageId: opts.pageId as TLPageId,
    color: opts.color,
    maxNotes,
  })
  const grid = unionRects(shapes.map((s) => ({ x: s.x, y: s.y, w: NOTE_SIZE, h: NOTE_SIZE }))) ?? {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  }
  const d = offsetToCenter(grid, opts.center)
  const moved = shapes.map((s) => {
    const { index: _index, ...rest } = s
    return { ...rest, x: s.x + d.x, y: s.y + d.y } as TLShape
  })
  const total = analyzeBulkPaste(text)?.cells ?? shapes.length
  const omitted = Math.max(0, total - shapes.length)
  return {
    shapes: moved,
    bounds: { x: grid.x + d.x, y: grid.y + d.y, w: grid.w, h: grid.h },
    omitted,
    textShortened: truncated && omitted === 0,
  }
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
