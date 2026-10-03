// RETRO-05b: the PDF's optional "Vote results" page and "Comments" appendix. What goes on them, and how it
// is laid out on pages. No DOM and no PDF library here (the page is drawn by exporter.ts `renderReportPage`,
// the PDF is assembled by ../pdf-build.ts), so the content rules and the layout are unit-tested in Node.
//
// Rules (docs/REVIEW-2026-09-27.md RETRO-05b):
//  - the results are exactly what this person sees on the board (vote-export.ts `voteResultsForExport`): a
//    vote that was revealed, with its ranking; nothing before the reveal. Voters are never named: nobody,
//    including the server, sends who voted for what.
//  - the comments are the threads this person's own board list holds, which the server already filtered to
//    what they may see: team-only threads reach team members only, and even then they stay out of the file
//    unless the person ticks "Include team-only comments" (a file made for a client must not carry them by
//    accident).
//  - authors: when the board hides note authors (RETRO-03a) the appendix leaves out who wrote each comment.
//  - everything is plain text and bounded: a comment is cut at COMMENT_MAX_CHARS, an item label at
//    LABEL_MAX_CHARS, and a report at MAX_REPORT_PAGES pages (the rest is counted, not drawn).
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import {
  type CommentAnchor,
  type CommentThread,
  commentPlainText,
  type VoteResult,
} from '@draftroom/contracts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import type { PdfPageFormat } from '../pdf-layout.ts'

// ---- limits ----------------------------------------------------------------------------------------------

export const MAX_REPORT_PAGES = 30
export const COMMENT_MAX_CHARS = 1500
export const LABEL_MAX_CHARS = 300

// ---- what goes on the pages ----------------------------------------------------------------------------------

/** One ranked item of the results page. */
export interface ResultRow {
  readonly rank: number
  readonly votes: number
  /** the item's text, its lines joined (as the Voting panel's ranking reads them) */
  readonly label: string
  /** the frame it sits in as a sentence names it (“Roadmap”), or null */
  readonly where: string | null
}

/** What a result row says about an element (null: it is not on the board any more). */
export interface ElementSummary {
  readonly label: string
  readonly where: string | null
}

const clip = (s: string, max: number) => {
  const chars = Array.from(s)
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : s
}

/** One line of plain text from words that may span several lines (a note's lines are joined with " · "). */
export const oneLine = (s: string, max = LABEL_MAX_CHARS) =>
  clip(
    s
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · '),
    max,
  )

/**
 * The result rows in ranking order. A result for an element that was deleted since the reveal is left out
 * (the page says how many); rows keep the server's order (rank, then more votes first).
 */
export function resultRows(
  results: readonly VoteResult[],
  describe: (elementId: string) => ElementSummary | null,
  idOf: (r: VoteResult) => string = (r) => fromShapeRef(String(r.shapeId)) ?? String(r.shapeId),
): { rows: ResultRow[]; missing: number } {
  const rows: ResultRow[] = []
  let missing = 0
  for (const r of results) {
    const d = describe(idOf(r))
    if (!d) {
      missing++
      continue
    }
    rows.push({ rank: r.rank, votes: r.count, label: d.label, where: d.where })
  }
  return { rows, missing }
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** The results page's content: a line on what it is, then one item per ranked row. */
export function resultsBlocks(rows: readonly ResultRow[], missing = 0): ReportBlock[] {
  if (rows.length === 0) return []
  const total = rows.reduce((n, r) => n + r.votes, 0)
  const blocks: ReportBlock[] = [
    {
      kind: 'text',
      text: `${plural(rows.length, 'item')} received votes (${plural(total, 'vote')} in total), most votes first. Items with the same number of votes share a rank.`,
      muted: true,
    },
  ]
  for (const r of rows)
    blocks.push({
      kind: 'item',
      lead: `#${r.rank}`,
      title: r.label,
      meta: `${plural(r.votes, 'vote')}${r.where ? ` · in ${r.where}` : ''}`,
    })
  if (missing > 0)
    blocks.push({
      kind: 'text',
      text: `${plural(missing, 'voted item')} ${missing === 1 ? 'was' : 'were'} deleted from the board and ${missing === 1 ? 'is' : 'are'} not listed.`,
      muted: true,
    })
  return blocks
}

/** One comment of a thread, ready to print. */
export interface ReportComment {
  /** null: the author is left out (the board hides note authors) */
  readonly author: string | null
  readonly date: string
  readonly text: string
}

export interface ReportThread {
  readonly where: string
  readonly status: 'open' | 'resolved'
  readonly teamOnly: boolean
  readonly comments: readonly ReportComment[]
}

export interface CommentsOptions {
  /** the board hides note authors: nobody is named */
  readonly authorsHidden: boolean
  /** team-only threads are in the file */
  readonly teamOnlyIncluded: boolean
  /** "Oct 2, 2026" from a thread's ISO time (default: the browser's locale, en-US) */
  readonly formatDate?: (iso: string) => string
}

const defaultDate = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : ''
}

