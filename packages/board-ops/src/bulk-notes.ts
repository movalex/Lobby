import {
  createShapeId,
  DefaultColorStyle,
  type TLDefaultColorStyle,
  type TLNoteShape,
  type TLPageId,
  type TLParentId,
  type TLShape,
} from '@tldraw/tlschema'
import { getIndicesAbove, type IndexKey } from '@tldraw/utils'
import { isValidIndexKey, truncateText } from './board-index.ts'
import { richTextFrom } from './rich-text.ts'

/** tldraw note size at scale 1 (NoteShapeUtil display values: noteWidth / noteHeight). */
export const NOTE_SIZE = 200
export const DEFAULT_NOTE_GAP = 20
export const DEFAULT_MAX_NOTES = 500
/** Hard ceiling for `maxNotes`, whatever the caller asks for. */
export const MAX_BULK_NOTES = 5000
/** Pasted text beyond this many characters is ignored (and reported as truncated by `notesFromText`). */
export const MAX_BULK_TEXT_CHARS = 1_000_000
/** Longer cells are cut to this many characters (and reported as truncated by `notesFromText`). */
export const MAX_NOTE_TEXT_CHARS = 5000
/** `parseBulkText` stops after this many non-empty cells. */
const MAX_PARSED_CELLS = 50_000
/** Parsing stops after this many input rows (empty rows included). */
const MAX_PARSED_RECORDS = 200_000

export interface BulkNotesOptions {
  /** Top-left of the grid in the parent's coordinate space (page space unless `parentId` is a frame). */
  origin: { x: number; y: number }
  pageId: TLPageId
  /** Frame (or group) to paste into; defaults to `pageId`. `origin` is then local to that shape. */
  parentId?: TLParentId
  /** A tldraw color style name; unknown values fall back to the note default (`black`, rendered as the classic yellow sticky). */
  color?: string
  /** Default 500, capped at 5000. */
  maxNotes?: number
  /** Space between notes, default 20. */
  gap?: number
  /** Notes get index keys above this one (pass the parent's current top child index to paste on top). */
  indexAbove?: IndexKey
}

interface ParsedGrid {
  /** Trimmed cells in their original column positions ('' = empty cell). */
  rows: string[][]
  /** Input was cut at MAX_BULK_TEXT_CHARS or MAX_PARSED_CELLS. */
  truncated: boolean
}

interface DelimitedParse {
  records: string[][]
  quotedFields: number
  malformed: boolean
  separatorsFollowedBySpace: number
  separators: number
  /** Stopped at MAX_PARSED_RECORDS before the end of the text. */
  cut: boolean
}

/**
 * RFC 4180-style parser for one delimiter. Quoted fields may contain delimiters, doubled quotes and
 * line breaks. A quote that does not form a proper quoted field (text after the closing quote, or no
 * closing quote at all) is read literally as part of an unquoted field, so stray quotes in prose never
 * swallow the rest of the input. Linear time: after one unclosed quote reaches the end of the text,
 * later quotes are read literally.
 */
