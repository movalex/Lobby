// The CSV export's `tags` column (PRS-13), for present-export's boardCsv. Pure.

import { csvTextCell } from '@draftroom/board-ops'
import { parseBoardTags } from '@draftroom/contracts'
import type { TLRecord } from 'tldraw'
import { type BoardTagMap, boardTagMap, displayTags, isTaggable, type Meta } from './model.ts'

export const TAGS_CSV_COLUMN = 'tags'
/** Between tag names inside the one cell. */
export const TAGS_CSV_SEPARATOR = '; '

/**
 * The `tags` cell of each shape id: its tag names as the board shows them (sorted), joined by "; ",
 * quoted and formula-neutralized like every other text cell (a tag named "=SUM(A1)" stays text). ''
 * for shapes without tags and for anything that is not a note or file card.
 */
export function tagsCsvCells(records: Iterable<TLRecord>): (shapeId: string) => string {
  let board: BoardTagMap = new Map()
  const metas = new Map<string, Meta>()
  for (const r of records) {
    if (r.typeName === 'document') board = boardTagMap(parseBoardTags(r.meta))
    else if (r.typeName === 'shape' && isTaggable(r)) metas.set(r.id, r.meta)
  }
  return (shapeId) => {
    const meta = metas.get(shapeId)
    if (!meta) return ''
    const names = displayTags(meta, board).map((t) => t.name)
    return names.length ? csvTextCell(names.join(TAGS_CSV_SEPARATOR)) : ''
  }
}
