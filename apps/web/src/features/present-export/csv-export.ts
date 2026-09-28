// CSV export: board-ops `boardToCsv` (header id,type,text,frame,color,x,y; RFC 4180 quoting; formula
// neutralization) plus a trailing `tags` column (wave 4 tags, PRS-13: tags/csv.ts) and, once a vote's
// results are revealed (and shown), a `votes` column (final review R14), for the whole board, or only
// the rows of a selection. A sticky note's colour is the name the note palette shows ("Butter" for
// tldraw's default 'black', which is drawn yellow; canvas-ux/palette.ts), never the stored style name.
import type { VoteResult } from '@draftroom/contracts'
import type { TLRecord } from 'tldraw'
import { NOTE_PALETTE } from '../canvas-ux/palette.ts'
import { TAGS_CSV_COLUMN, tagsCsvCells } from '../tags/csv.ts'
import { votesByShape } from '../workshops/vote-export.ts'
import { boardToCsv } from './board-ops.ts'

export const VOTES_CSV_COLUMN = 'votes'

const NOTE_COLOR_LABELS = new Map<string, string>(NOTE_PALETTE.map((s) => [s.name, s.label]))

/** Notes carry their palette name as `color` (a copy: the board's records are never touched). */
function withNoteColorNames(records: readonly TLRecord[]): TLRecord[] {
  return records.map((r) => {
    if (r.typeName !== 'shape' || r.type !== 'note') return r
    const color = (r.props as { color?: unknown }).color
    const label = typeof color === 'string' ? NOTE_COLOR_LABELS.get(color) : undefined
    return label ? ({ ...r, props: { ...r.props, color: label } } as TLRecord) : r
  })
}

export const CSV_MIME = 'text/csv;charset=utf-8'
/** Excel only reads a UTF-8 CSV as UTF-8 (accents, emoji, CJK) when it starts with a byte-order mark. */
export const UTF8_BOM = '﻿'

/**
 * The first field of one CSV record as boardToCsv writes it (the shape id): quoted fields are unquoted.
 * boardToCsv turns CR/CRLF inside cells into LF, so CRLF only ever separates records.
 */
function firstField(line: string): string {
  if (!line.startsWith('"')) {
    const comma = line.indexOf(',')
    return comma < 0 ? line : line.slice(0, comma)
  }
  let out = ''
  for (let i = 1; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (line[i + 1] === '"') {
        out += '"'
        i++
      } else break
    } else out += ch
  }
  return out
}

/**
 * CSV of the board, or of `onlyIds` (a selection plus its descendants) when given: the same rows
 * boardToCsv produces for the whole board (reading order, frame names resolved through the full board),
 * filtered to those shapes. Records are CRLF-separated and the text ends with CRLF.
 */
export function boardCsv(
  records: Iterable<TLRecord>,
  onlyIds?: ReadonlySet<string>,
  opts: { votes?: readonly VoteResult[] | null } = {},
): string {
  const list = [...records]
  const tagsOf = tagsCsvCells(list)
  const votes = opts.votes && opts.votes.length > 0 ? votesByShape(opts.votes) : null
  const lines = boardToCsv(withNoteColorNames(list)).split('\r\n')
  const header = `${lines[0] ?? ''},${TAGS_CSV_COLUMN}${votes ? `,${VOTES_CSV_COLUMN}` : ''}`
  const rows: string[] = []
  for (const line of lines.slice(1)) {
    if (line === '') continue
    const id = firstField(line)
    if (onlyIds && !onlyIds.has(id)) continue
    rows.push(`${line},${tagsOf(id)}${votes ? `,${votes(id)}` : ''}`)
  }
  return `${[header, ...rows].join('\r\n')}\r\n`
}

/** Number of data rows (without the header) in a boardCsv result. */
export function csvRowCount(csv: string): number {
  return Math.max(0, csv.split('\r\n').filter((l) => l !== '').length - 1)
}

/** A download-ready Blob: UTF-8 with a BOM so spreadsheet apps detect the encoding. */
export function csvBlob(csv: string): Blob {
  return new Blob([UTF8_BOM, csv], { type: CSV_MIME })
}