/** The time a thread's last comment was written (for ordering), 0 when unknown. */
const startedAt = (t: CommentThread) => {
  const at = Date.parse(t.comments[0]?.createdAt ?? t.createdAt)
  return Number.isFinite(at) ? at : 0
}

/**
 * The threads that go in the file: open ones first (the follow-ups), then resolved, each group in the order
 * the conversations started. Team-only threads only when `teamOnlyIncluded`; a thread with no comments left
 * has nothing to print.
 */
export function reportThreads(
  threads: readonly CommentThread[],
  where: (anchor: CommentAnchor) => string,
  opts: CommentsOptions,
): ReportThread[] {
  const format = opts.formatDate ?? defaultDate
  const kept = threads.filter(
    (t) => t.comments.length > 0 && (opts.teamOnlyIncluded || t.visibility !== 'team'),
  )
  const order = (a: CommentThread, b: CommentThread) =>
    startedAt(a) - startedAt(b) || a.id.localeCompare(b.id)
  const sorted = [
    ...kept.filter((t) => t.status === 'open').sort(order),
    ...kept.filter((t) => t.status !== 'open').sort(order),
  ]
  return sorted.map((t) => ({
    where: where(t.anchor),
    status: t.status === 'resolved' ? 'resolved' : 'open',
    teamOnly: t.visibility === 'team',
    comments: t.comments.map((c) => ({
      author: opts.authorsHidden ? null : c.author.name,
      date: format(c.createdAt),
      text: clip(commentPlainText(c.body).trim(), COMMENT_MAX_CHARS),
    })),
  }))
}

/** How many threads the appendix would hold for these options, by status (the dialog's counts). */
export function countReportThreads(
  threads: readonly Pick<CommentThread, 'status' | 'visibility' | 'comments'>[],
  teamOnlyIncluded: boolean,
): { open: number; resolved: number; teamOnly: number } {
  let open = 0
  let resolved = 0
  let teamOnly = 0
  for (const t of threads) {
    if (t.comments.length === 0) continue
    if (t.visibility === 'team') {
      teamOnly++
      if (!teamOnlyIncluded) continue
    }
    if (t.status === 'resolved') resolved++
    else open++
  }
  return { open, resolved, teamOnly }
}

/** The comments appendix's content: what it holds, then "Open" and "Resolved" lists of threads. */
export function commentsBlocks(threads: readonly ReportThread[], opts: CommentsOptions): ReportBlock[] {
  if (threads.length === 0) return []
  const open = threads.filter((t) => t.status === 'open')
  const resolved = threads.filter((t) => t.status === 'resolved')
  const notes = [
    `${plural(open.length, 'open thread')} and ${plural(resolved.length, 'resolved thread')}, each with its replies.`,
  ]
  if (opts.authorsHidden)
    notes.push('This board hides note authors, so the comments are listed without who wrote them.')
  if (opts.teamOnlyIncluded && threads.some((t) => t.teamOnly))
    notes.push('Team-only comments are included and marked: they are internal.')
  const blocks: ReportBlock[] = [{ kind: 'text', text: notes.join(' '), muted: true }]
  let n = 0
  const group = (title: string, list: readonly ReportThread[]) => {
    if (list.length === 0) return
    blocks.push({ kind: 'heading', text: `${title} (${list.length})` })
    for (const t of list)
      blocks.push({
        kind: 'item',
        lead: String(++n),
        title: t.where,
        body: t.comments.map(
          (c) => `${[c.author, c.date].filter(Boolean).join(', ')}${c.author || c.date ? ': ' : ''}${c.text}`,
        ),
        ...(t.teamOnly ? { meta: 'Team only' } : {}),
      })
  }
  group('Open', open)
  group('Resolved', resolved)
  return blocks
}

// ---- describing board elements for both pages ------------------------------------------------------------------

type DescribeCanvas = Pick<LobbyCanvas, 'get' | 'items' | 'bounds'> & {
  text: Pick<LobbyCanvas['text'], 'of'>
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  arrow: 'Arrow',
  line: 'Line',
  freedraw: 'Drawing',
  image: 'Image',
  frame: 'Frame',
  text: 'Text',
  embeddable: 'Embed',
}

/** A live frame’s own name (empty when it has none), or null when `id` is not a live frame. */
const frameName = (canvas: DescribeCanvas, id: string | null | undefined): string | null => {
  if (!id) return null
  const f = canvas.get(id)
  if (!f || f.isDeleted || f.type !== 'frame') return null
  const name = (f as { name?: unknown }).name
  return typeof name === 'string' ? name.trim() : ''
}

