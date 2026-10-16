// OWNER: WS3 (wave T). The storyboard PDF sheet's pages (the design §3.2): landscape A4 pages (96 dpi px) with 2, 3 or
// 6 panels each:
//   2  two large pictures, every field under each;
//   3  a row of three, every field under each;
//   6  a 3 × 2 grid, the camera and the dialogue under each;
// a line under the page's header band (the band itself holds the storyboard's title, as every Lobby PDF page) with
// the board, the date, the panel count, the running time and "Page n of m"; per panel its shot number, duration,
// start time and name, the picture (an image object, placed later: `SheetPictureSlot`) and the fields as text, cut
// with '…' to their box. At most SHEET_MAX_PAGES pages (the panels past them are counted, not printed).
//
// Pure (no DOM: the text is measured with the caller's function), in review-summary's drawing operations, so the
// same page becomes the vector page's SVG (real, searchable text) or the image fallback's canvas.
import { formatDuration, formatRunningTime } from '@draftroom/canvas-schema/planning'
import {
  FIELD_LABELS,
  FIELD_NAMES,
  type FieldName,
  type PanelFields,
  shotLabel,
} from '../../storyboard-play/model.ts'
import { wrapText } from '../ported/report.ts'
import type { MeasureText, Op } from '../review-summary/layout.ts'

export const SHEET_PAGE = { width: 1123, height: 794, margin: 40 } as const
export const SHEET_MAX_PAGES = 100
export const SHEET_PER_PAGE = [2, 3, 6] as const
export type SheetPerPage = (typeof SHEET_PER_PAGE)[number]

export const SHEET_INK = '#1b2330'
export const SHEET_MUTED = '#5a6472'
const RULE = '#cfcabd'
const PAPER = '#f6f4ee'
const GAP = 24
const LINE = 1.35

export interface SheetPanel {
  readonly number: number
  readonly name: string
  readonly startMs: number
  readonly durationMs: number
  readonly fields: PanelFields
  readonly hasPicture: boolean
}

export interface SheetInput {
  /** the storyboard's title (the pages' header band and bookmarks) */
  readonly title: string
  readonly boardTitle: string
  /** the date printed on every page, already in words */
  readonly date: string
  readonly totalMs: number
  /** the pictures' aspect (width / height) */
  readonly ratio: number
  readonly panels: readonly SheetPanel[]
}

