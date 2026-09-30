/**
 * CSV export of a board's elements (the new canvas's `boardToCsv`): the same header, cells and reading
 * order as the tldraw export (`../csv-cell.ts`, `../common.ts` readingOrder), one row per item.
 *
 * - Rows: every live element except bound labels (their words are their container's text) and ink
 *   (`freedraw`, `line`), in reading order (rows by top edge with jitter tolerance, then left to right).
 * - `id`: the element id; `type`: what Lobby calls it (read.ts `kindOf`: `note`, `text`, `rectangle`,
 *   `ellipse`, `diamond`, `arrow`, `frame`, `image`, `file-card`); `text`: `elementText`; `frame`: the name
 *   of the frame it is in; `color`: Lobby's colour name when the colour is one of the palette's (a note by
 *   its fill, anything else by its stroke), else the stored colour, and empty for frames and images;
 *   `x`, `y`: the element's scene position, rounded to 2 decimals.
 * Records end with CRLF; every text cell goes through `csvTextCell` (quoting, formula neutralization).
 */

import { type Box, readingOrder } from '../common.ts'
import { CSV_HEADER, csvNumberCell, csvTextCell } from '../csv-cell.ts'
import { noteColorName, strokeColorName } from './palette.ts'
import {
  asElements,
  type BoardElement,
  elementBounds,
  elementText,
  isLabel,
  isLive,
  kindOf,
  lookupOf,
} from './read.ts'

/** Element types without text or position meaning for a spreadsheet (pure ink). */
const SKIPPED = new Set(['freedraw', 'line'])

/** The CSV `color` cell of an element. */
export function colorCellOf(el: BoardElement): string {
  if (el.type === 'frame' || el.type === 'image') return ''
  if (el.type === 'stickynote') return noteColorName(el.backgroundColor) ?? String(el.backgroundColor ?? '')
  return strokeColorName(el.strokeColor) ?? String(el.strokeColor ?? '')
}

export function elementsToCsv(elements: Iterable<unknown>): string {
  const list = asElements(elements)
  const get = lookupOf(list)
  const seen = new Set<string>()
  const rows: { id: string; bounds: Box; el: BoardElement }[] = []
  for (const el of list) {
    if (seen.has(el.id)) continue
    seen.add(el.id)
    if (!isLive(el) || isLabel(el) || SKIPPED.has(el.type)) continue
    rows.push({ id: el.id, bounds: elementBounds(el), el })
  }
  const lines = [CSV_HEADER.join(',')]
  for (const { el } of readingOrder(rows)) {
    const frame = el.frameId ? get(el.frameId) : undefined
    lines.push(
      [
        csvTextCell(el.id),
        csvTextCell(kindOf(el)),
        csvTextCell(elementText(el, get)),
        csvTextCell(isLive(frame) && frame.type === 'frame' ? String(frame.name ?? '') : ''),
        csvTextCell(colorCellOf(el)),
        csvNumberCell(typeof el.x === 'number' && Number.isFinite(el.x) ? el.x : 0),
        csvNumberCell(typeof el.y === 'number' && Number.isFinite(el.y) ? el.y : 0),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