/** A frame as a sentence names it: “Roadmap”, or "an untitled frame". */
const frameWords = (name: string | null): string | null =>
  name === null ? null : name ? `“${clip(name, 80)}”` : 'an untitled frame'

/** An element as the pages name it: its words, else its file name, frame name or kind; null when gone. */
export function describeElement(canvas: DescribeCanvas, id: string): ElementSummary | null {
  const el = canvas.get(id)
  if (!el || el.isDeleted) return null
  let label = oneLine(canvas.text.of(id))
  if (!label && el.type === 'frame') label = oneLine(frameName(canvas, id) ?? '')
  if (!label) {
    const file = el.customData?.lobby?.file as { name?: unknown } | undefined
    if (typeof file?.name === 'string' && file.name.trim()) label = oneLine(file.name)
  }
  if (!label) label = KIND_WORDS[el.type] ?? 'Item'
  return { label, where: frameWords(frameName(canvas, el.frameId)) }
}

/** "m:ss" of a video time. */
const clock = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

/** Where a comment thread sits, in words: on an item, at a page of a file, in a frame, or on the board. */
export function describeAnchor(canvas: DescribeCanvas, anchor: CommentAnchor): string {
  if (anchor.kind === 'point') {
    for (const el of canvas.items()) {
      if (el.type !== 'frame' || el.isDeleted) continue
      const b = canvas.bounds(el.id)
      if (b && anchor.x >= b.x && anchor.y >= b.y && anchor.x <= b.x + b.width && anchor.y <= b.y + b.height)
        return `In ${frameWords(frameName(canvas, el.id))}`
    }
    return 'On the board'
  }
  const id = fromShapeRef(anchor.shapeId)
  const d = id ? describeElement(canvas, id) : null
  if (!d) return 'On an item that was removed'
  let at = ''
  if (anchor.kind === 'asset') {
    if (anchor.page) at = `, page ${anchor.page}`
    else if (anchor.timeMs !== undefined) at = `, at ${clock(anchor.timeMs)}`
  }
  return `On “${clip(d.label, 120)}”${at}${d.where ? `, in ${d.where}` : ''}`
}

// ---- pages ---------------------------------------------------------------------------------------------------

export type FontWeight = 'normal' | 'bold'

export type ReportBlock =
  | { kind: 'text'; text: string; muted?: boolean }
  | { kind: 'heading'; text: string }
  | {
      kind: 'item'
      /** the left column: a rank or a number */
      lead: string
      title?: string
      /** paragraphs under the title */
      body?: readonly string[]
      /** a small grey line last */
      meta?: string
    }

/** One line of text on a page: `y` is its line box's top; `w` its measured width (for the hidden text layer). */
export interface ReportLine {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly fontPx: number
  readonly weight: FontWeight
  readonly color: string
  /** the line box's height */
  readonly h: number
}

export interface ReportPage {
  readonly width: number
  readonly height: number
  readonly lines: readonly ReportLine[]
}

/**
 * The page size in px for a PDF page format: A4 portrait for pages sized to their content, and the format's own
 * landscape shape otherwise, so a page is not shrunk into a corner of a landscape page.
 */
export const REPORT_PAGE_PX: Readonly<Record<PdfPageFormat, { width: number; height: number }>> = {
  fit: { width: 794, height: 1123 },
  a4: { width: 1123, height: 794 },
  '16:9': { width: 1280, height: 720 },
}

const INK = '#1b2330'
const MUTED = '#5a6472'
const BODY_PX = 15
const TITLE_PX = 16
const META_PX = 12.5
const HEADING_PX = 19
const LINE = 1.42
const LEAD_W = 64
const ITEM_GAP = 14
const HEAD_GAP = 10

export type Measure = (text: string, fontPx: number, weight: FontWeight) => number

/** Greedy word wrap with a measuring function; a word wider than the line is cut by character. */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const out: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (width(candidate) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      if (width(word) <= maxWidth) {
        line = word
        continue
      }
      let chunk = ''
      for (const ch of Array.from(word)) {
        if (chunk && width(chunk + ch) > maxWidth) {
          out.push(chunk)
          chunk = ch
        } else chunk += ch
      }
      line = chunk
    }
    out.push(line)
  }
  return out
}

interface Row {
  /** what is drawn on it: nothing for a spacer */
  text: string
  fontPx: number
  weight: FontWeight
  color: string
  /** the lead column's text, drawn at the margin on the item's first row */
  lead?: string
  /** a row that may not be the last on a page (a title: its first words stay with the item) */
  keepWithNext?: boolean
  /** height of the row */
  h: number
  /** space before it */
  before: number
  /** indent from the content column's left edge */
  indent: boolean
  /** which block it belongs to (to count what was not drawn) */
  block: number
}

