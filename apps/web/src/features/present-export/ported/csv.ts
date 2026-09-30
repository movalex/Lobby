// CSV export on the Excalidraw page (the port of ../csv-export.ts): board-ops/elements' rows (header
// id,type,text,frame,color,x,y; RFC 4180 quoting; formula neutralization; reading order; one row per
// item, labels folded into their container, ink left out) plus a trailing `tags` column (PRS-13) and, once
// a vote's results are revealed and shown, a `votes` column (R14), for the whole board or only the rows of
// a selection. A sticky note's colour is the name the note palette shows ("Marigold" for the stored
// 'yellow'; canvas-ux/palette.ts), never the stored value.
//
// The ported rows are built here from board-ops' element helpers rather than by re-parsing
// `elementsToCsv`'s text, so the extra columns and the colour names need no CSV parser.
import {
  asElements,
  type BoardElement,
  CSV_HEADER,
  colorCellOf,
  csvTextCell,
  elementBounds,
  elementText,
  isLabel,
  isLive,
  kindOf,
  lookupOf,
  readingOrder,
} from '@draftroom/board-ops/elements'
import type { VoteResult } from '@draftroom/contracts'
import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'
import { votesByShape } from '../../workshops/vote-export.ts'
import { resultElementId } from './badges.ts'

// The same column names, file type and helpers as the tldraw page's ../csv-export.ts and ../../tags/csv.ts,
// kept here because those modules load the tldraw board-ops (a runtime tldraw dependency).
export const TAGS_CSV_COLUMN = 'tags'
export const TAGS_CSV_SEPARATOR = '; '
export const VOTES_CSV_COLUMN = 'votes'
export const CSV_MIME = 'text/csv;charset=utf-8'
/** Excel only reads a UTF-8 CSV as UTF-8 (accents, emoji, CJK) when it starts with a byte-order mark. */
export const UTF8_BOM = '﻿'

/** Number of data rows (without the header) in a boardCsv result. */
export function csvRowCount(csv: string): number {
  return Math.max(0, csv.split('\r\n').filter((l) => l !== '').length - 1)
}

/** A download-ready Blob: UTF-8 with a BOM so spreadsheet apps detect the encoding. */
export function csvBlob(csv: string): Blob {
  return new Blob([UTF8_BOM, csv], { type: CSV_MIME })
}

/** Element types without text or position meaning for a spreadsheet (pure ink), as board-ops skips them. */
const SKIPPED = new Set(['freedraw', 'line'])
const NOTE_COLOR_LABELS = new Map<string, string>(NOTE_PALETTE.map((s) => [s.name, s.label]))
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function numberCell(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** Tag names on an element as the board shows them: the board's definition wins (lb_doc `tagDef:`). */
function tagsCell(el: BoardElement, defs: ReadonlyMap<string, { name: string }>): string {
  const lobby = (el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby
  if (!lobby || (el.type !== 'stickynote' && el.type !== 'image')) return ''
  const tags: { key: string; name: string }[] = []
  for (const [k, v] of Object.entries(lobby)) {
    if (!k.startsWith('tag:')) continue
    const key = k.slice(4)
    const own = v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined
    const name = defs.get(key)?.name ?? (typeof own === 'string' ? own : '')
    if (name) tags.push({ key, name })
  }
  tags.sort((a, b) => collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return tags.length ? csvTextCell(tags.map((t) => t.name).join(TAGS_CSV_SEPARATOR)) : ''
}

/**
 * CSV of the board, or of `onlyIds` (a selection with what it contains) when given: the rows of the
 * whole board (reading order, frame names from the whole board) filtered to those elements. Records are
 * CRLF-separated and the text ends with CRLF.
 */
export function boardCsv(
  elements: Iterable<unknown>,
  onlyIds?: ReadonlySet<string>,
  opts: { votes?: readonly VoteResult[] | null; tagDefs?: ReadonlyMap<string, { name: string }> } = {},
): string {
  const list = asElements(elements)
  const get = lookupOf(list)
  const votes =
    opts.votes && opts.votes.length > 0
      ? votesByShape(opts.votes.map((r) => ({ ...r, shapeId: resultElementId(r) as VoteResult['shapeId'] })))
      : null
  const defs = opts.tagDefs ?? new Map()
  const seen = new Set<string>()
  const rows: { id: string; bounds: ReturnType<typeof elementBounds>; el: BoardElement }[] = []
  for (const el of list) {
    if (seen.has(el.id)) continue
    seen.add(el.id)
    if (!isLive(el) || isLabel(el) || SKIPPED.has(el.type)) continue
    rows.push({ id: el.id, bounds: elementBounds(el), el })
  }
  const header = [...CSV_HEADER, TAGS_CSV_COLUMN, ...(votes ? [VOTES_CSV_COLUMN] : [])].join(',')
  const lines = [header]
  for (const { el } of readingOrder(rows)) {
    if (onlyIds && !onlyIds.has(el.id)) continue
    const frame = el.frameId ? get(el.frameId) : undefined
    const color =
      el.type === 'stickynote' ? (NOTE_COLOR_LABELS.get(colorCellOf(el)) ?? colorCellOf(el)) : colorCellOf(el)
    lines.push(
      [
        csvTextCell(el.id),
        csvTextCell(kindOf(el)),
        csvTextCell(elementText(el, get)),
        csvTextCell(isLive(frame) && frame.type === 'frame' ? String(frame.name ?? '') : ''),
        csvTextCell(color),
        numberCell(typeof el.x === 'number' && Number.isFinite(el.x) ? el.x : 0),
        numberCell(typeof el.y === 'number' && Number.isFinite(el.y) ? el.y : 0),
        tagsCell(el, defs),
        ...(votes ? [votes(el.id)] : []),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
