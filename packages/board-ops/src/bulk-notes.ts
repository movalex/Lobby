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
import { isValidIndexKey } from './board-index.ts'
import { layoutBulkNotes } from './bulk-parse.ts'
import { richTextFrom } from './rich-text.ts'

export {
  DEFAULT_MAX_NOTES,
  DEFAULT_NOTE_GAP,
  MAX_BULK_NOTES,
  MAX_BULK_TEXT_CHARS,
  MAX_NOTE_TEXT_CHARS,
  NOTE_SIZE,
  parseBulkText,
} from './bulk-parse.ts'

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
  const color = noteColor(opts.color)
  const { placed, truncated } = layoutBulkNotes(text, origin, opts)

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