/**
 * Lays blocks out on pages of `width` x `height` px: rows flow from the top margin down, items keep their
 * title with its first line of text, and a page that is full starts the next (at most `maxPages`; what did not
 * fit is counted in `notShown`, items counted by block).
 */
export function layoutReport(
  blocks: readonly ReportBlock[],
  measure: Measure,
  size: { width: number; height: number },
  opts: { maxPages?: number } = {},
): { pages: ReportPage[]; notShown: number } {
  const maxPages = opts.maxPages ?? MAX_REPORT_PAGES
  const margin = Math.round(size.width * 0.07)
  const left = margin
  const contentX = margin + LEAD_W
  const fullW = size.width - margin * 2
  const itemW = size.width - margin - contentX
  const bottom = size.height - margin
  const rows: Row[] = []
  const rowOf = (
    text: string,
    fontPx: number,
    weight: FontWeight,
    color: string,
    block: number,
    extra: Partial<Row> = {},
  ): Row => ({ text, fontPx, weight, color, h: fontPx * LINE, before: 0, indent: false, block, ...extra })
  blocks.forEach((b, bi) => {
    if (b.kind === 'heading') {
      for (const [i, line] of wrapText(b.text, fullW, (s) => measure(s, HEADING_PX, 'bold')).entries())
        rows.push(
          rowOf(line, HEADING_PX, 'bold', INK, bi, {
            before: i === 0 ? ITEM_GAP + HEAD_GAP : 0,
            keepWithNext: true,
          }),
        )
    } else if (b.kind === 'text') {
      for (const [i, line] of wrapText(b.text, fullW, (s) => measure(s, BODY_PX, 'normal')).entries())
        rows.push(
          rowOf(line, BODY_PX, 'normal', b.muted ? MUTED : INK, bi, { before: i === 0 ? HEAD_GAP : 0 }),
        )
    } else {
      let lead: string | undefined = b.lead
      const itemStart = rows.length
      const add = (
        line: string,
        fontPx: number,
        weight: FontWeight,
        color: string,
        extra: Partial<Row> = {},
      ) => {
        const r = rowOf(line, fontPx, weight, color, bi, { indent: true, ...extra })
        if (lead !== undefined) {
          r.lead = lead
          lead = undefined
        }
        rows.push(r)
      }
      if (b.title) {
        const lines = wrapText(b.title, itemW, (s) => measure(s, TITLE_PX, 'bold'))
        for (const [i, line] of lines.entries())
          add(line, TITLE_PX, 'bold', INK, {
            keepWithNext: i === lines.length - 1 && !!(b.body?.length || b.meta),
          })
      }
      for (const [pi, p] of (b.body ?? []).entries()) {
        const lines = wrapText(p, itemW, (s) => measure(s, BODY_PX, 'normal'))
        for (const [i, line] of lines.entries())
          add(line, BODY_PX, 'normal', INK, { before: i === 0 && (pi > 0 || b.title) ? 3 : 0 })
      }
      if (b.meta) add(b.meta, META_PX, 'normal', MUTED, { before: 2 })
      // an item with no title and no text still prints its lead
      if (rows.length === itemStart) add('', BODY_PX, 'normal', INK)
      const firstRow = rows[itemStart]
      if (firstRow) firstRow.before = ITEM_GAP
    }
  })

  const pages: ReportPage[] = []
  let lines: ReportLine[] = []
  let y = margin
  let lastBlockDrawn = -1
  let stopped = false
  const flush = () => {
    if (lines.length) pages.push({ width: size.width, height: size.height, lines })
    lines = []
    y = margin
  }
  for (let i = 0; i < rows.length && !stopped; i++) {
    const r = rows[i] as Row
    const next = rows[i + 1]
    // a row that must stay with the next one needs room for both
    const need = r.h + (r.keepWithNext && next ? next.before + next.h : 0)
    const gap = lines.length === 0 ? 0 : r.before
    if (lines.length > 0 && y + gap + need > bottom) {
      flush()
      if (pages.length >= maxPages) {
        stopped = true
        break
      }
    }
    const top = y + (lines.length === 0 ? 0 : r.before)
    if (r.lead !== undefined)
      lines.push({
        text: r.lead,
        x: left,
        y: top,
        w: measure(r.lead, r.fontPx, 'bold'),
        fontPx: r.fontPx,
        weight: 'bold',
        color: MUTED,
        h: r.h,
      })
    if (r.text)
      lines.push({
        text: r.text,
        x: r.indent ? contentX : left,
        y: top,
        w: measure(r.text, r.fontPx, r.weight),
        fontPx: r.fontPx,
        weight: r.weight,
        color: r.color,
        h: r.h,
      })
    y = top + r.h
    lastBlockDrawn = r.block
  }
  if (!stopped) flush()
  const notShown = stopped ? blocks.slice(lastBlockDrawn + 1).filter((b) => b.kind === 'item').length : 0
  return { pages, notShown }
}