/** Where a panel's picture goes: drawn "contain" inside the box once it is rendered. */
export interface SheetPictureSlot {
  readonly t: 'picture'
  /** the panel's index in `SheetInput.panels` */
  readonly panel: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type SheetOp = Op | SheetPictureSlot

export interface SheetPage {
  /** the page's header band and bookmark */
  readonly title: string
  readonly width: number
  readonly height: number
  readonly ops: readonly SheetOp[]
  /** the panels on it (indices into SheetInput.panels) */
  readonly panels: readonly number[]
}

interface Mode {
  readonly cols: number
  readonly rows: number
  /** the picture's largest share of a cell's height */
  readonly pictureShare: number
  readonly fieldPx: number
  readonly headPx: number
  /** the fields printed, and how many lines each may take (Infinity: as many as the cell holds) */
  readonly fields: readonly FieldName[]
  readonly maxLines: number
}

const MODES: Readonly<Record<SheetPerPage, Mode>> = {
  2: {
    cols: 2,
    rows: 1,
    pictureShare: 0.58,
    fieldPx: 12,
    headPx: 14,
    fields: FIELD_NAMES,
    maxLines: Number.POSITIVE_INFINITY,
  },
  3: {
    cols: 3,
    rows: 1,
    pictureShare: 0.48,
    fieldPx: 11,
    headPx: 13,
    fields: FIELD_NAMES,
    maxLines: Number.POSITIVE_INFINITY,
  },
  6: {
    cols: 3,
    rows: 2,
    pictureShare: 0.62,
    fieldPx: 10,
    headPx: 12,
    fields: ['camera', 'dialogue'],
    maxLines: 2,
  },
}

/** `text` cut to `width` with '…' (whole when it fits). */
export function ellipsize(text: string, width: number, measure: (s: string) => number): string {
  if (measure(text) <= width) return text
  const chars = Array.from(text)
  while (chars.length && measure(`${chars.join('').trimEnd()}…`) > width) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/**
 * `text` in lines: the first `firstWidth` wide (after a label), the others `width` wide. The first is empty when
 * its first word does not fit after the label.
 */
export function fieldLines(
  text: string,
  firstWidth: number,
  width: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  let first = ''
  let used = 0
  for (const w of words) {
    const candidate = first ? `${first} ${w}` : w
    if (measure(candidate) > firstWidth) break
    first = candidate
    used++
  }
  const rest = words.slice(used).join(' ')
  return [first, ...(rest ? wrapText(rest, width, measure) : [])]
}

/** Wrapped lines, at most `max`: the last one kept ends with '…' when some were cut. */
export function cutLines(
  text: string,
  width: number,
  max: number,
  measure: (s: string) => number,
): { lines: string[]; cut: boolean } {
  const all = wrapText(text, width, measure).filter((l, i, a) => l !== '' || (i > 0 && i < a.length - 1))
  if (all.length <= max) return { lines: all, cut: false }
  const lines = all.slice(0, Math.max(0, max))
  if (lines.length) {
    const last = lines.length - 1
    lines[last] = ellipsize(`${lines[last]}…`, width, measure).replace(/……$/, '…')
  }
  return { lines, cut: true }
}

class PageOps {
  readonly ops: SheetOp[] = []
  text(x: number, top: number, text: string, size: number, bold: boolean, fill: string) {
    // `top` is the line box's top; the baseline sits where review-summary's Flow puts it
    const h = size * LINE
    this.ops.push({ t: 'text', x, y: top + (h - size) / 2 + size * 0.8, text, size, bold, fill })
    return h
  }
  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string) {
    this.ops.push({ t: 'rect', x, y, w, h, fill, ...(stroke ? { stroke } : {}) })
  }
}

/** One panel in its cell. */
function drawPanel(
  page: PageOps,
  input: SheetInput,
  index: number,
  cell: { x: number; y: number; w: number; h: number },
  mode: Mode,
  measure: MeasureText,
) {
  const p = input.panels[index] as SheetPanel
  const ratio = input.ratio > 0 ? input.ratio : 16 / 9
  // the picture's box: the full width, unless the cell's share of height is the limit
  let pw = cell.w
  let ph = pw / ratio
  const maxH = cell.h * mode.pictureShare
  if (ph > maxH) {
    ph = maxH
    pw = ph * ratio
  }
  const px = cell.x + (cell.w - pw) / 2
  page.rect(px, cell.y, pw, ph, PAPER, RULE)
  if (p.hasPicture) page.ops.push({ t: 'picture', panel: index, x: px, y: cell.y, w: pw, h: ph })
  else {
    const words = 'No picture'
    const size = mode.fieldPx
    page.text(
      px + (pw - measure(words, size, false)) / 2,
      cell.y + ph / 2 - size * 0.7,
      words,
      size,
      false,
      SHEET_MUTED,
    )
  }
  let y = cell.y + ph + 8
  const bottom = cell.y + cell.h
  // the heading: the shot, its duration and start, its name
  const head = `${shotLabel(p.number)} · ${formatDuration(p.durationMs)}`
  const headW = measure(head, mode.headPx, true)
  page.text(cell.x, y, head, mode.headPx, true, SHEET_INK)
  const rest = [`at ${formatRunningTime(p.startMs)}`, p.name].filter(Boolean).join(' · ')
  if (rest) {
    const room = cell.w - headW - 10
    if (room > 30)
      page.text(
        cell.x + headW + 10,
        y + (mode.headPx - mode.fieldPx) * 0.5,
        ellipsize(rest, room, (s) => measure(s, mode.fieldPx, false)),
        mode.fieldPx,
        false,
        SHEET_MUTED,
      )
  }
  y += mode.headPx * LINE + 4
  const lineH = mode.fieldPx * LINE
  const textMeasure = (s: string) => measure(s, mode.fieldPx, false)
  for (const f of mode.fields) {
    const words = p.fields[f].trim()
    if (!words) continue
    const label = `${FIELD_LABELS[f]}:`
    const labelW = measure(label, mode.fieldPx, true) + 6
    const roomLines = Math.floor((bottom - y) / lineH)
    if (roomLines < 1) break
    // the label first, the words after it on its line and on full lines under it
    const lines = fieldLines(words, cell.w - labelW, cell.w, textMeasure)
    const max = Math.min(mode.maxLines, roomLines, lines.length)
    page.text(cell.x, y, label, mode.fieldPx, true, SHEET_MUTED)
    for (let i = 0; i < max; i++) {
      let line = lines[i] as string
      const width = i === 0 ? cell.w - labelW : cell.w
      if (i === max - 1 && max < lines.length)
        line = ellipsize(`${line}…`, width, textMeasure).replace(/……$/, '…')
      if (line) page.text(cell.x + (i === 0 ? labelW : 0), y, line, mode.fieldPx, false, SHEET_INK)
      y += lineH
    }
    y += 2
  }
}

/** The sheet's pages for `perPage` panels per page (at most SHEET_MAX_PAGES), and how many panels did not fit. */
export function layoutSheet(
  input: SheetInput,
  perPage: SheetPerPage,
  measure: MeasureText,
  maxPages = SHEET_MAX_PAGES,
): { pages: SheetPage[]; notShown: number } {
  const mode = MODES[perPage]
  const { width: W, height: H, margin: M } = SHEET_PAGE
  const shown = Math.min(input.panels.length, perPage * maxPages)
  const count = Math.max(1, Math.ceil(shown / perPage))
  const pages: SheetPage[] = []
  const metaPx = 11
  const top = M + metaPx * LINE + 12
  const cellW = (W - M * 2 - GAP * (mode.cols - 1)) / mode.cols
  const cellH = (H - top - M - GAP * (mode.rows - 1)) / mode.rows
  const noun = input.panels.length === 1 ? 'panel' : 'panels'
  for (let n = 0; n < count; n++) {
    const page = new PageOps()
    const meta = [
      input.boardTitle,
      input.date,
      `${input.panels.length} ${noun}`,
      `Running time ${formatRunningTime(input.totalMs)}`,
      `Page ${n + 1} of ${count}`,
    ]
      .filter(Boolean)
      .join(' · ')
    page.text(
      M,
      M,
      ellipsize(meta, W - M * 2, (s) => measure(s, metaPx, false)),
      metaPx,
      false,
      SHEET_MUTED,
    )
    page.rect(M, top - 8, W - M * 2, 1, RULE)
    const on: number[] = []
    for (let k = 0; k < perPage; k++) {
      const index = n * perPage + k
      if (index >= shown) break
      on.push(index)
      const col = k % mode.cols
      const row = Math.floor(k / mode.cols)
      drawPanel(
        page,
        input,
        index,
        { x: M + col * (cellW + GAP), y: top + row * (cellH + GAP), w: cellW, h: cellH },
        mode,
        measure,
      )
    }
    if (!input.panels.length) page.text(M, top, 'This storyboard has no panels.', 14, false, SHEET_MUTED)
    pages.push({
      title: count > 1 ? `${input.title} (${n + 1} of ${count})` : input.title,
      width: W,
      height: H,
      ops: page.ops,
      panels: on,
    })
  }
  return { pages, notShown: input.panels.length - shown }
}

/** A rendered picture: a JPEG or PNG data: URL and its pixel size. */
export interface SheetPicture {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

/** A page's operations with its picture slots filled ("contain" in their boxes; a missing picture leaves the box). */
export function placePictures(
  ops: readonly SheetOp[],
  pictureOf: (panel: number) => SheetPicture | null,
): Op[] {
  const out: Op[] = []
  for (const op of ops) {
    if (op.t !== 'picture') {
      out.push(op)
      continue
    }
    const pic = pictureOf(op.panel)
    if (!pic || pic.width <= 0 || pic.height <= 0) continue
    const k = Math.min(op.w / pic.width, op.h / pic.height)
    const w = pic.width * k
    const h = pic.height * k
    out.push({ t: 'image', x: op.x + (op.w - w) / 2, y: op.y + (op.h - h) / 2, w, h, dataUrl: pic.dataUrl })
  }
  return out
}
