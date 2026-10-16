// OWNER: WS4 (wave S, the review summary PDF). Lays the summary model out on pages (docs/WAVE-S-CONTRACTS.md §6):
// a cover with the board title, the round, the dates and the counts, a contents list, and one page per item (two at
// most: REVIEW_SUMMARY.pagesPerItem) with its picture, status, who and when, the version, the status history and every
// open thread with its replies. Pages are lists of drawing operations in px (A4 portrait at 96 dpi), so the same page
// becomes an SVG for the vector PDF path (./svg.ts) or a canvas for the image fallback (./raster.ts). No DOM: the text
// is measured with a function the caller gives (Helvetica's widths in the PDF, a stand-in in tests), and the whole
// layout is unit-tested in Node.
import {
  REVIEW_GUEST_FOOTNOTE,
  REVIEW_STATUS_LABELS,
  REVIEW_SUMMARY,
  type ReviewStatus,
  type ReviewSummaryModel,
} from '@draftroom/contracts'
import { wrapText } from '../ported/report.ts'
import { defaultDate } from './model.ts'

export const SUMMARY_PAGE = { width: 794, height: 1123, margin: 56 } as const

export const INK = '#1b2330'
export const MUTED = '#5a6472'
const RULE = '#dcd8cc'
const PAPER = '#f6f4ee'

/** Pill colours: text and fill pairs that stay AA on the paper (never colour alone: the pill says the status). */
export const STATUS_COLORS: Readonly<Record<ReviewStatus, { readonly fill: string; readonly ink: string }>> =
  {
    approved: { fill: '#e3f4e8', ink: '#14532d' },
    changes_requested: { fill: '#fdeccf', ink: '#7a3e00' },
    pending: { fill: '#e9edf3', ink: '#334155' },
  }

export type Op =
  | {
      readonly t: 'rect'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly fill: string
      readonly stroke?: string
    }
  | {
      readonly t: 'text'
      readonly x: number
      /** the baseline */
      readonly y: number
      readonly text: string
      readonly size: number
      readonly bold: boolean
      readonly fill: string
    }
  | {
      readonly t: 'image'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly dataUrl: string
    }

export interface SummaryPage {
  /** the PDF page's title (its header band and bookmark) */
  readonly title: string
  readonly width: number
  readonly height: number
  readonly ops: readonly Op[]
}

/** A picture ready to print: a JPEG or PNG data: URL and its pixel size. */
export interface SummaryPicture {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

/** Text width in px of `text` at `size` px in the page's font (Helvetica). */
export type MeasureText = (text: string, size: number, bold: boolean) => number

export interface LayoutOptions {
  readonly maxPages?: number
  readonly formatDate?: (iso: string) => string
}

const LINE = 1.38
const PICTURE_MAX_H = 380
const PICTURE_MAX_UPSCALE = 1.5
const BAND_CLEARANCE = 0 // the PDF page's header band is above the page, not inside it

class Page {
  readonly ops: Op[] = []
  readonly title: string
  constructor(title: string) {
    this.title = title
  }
}

/** The flowing layout cursor over a list of pages. */
class Flow {
  readonly pages: Page[] = []
  page!: Page
  y = 0
  readonly left: number = SUMMARY_PAGE.margin
  readonly width: number = SUMMARY_PAGE.width - SUMMARY_PAGE.margin * 2
  /** keeps the last lines of a page free for the guest footnote */
  readonly bottom = SUMMARY_PAGE.height - SUMMARY_PAGE.margin - 20

  readonly measure: MeasureText
  constructor(measure: MeasureText) {
    this.measure = measure
  }

  newPage(title: string): Page {
    this.page = new Page(title)
    this.pages.push(this.page)
    this.y = SUMMARY_PAGE.margin + BAND_CLEARANCE
    return this.page
  }

  room(h: number): boolean {
    return this.y + h <= this.bottom
  }

  gap(h: number) {
    if (this.y > SUMMARY_PAGE.margin) this.y += h
  }

  wrap(text: string, size: number, bold: boolean, width = this.width): string[] {
    return wrapText(text, width, (s) => this.measure(s, size, bold))
  }

