import type { TLPageId, TLRecord, TLShape } from '@tldraw/tlschema'
import { BoardIndex, type Box, localSize, pageBounds, readingOrder, stringProp } from './board-index.ts'
import { CSV_HEADER, csvNumberCell, csvTextCell } from './csv-cell.ts'
import { extractSearchableText } from './search.ts'

export { CSV_HEADER, csvTextCell } from './csv-cell.ts'

/** Shape types without text or position meaning for a spreadsheet (pure ink and grouping). */
const SKIPPED_TYPES = new Set(['group', 'draw', 'highlight', 'line'])

interface Row {
  id: string
  bounds: Box
  shape: TLShape
  x: number
  y: number
  pageRank: number
}

/**
 * CSV export of a board (one page with `opts.pageId`, else every page, pages in page order). One row per
 * shape except groups and ink (draw/highlight/line); columns `id,type,text,frame,color,x,y` where
 * `text` is `extractSearchableText`, `frame` the nearest ancestor frame's name, `color` the shape's color
 * style (empty when it has none) and `x,y` the page-space origin rounded to 2 decimals. Rows follow
 * reading order (rows by top edge with jitter tolerance, then left to right). Records are separated
 * by CRLF and the output ends with CRLF. Every text cell goes through `csvTextCell` (quoting +
 * formula neutralization); the numeric x/y cells are generated numbers and are never prefixed, so
 * negative coordinates stay numeric. No BOM is added (the HTTP layer may prepend one for Excel).
 */
export function boardToCsv(records: Iterable<TLRecord>, opts?: { pageId?: TLPageId }): string {
  const board = new BoardIndex(records)
  const rows: Row[] = []
  for (const shape of board.shapes.values()) {
    if (SKIPPED_TYPES.has(shape.type)) continue
    const pageId = board.pageOf(shape.id)
    if (!pageId || (opts?.pageId !== undefined && pageId !== opts.pageId)) continue
    const transform = board.pageTransform(shape.id)
    if (!transform) continue
    const size = localSize(shape)
    rows.push({
      id: shape.id,
      bounds: pageBounds(transform, size.w, size.h),
      shape,
      x: transform.x,
      y: transform.y,
      pageRank: board.pageRank(pageId),
    })
  }
  const byPage = new Map<number, Row[]>()
  for (const row of rows) {
    const list = byPage.get(row.pageRank)
    if (list) list.push(row)
    else byPage.set(row.pageRank, [row])
  }
  const ordered = [...byPage.entries()].sort(([a], [b]) => a - b).flatMap(([, list]) => readingOrder(list))

  const lines = [CSV_HEADER.join(',')]
  for (const { shape, x, y } of ordered) {
    const frame = board.parentFrame(shape.id)
    lines.push(
      [
        csvTextCell(shape.id),
        csvTextCell(shape.type),
        csvTextCell(extractSearchableText(shape)),
        csvTextCell(frame ? stringProp(frame, 'name') : ''),
        csvTextCell(stringProp(shape, 'color')),
        csvNumberCell(x),
        csvNumberCell(y),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
