// The CSV export's `tags` column (PRS-13) on the new canvas (the port of ../csv.ts), for 3e's boardCsv.
// Pure: elements and the board's tag list (./model.ts boardTagsOf over lb_doc's `tagDef:` entries) in, one
// cell per element id out.

import { csvTextCell } from '@draftroom/board-ops/elements'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { type BoardTagMap, displayTags, isTaggable } from './model.ts'

export const TAGS_CSV_COLUMN = 'tags'
/** Between tag names inside the one cell. */
export const TAGS_CSV_SEPARATOR = '; '

/**
 * The `tags` cell of each element id: its tag names as the board shows them (sorted), joined by "; ",
 * quoted and formula-neutralized like every other text cell (a tag named "=SUM(A1)" stays text). '' for
 * elements without tags and for anything that does not take tags (./model.ts TAGGABLE_KINDS).
 */
export function tagsCsvCells(elements: Iterable<CanvasElement>, board: BoardTagMap): (id: string) => string {
  const byId = new Map<string, CanvasElement>()
  for (const el of elements) if (isTaggable(el)) byId.set(el.id, el)
  return (id) => {
    const el = byId.get(id)
    if (!el) return ''
    const names = displayTags(el, board).map((t) => t.name)
    return names.length ? csvTextCell(names.join(TAGS_CSV_SEPARATOR)) : ''
  }
}