function parseDelimited(text: string, delimiter: string): DelimitedParse {
  const records: string[][] = []
  let record: string[] = []
  let quotedFields = 0
  let malformed = false
  let quotesDisabled = false
  let separators = 0
  let separatorsFollowedBySpace = 0
  let cut = false
  let i = 0
  const n = text.length
  const isLineBreak = (ch: string | undefined) => ch === '\n' || ch === '\r'
  const endRecord = () => {
    records.push(record)
    record = []
  }
  while (i <= n) {
    if (records.length >= MAX_PARSED_RECORDS) {
      cut = i < n
      break
    }
    if (i === n) {
      if (record.length > 0) endRecord()
      break
    }
    let field = ''
    let quotedOk = false
    if (text[i] === '"' && !quotesDisabled) {
      // Try a quoted field.
      let j = i + 1
      let value = ''
      let closed = false
      while (j < n) {
        const ch = text[j]
        if (ch === '"') {
          if (text[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        value += ch
        j++
      }
      const next = text[j]
      if (closed && (j === n || next === delimiter || isLineBreak(next))) {
        field = value.replace(/\r\n?/g, '\n')
        quotedOk = true
        quotedFields++
        i = j
      } else {
        malformed = true
        if (!closed) quotesDisabled = true
      }
    }
    if (!quotedOk) {
      let j = i
      while (j < n && text[j] !== delimiter && !isLineBreak(text[j])) j++
      field = text.slice(i, j)
      i = j
    }
    record.push(field)
    if (i >= n) {
      endRecord()
      break
    }
    const ch = text[i]
    if (ch === delimiter) {
      separators++
      if (text[i + 1] === ' ') separatorsFollowedBySpace++
      i++
      if (i === n) {
        record.push('')
        endRecord()
        break
      }
    } else {
      // Line break (CRLF, LF or CR).
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      endRecord()
    }
  }
  return { records, quotedFields, malformed, separators, separatorsFollowedBySpace, cut }
}

/**
 * CSV only when it clearly is: no prose-style ", " separators, no stray quotes, and either properly
 * quoted fields or at least two records that all have the same number (>= 2) of fields.
 */
function looksLikeCsv(parse: DelimitedParse): boolean {
  if (parse.malformed || parse.separators === 0) return false
  if (parse.separatorsFollowedBySpace * 2 >= parse.separators) return false
  const nonEmpty = parse.records.filter((record) => record.some((cell) => cell.trim() !== ''))
  if (!nonEmpty.some((record) => record.length >= 2)) return false
  if (parse.quotedFields > 0) return true
  const width = nonEmpty[0]?.length ?? 0
  return nonEmpty.length >= 2 && nonEmpty.every((record) => record.length === width)
}

function parseGrid(input: string, maxCells: number): ParsedGrid {
  let text = typeof input === 'string' ? input : ''
  let truncated = false
  if (text.length > MAX_BULK_TEXT_CHARS) {
    text = truncateText(text, MAX_BULK_TEXT_CHARS)
    truncated = true
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // byte-order mark

  let raw: string[][]
  if (text.includes('\t')) {
    const tsv = parseDelimited(text, '\t')
    raw = tsv.records
    truncated ||= tsv.cut
  } else {
    const csv = text.includes(',') ? parseDelimited(text, ',') : null
    if (csv && looksLikeCsv(csv)) {
      raw = csv.records
      truncated ||= csv.cut
    } else {
      const lines = text.split(/\r\n|\r|\n/)
      if (lines.length > MAX_PARSED_RECORDS) truncated = true
      raw = lines.slice(0, MAX_PARSED_RECORDS).map((line) => [line])
    }
  }

  const rows: string[][] = []
  let cells = 0
  for (const record of raw) {
    const row = record.map((cell) => cell.trim())
    let filled = 0
    for (let col = 0; col < row.length; col++) {
      if (row[col] === '') continue
      if (cells >= maxCells) {
        // Row-major cut: keep the cells that fit, blank the rest.
        row[col] = ''
        truncated = true
        continue
      }
      cells++
      filled++
    }
    if (filled > 0) rows.push(row)
    if (cells >= maxCells && truncated) break
  }
  return { rows, truncated }
}

/**
 * Splits pasted text into rows × cells. Tab-separated text (spreadsheet copies from Excel / Google
 * Sheets / Numbers, including quoted cells with line breaks) and CSV (quoted fields, escaped quotes,
 * commas and line breaks inside quotes) become cells; anything else becomes one cell per line.
 * CRLF / CR / LF are all line breaks. Cells are trimmed, and empty cells and empty rows are dropped.
 * Text is treated as CSV only when it is unambiguous (every non-empty line has the same number (>= 2) of
 * fields without ", " prose-style separators, or it contains properly quoted fields), so prose like
 * "Buy milk, eggs" stays one cell. Input beyond 1,000,000 characters or 50,000 cells is ignored.
 */
export function parseBulkText(text: string): string[][] {
  return parseGrid(text, MAX_PARSED_CELLS).rows.map((row) => row.filter((cell) => cell !== ''))
}

function noteColor(color: unknown): TLDefaultColorStyle {
  return typeof color === 'string' && (DefaultColorStyle.values as string[]).includes(color)
    ? (color as TLDefaultColorStyle)
    : DefaultColorStyle.defaultValue
}

/**
 * Sticky notes from pasted text (Miro-style "paste as notes"). Layout is a grid anchored at `origin`:
 * one grid row per non-empty input row and one note per non-empty cell; a cell keeps its spreadsheet
 * column, so an empty cell leaves a gap instead of shifting its row (columns that are empty in every
 * row are removed). Notes are `NOTE_SIZE` (200) square at scale 1, `gap` apart. Notes beyond
 * `maxNotes` (row-major order), input beyond the text cap, and cell text beyond `MAX_NOTE_TEXT_CHARS`
 * are dropped and reported as `truncated: true`. Long text can make tldraw grow a note taller when it
 * is rendered (`growY`), which this layout cannot foresee.
 * Throws `TypeError` for invalid options (non-finite origin, bad page/parent id or index key).
 */
export function notesFromText(
  text: string,
  opts: BulkNotesOptions,
): { shapes: TLShape[]; truncated: boolean } {
  const { origin, pageId } = opts
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    throw new TypeError('notesFromText: origin must have finite x and y')
  }
  if (typeof pageId !== 'string' || !pageId.startsWith('page:')) {
    throw new TypeError('notesFromText: pageId must be a page id')
  }
  const parentId = opts.parentId ?? pageId
  if (typeof parentId !== 'string' || !(parentId.startsWith('page:') || parentId.startsWith('shape:'))) {
    throw new TypeError('notesFromText: parentId must be a page or shape id')
  }
  if (opts.indexAbove !== undefined && !isValidIndexKey(opts.indexAbove)) {
    throw new TypeError('notesFromText: indexAbove is not a valid index key')
  }
  const maxNotes =
    typeof opts.maxNotes === 'number' && Number.isFinite(opts.maxNotes)
      ? Math.min(MAX_BULK_NOTES, Math.max(0, Math.floor(opts.maxNotes)))
      : DEFAULT_MAX_NOTES
  const gap =
    typeof opts.gap === 'number' && Number.isFinite(opts.gap) && opts.gap >= 0
      ? Math.min(opts.gap, 10_000)
      : DEFAULT_NOTE_GAP
  const color = noteColor(opts.color)

  const grid = parseGrid(text, maxNotes)
  let truncated = grid.truncated
  const usedColumns = new Set<number>()
  for (const row of grid.rows) {
    row.forEach((cell, col) => {
      if (cell !== '') usedColumns.add(col)
    })
  }
  const columnSlot = new Map([...usedColumns].sort((a, b) => a - b).map((col, slot) => [col, slot]))

  const placed: { text: string; x: number; y: number }[] = []
  const step = NOTE_SIZE + gap
  grid.rows.forEach((row, rowIndex) => {
    row.forEach((cell, col) => {
      if (cell === '') return
      let value = cell
      if (value.length > MAX_NOTE_TEXT_CHARS) {
        value = truncateText(value, MAX_NOTE_TEXT_CHARS)
        truncated = true
      }
      const slot = columnSlot.get(col) ?? 0
      placed.push({ text: value, x: origin.x + slot * step, y: origin.y + rowIndex * step })
    })
  })

  const indices = getIndicesAbove(opts.indexAbove ?? null, placed.length)
  const shapes = placed.map(
    (note, i): TLNoteShape => ({
      id: createShapeId(),
      typeName: 'shape',
      type: 'note',
      x: note.x,
      y: note.y,
      rotation: 0,
      index: indices[i] as IndexKey,
      parentId,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        color,
        labelColor: 'black',
        size: 'm',
        font: 'draw',
        fontSizeAdjustment: 1,
        align: 'middle',
        verticalAlign: 'middle',
        growY: 0,
        url: '',
        richText: richTextFrom(note.text),
        scale: 1,
        textLastEditedBy: null,
      },
    }),
  )
  return { shapes, truncated }
}