  /** Draws one line of text at the cursor (the caller checked the room) and moves down. */
  line(text: string, size: number, bold: boolean, fill: string, x = this.left): number {
    const h = size * LINE
    this.page.ops.push({ t: 'text', x, y: this.y + (h - size) / 2 + size * 0.8, text, size, bold, fill })
    this.y += h
    return h
  }

  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string) {
    this.page.ops.push({ t: 'rect', x, y, w, h, fill, ...(stroke ? { stroke } : {}) })
  }

  /** A pill with `text` at the cursor; returns its width. */
  pill(text: string, status: ReviewStatus, x: number, y: number, size = 14): number {
    const colors = STATUS_COLORS[status]
    const w = Math.ceil(this.measure(text, size, true)) + 24
    const h = Math.round(size * 1.9)
    this.rect(x, y, w, h, colors.fill)
    this.page.ops.push({
      t: 'text',
      x: x + 12,
      y: y + (h - size) / 2 + size * 0.8,
      text,
      size,
      bold: true,
      fill: colors.ink,
    })
    return w
  }
}

const clipLine = (s: string, width: number, size: number, bold: boolean, measure: MeasureText) => {
  if (measure(s, size, bold) <= width) return s
  const chars = Array.from(s)
  while (chars.length > 1 && measure(`${chars.join('').trimEnd()}…`, size, bold) > width) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/** The cover (and its contents list, over as many pages as the items need). */
function layoutCover(
  flow: Flow,
  model: ReviewSummaryModel,
  measure: MeasureText,
  date: (iso: string) => string,
) {
  const { cover } = model
  flow.newPage('Review summary')
  flow.line('Review summary', 14, false, MUTED)
  flow.y += 4
  for (const l of flow.wrap(cover.boardTitle || 'Untitled board', 30, true).slice(0, 4))
    flow.line(l, 30, true, INK)
  flow.y += 10
  if (cover.roundTitle) {
    flow.line(cover.roundTitle, 20, true, INK)
    const dates = [
      cover.openedAt ? `Opened ${date(cover.openedAt)}` : '',
      cover.closedAt ? `Closed ${date(cover.closedAt)}` : 'Open',
    ].filter(Boolean)
    flow.line(dates.join(' · '), 13, false, MUTED)
  } else {
    flow.line('All items in review', 20, true, INK)
  }
  flow.y += 16

  // counts: one pill per status, wrapped to the page width
  let x = flow.left
  let rowTop = flow.y
  const rowH = Math.round(14 * 1.9)
  for (const status of ['approved', 'changes_requested', 'pending'] as const) {
    const text = `${cover.counts[status]} ${REVIEW_STATUS_LABELS[status]}`
    const w = Math.ceil(measure(text, 14, true)) + 24
    if (x > flow.left && x + w > flow.left + flow.width) {
      x = flow.left
      rowTop += rowH + 8
    }
    flow.pill(text, status, x, rowTop)
    x += w + 10
  }
  flow.y = rowTop + rowH + 16

  flow.line(`Generated by ${cover.generatedBy || 'someone'} on ${date(cover.generatedAt)}`, 13, false, MUTED)
  flow.y += 20

  // contents: "1. Label ........ Status"
  const statusCol = Math.max(
    ...Object.values(REVIEW_STATUS_LABELS).map((s) => Math.ceil(measure(s, 13, true))),
  )
  const labelW = flow.width - statusCol - 16
  const heading = (title: string) => {
    flow.line(title, 18, true, INK)
    flow.y += 6
  }
  if (model.items.length > 0) heading(`Items (${model.items.length})`)
  model.items.forEach((item, i) => {
    const h = 14 * LINE + 6
    if (!flow.room(h + 18 + 40)) {
      flow.newPage('Review summary (continued)')
      flow.line('Review summary (continued)', 18, true, INK)
      flow.y += 8
    }
    const top = flow.y
    const label = clipLine(`${i + 1}. ${item.label}`, labelW, 14, false, measure)
    flow.line(label, 14, false, INK)
    flow.page.ops.push({
      t: 'text',
      x: flow.left + flow.width - statusCol,
      y: top + (14 * LINE - 13) / 2 + 13 * 0.8,
      text: REVIEW_STATUS_LABELS[item.status],
      size: 13,
      bold: true,
      fill: STATUS_COLORS[item.status].ink,
    })
    flow.y = top + h
  })
}

/** Pages of one item: its summary page and, for long threads, a second. Returns how many threads did not fit. */
function layoutItem(
  flow: Flow,
  item: ReviewSummaryModel['items'][number],
  index: number,
  total: number,
  picture: SummaryPicture | null,
  date: (iso: string) => string,
  maxPages: number,
): { pages: number; cutThreads: number } {
  let pages = 1
  flow.newPage(item.label || `Item ${index + 1}`)
  const continuePage = (): boolean => {
    if (pages >= maxPages) return false
    pages++
    flow.newPage(`${item.label || `Item ${index + 1}`} (continued)`)
    flow.line(`${clipLine(item.label, flow.width - 120, 16, true, flow.measure)} (continued)`, 16, true, INK)
    flow.y += 8
    return true
  }
  flow.line(`Item ${index + 1} of ${total}`, 13, false, MUTED)
  flow.y += 2
  for (const l of flow.wrap(item.label || `Item ${index + 1}`, 24, true).slice(0, 3))
    flow.line(l, 24, true, INK)
  flow.y += 12

  // status
  const pillText = REVIEW_STATUS_LABELS[item.status]
  const pillW = flow.pill(pillText, item.status, flow.left, flow.y)
  const pillH = Math.round(14 * 1.9)
  const metaParts = [item.by, item.at ? date(item.at) : ''].filter(Boolean)
  if (metaParts.length) {
    const meta = metaParts.join(' · ')
    const x = flow.left + pillW + 12
    const room = flow.left + flow.width - x
    const lines = flow.wrap(meta, 13, false, room)
    const first = lines[0] ?? ''
    flow.page.ops.push({
      t: 'text',
      x,
      y: flow.y + (pillH - 13) / 2 + 13 * 0.8,
      text: first,
      size: 13,
      bold: false,
      fill: INK,
    })
    flow.y += pillH
    for (const l of lines.slice(1, 3)) flow.line(l, 13, false, INK, x)
  } else {
    flow.y += pillH
  }
  if (item.version) {
    flow.y += 6
    flow.line(`Version ${item.version}`, 13, false, MUTED)
  }
  flow.y += 14

  // picture
  const boxW = flow.width
  if (picture) {
    const k = Math.min(boxW / picture.width, PICTURE_MAX_H / picture.height, PICTURE_MAX_UPSCALE)
    const w = Math.max(1, Math.round(picture.width * k))
    const h = Math.max(1, Math.round(picture.height * k))
    flow.rect(flow.left, flow.y, boxW, h + 16, PAPER, RULE)
    flow.page.ops.push({
      t: 'image',
      x: flow.left + Math.round((boxW - w) / 2),
      y: flow.y + 8,
      w,
      h,
      dataUrl: picture.dataUrl,
    })
    flow.y += h + 16
  } else {
    flow.rect(flow.left, flow.y, boxW, 90, PAPER, RULE)
    flow.page.ops.push({
      t: 'text',
      x: flow.left + 16,
      y: flow.y + 45 + 5,
      text: 'No preview of this item is available.',
      size: 13,
      bold: false,
      fill: MUTED,
    })
    flow.y += 90
  }
  flow.y += 18

  // history
  const heading = (text: string, need: number): boolean => {
    if (!flow.room(20 * LINE + need) && !continuePage()) return false
    flow.line(text, 16, true, INK)
    flow.y += 4
    return true
  }
  if (item.history.length > 0 && heading('History', 13 * LINE)) {
    for (const row of item.history) {
      const lines = flow.wrap(row, 12.5, false)
      if (!flow.room(lines.length * 12.5 * LINE) && !continuePage()) break
      for (const l of lines) flow.line(l, 12.5, false, MUTED)
      flow.y += 2
    }
    flow.y += 12
  }

  // open threads
  let cut = 0
  const n = item.threads.length
  if (heading(n === 0 ? 'No open comments.' : `Open comments (${n})`, n === 0 ? 0 : 13 * LINE)) {
    threads: for (let i = 0; i < n; i++) {
      const thread = item.threads[i]
      if (!thread) continue
      const body = thread.lines.flatMap((l) => flow.wrap(l, 13, false, flow.width - 14))
      // the heading of a comment stays with its first lines
      if (!flow.room(13 * LINE * (1 + Math.min(2, body.length)) + 8) && !continuePage()) {
        cut = n - i
        break
      }
      flow.line(`Comment ${i + 1}`, 13, true, INK)
      for (const l of body) {
        if (!flow.room(13 * LINE) && !continuePage()) {
          // out of pages in the middle of a comment: it and the ones after it are counted
          cut = n - i
          break threads
        }
        flow.line(l, 13, false, INK, flow.left + 14)
      }
      flow.y += 8
    }
  } else {
    cut = n
  }
  if (cut > 0) {
    const text = `${cut} more open comment${cut === 1 ? '' : 's'} ${cut === 1 ? 'is' : 'are'} not shown here. Open the board to read ${cut === 1 ? 'it' : 'them'}.`
    // the note may take the lines kept for the footnote (they sit lower)
    for (const l of flow.wrap(text, 13, true)) flow.line(l, 13, true, STATUS_COLORS.changes_requested.ink)
  }
  if (item.resolvedThreads > 0 && flow.room(13 * LINE + 6)) {
    flow.y += 4
    flow.line(
      `${item.resolvedThreads} resolved comment${item.resolvedThreads === 1 ? '' : 's'} not printed.`,
      12.5,
      false,
      MUTED,
    )
  }
  return { pages, cutThreads: cut }
}

/**
 * The summary on pages: the cover first, then each item's page(s). At most `maxPages` pages (REVIEW_SUMMARY.maxPages):
 * items that do not fit are not drawn and are counted in `notShown` (the cover says so). Every page that names a guest
 * ends with REVIEW_GUEST_FOOTNOTE.
 */
export function layoutSummary(
  model: ReviewSummaryModel,
  pictures: (index: number) => SummaryPicture | null,
  measure: MeasureText,
  opts: LayoutOptions = {},
): { pages: SummaryPage[]; notShown: number; cutThreads: number } {
  const maxPages = opts.maxPages ?? REVIEW_SUMMARY.maxPages
  const date = opts.formatDate ?? defaultDate
  const flow = new Flow(measure)
  layoutCover(flow, model, measure, date)
  const coverPages = flow.pages.length
  const coverEnd = flow.y
  let notShown = 0
  let cutThreads = 0
  for (let i = 0; i < model.items.length; i++) {
    // an item needs one page at least; the pages are counted before it starts
    if (flow.pages.length + 1 > maxPages) {
      notShown = model.items.length - i
      break
    }
    const room = maxPages - flow.pages.length
    const item = model.items[i] as ReviewSummaryModel['items'][number]
    const out = layoutItem(
      flow,
      item,
      i,
      model.items.length,
      pictures(i),
      date,
      Math.min(REVIEW_SUMMARY.pagesPerItem, room),
    )
    cutThreads += out.cutThreads
  }
  if (notShown > 0) {
    // the cover's last page says how many items follow beyond the limit (kept room: the contents list ends with space)
    const last = flow.pages[coverPages - 1] as Page
    const startY = coverEnd + 8
    const text = `${notShown} more item${notShown === 1 ? ' is' : 's are'} not printed: the summary holds at most ${maxPages} pages.`
    let y = startY
    const lines = flow.wrap(text, 13, true)
    for (const l of lines) {
      last.ops.push({
        t: 'text',
        x: flow.left,
        y: y + 13,
        text: l,
        size: 13,
        bold: true,
        fill: STATUS_COLORS.changes_requested.ink,
      })
      y += 13 * LINE
    }
  }
  // the guest footnote: the cover always carries it when the model has one; any other page that names a guest too
  const out: SummaryPage[] = flow.pages.map((p, i) => {
    const names = p.ops.some((o) => o.t === 'text' && o.text.includes('(guest)'))
    const ops: Op[] = [...p.ops]
    if ((i === 0 && model.footnote) || names)
      ops.push({
        t: 'text',
        x: SUMMARY_PAGE.margin,
        y: SUMMARY_PAGE.height - 30,
        text: model.footnote ?? REVIEW_GUEST_FOOTNOTE,
        size: 11,
        bold: false,
        fill: MUTED,
      })
    return { title: p.title, width: SUMMARY_PAGE.width, height: SUMMARY_PAGE.height, ops }
  })
  return { pages: out, notShown, cutThreads }
}
