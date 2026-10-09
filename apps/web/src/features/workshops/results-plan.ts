// OWNER: W5 (wave L, L5-3 vote results that move the meeting). The pure plans for turning a revealed vote into
// board content: the results chart ("Results to board"), the winners' layout ("Gather the winners") and where
// they go (free space beside what was voted on). Plans are numbers and words only: no canvas, no DOM, the text
// measurer is injected (`canvas.text.measure`, the server's metrics, in the app). Unit-tested in Node
// (results-plan.test.ts); ./ported/vote-board.ts writes them to the board in one transact.
//
// Ballots stay secret until the reveal: a plan is built from a REVEALED vote's results only (the panel offers
// the actions then), and nothing here ever sees who voted for what.

import { LOBBY_PALETTE } from '@draftroom/board-ops/elements'
import { findEmptySpot, type Rect as SpotRect } from '../canvas-ux/placement.ts'

/** Lobby's sans (Nunito), the font of every text the plans make. */
export const PLAN_FONT_FAMILY = 6

export interface Measured {
  readonly width: number
  readonly height: number
}
export type Measure = (text: string, style: { fontFamily: number; fontSize: number }) => Measured

/** One text of a plan: its words (lines joined with a newline), size and place (relative to its frame). */
export interface PlanText {
  readonly kind: 'subtitle' | 'count' | 'label' | 'more' | 'rank'
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fontSize: number
  readonly align: 'left' | 'center'
}

export interface PlanBar {
  readonly ref: string
  readonly rank: number
  readonly count: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fill: string
  readonly stroke: string
}

// ---- the chart ---------------------------------------------------------------------------------------------------

/** The most bars one chart holds (the rest are said in a line under it). */
export const CHART_MAX_BARS = 20
const PAD = 32
const COL_W = 120
const COL_GAP = 16
const BAR_W = 64
/** The tallest bar (the top result). */
export const CHART_BAR_MAX_H = 240
/** A bar is never thinner than this, so a single vote among hundreds still shows. */
const BAR_MIN_H = 4
const MIN_FRAME_W = 360
const SUBTITLE_SIZE = 18
const COUNT_SIZE = 20
const LABEL_SIZE = 14
const LABEL_LINES = 3
const GAP = 10

export interface ChartResult {
  readonly ref: string
  readonly count: number
  readonly rank: number
  /** the voted object's words (labelOfRef) */
  readonly label: string
}

export interface ResultsPlan {
  /** the frame's name: "Results: Dot vote" */
  readonly frameName: string
  readonly width: number
  readonly height: number
  readonly bars: readonly PlanBar[]
  readonly texts: readonly PlanText[]
  /** results that did not fit the chart (beyond CHART_MAX_BARS) */
  readonly left: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const ELLIPSIS = '…'

/**
 * `text` wrapped to `maxWidth` in at most `maxLines` lines (greedy by words). What does not fit is cut with an
 * ellipsis: the words left over after the last line, and a word wider than a line. Never more than `maxLines`
 * lines, never a line wider than `maxWidth` (so long labels cannot run into the next bar's).
 */
export function fitLines(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (line: string) => number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  /** `s`, or its start with an ellipsis when it is wider than a line (`ellipsis`: always end with one). */
  const fit = (s: string, ellipsis = false): string => {
    const whole = ellipsis ? `${s}${ELLIPSIS}` : s
    if (measure(whole) <= maxWidth) return whole
    let n = s.length
    while (n > 1 && measure(`${s.slice(0, n).trimEnd()}${ELLIPSIS}`) > maxWidth) n--
    return `${s.slice(0, n).trimEnd()}${ELLIPSIS}`
  }
  const lines: string[] = []
  let line = ''
  let overflow = false
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    // a word alone on a line stays (it is cut below when it is wider than a line)
    if (!line || measure(next) <= maxWidth) {
      line = next
      continue
    }
    lines.push(line)
    if (lines.length === maxLines) {
      overflow = true
      break
    }
    line = word
  }
  if (!overflow && line) lines.push(line)
  return lines.map((l, i) => fit(l, overflow && i === lines.length - 1))
}

/** "5 people voted" / "1 person voted" */
export const votedText = (participants: number) =>
  `${participants} ${participants === 1 ? 'person' : 'people'} voted`

/**
 * The results chart: a frame named after the vote, a line with the date and how many people voted, and one bar
 * per result (best first, ties side by side with the same rank), each as tall as its count says over the
 * tallest, with its count above it and its words under it (cut when long). Positions are relative to the
 * frame's top left. Null when there is nothing to chart.
 */
export function resultsPlan(input: {
  title: string
  dateText: string
  participants: number
  results: readonly ChartResult[]
  measure: Measure
}): ResultsPlan | null {
  const shown = input.results.slice(0, CHART_MAX_BARS)
  if (shown.length === 0) return null
  const m = (text: string, fontSize: number) =>
    input.measure(text, { fontFamily: PLAN_FONT_FAMILY, fontSize })
  const texts: PlanText[] = []

  const subtitle = `${input.dateText} · ${votedText(input.participants)}`
  const sub = m(subtitle, SUBTITLE_SIZE)
  texts.push({
    kind: 'subtitle',
    text: subtitle,
    x: PAD,
    y: PAD,
    width: Math.ceil(sub.width),
    height: Math.ceil(sub.height),
    fontSize: SUBTITLE_SIZE,
    align: 'left',
  })
  const countH = Math.ceil(m('0', COUNT_SIZE).height) + 6
  const top = PAD + Math.ceil(sub.height) + 20
  const baseline = top + countH + CHART_BAR_MAX_H
  const maxCount = Math.max(...shown.map((r) => r.count))
  const unit = CHART_BAR_MAX_H / maxCount

  const bars: PlanBar[] = []
  let labelsH = 0
  shown.forEach((r, i) => {
    const colX = PAD + i * (COL_W + COL_GAP)
    const cx = colX + COL_W / 2
    const h = round2(Math.max(BAR_MIN_H, r.count * unit))
    const first = r.rank === 1
    const tone = first ? LOBBY_PALETTE.yellow : LOBBY_PALETTE['light-blue']
    bars.push({
      ref: r.ref,
      rank: r.rank,
      count: r.count,
      x: round2(cx - BAR_W / 2),
      y: round2(baseline - h),
      width: BAR_W,
      height: h,
      fill: tone.fill,
      stroke: tone.solid,
    })
    const num = m(String(r.count), COUNT_SIZE)
    texts.push({
      kind: 'count',
      text: String(r.count),
      x: round2(cx - num.width / 2),
      y: round2(baseline - h - countH),
      width: Math.ceil(num.width),
      height: Math.ceil(num.height),
      fontSize: COUNT_SIZE,
      align: 'center',
    })
    const lines = fitLines(`#${r.rank} ${r.label}`, COL_W - 8, LABEL_LINES, (l) => m(l, LABEL_SIZE).width)
    const words = lines.join('\n')
    const box = m(words, LABEL_SIZE)
    labelsH = Math.max(labelsH, Math.ceil(box.height))
    texts.push({
      kind: 'label',
      text: words,
      x: round2(cx - box.width / 2),
      y: baseline + GAP,
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
      fontSize: LABEL_SIZE,
      align: 'center',
    })
  })

  let height = baseline + GAP + labelsH + PAD
  const left = input.results.length - shown.length
  if (left > 0) {
    const more = `and ${left} more result${left === 1 ? '' : 's'} not charted`
    const box = m(more, LABEL_SIZE)
    texts.push({
      kind: 'more',
      text: more,
      x: PAD,
      y: height - PAD + GAP,
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
      fontSize: LABEL_SIZE,
      align: 'left',
    })
    height += Math.ceil(box.height) + GAP
  }
  const width = Math.max(MIN_FRAME_W, PAD * 2 + shown.length * COL_W + (shown.length - 1) * COL_GAP)
  return { frameName: `Results: ${input.title}`, width, height: Math.ceil(height), bars, texts, left }
}

// ---- the winners -----------------------------------------------------------------------------------------------------

/** What a vote's winners are, for "Gather the winners": the top results that can be gathered. */
export interface Winner {
  readonly ref: string
  readonly id: string
  readonly rank: number
  readonly count: number
}

export interface WinnerCandidate {
  readonly ref: string
  readonly count: number
  readonly rank: number
  /** the element id, or null when the ref names nothing */
  readonly id: string | null
  /** still on the board (not deleted) */
  readonly live: boolean
  /** a frame (frames do not nest, so they are not gathered) */
  readonly frame: boolean
  /** locked, or in a locked frame (the server refuses a write to it) */
  readonly locked: boolean
}

/**
 * The top `n` results as winners, in rank order, ties at the cut-off included (nobody who shares third place is
 * left out). Results that cannot be gathered are counted, not silently dropped: gone, a frame, locked.
 */
export function winnersOf(
  candidates: readonly WinnerCandidate[],
  n: number,
): { winners: Winner[]; skipped: { gone: number; frames: number; locked: number } } {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank)
  const cut = sorted[n - 1]
  const top = cut ? sorted.filter((c, i) => i < n || c.rank <= cut.rank) : sorted
  const winners: Winner[] = []
  const skipped = { gone: 0, frames: 0, locked: 0 }
  for (const c of top) {
    if (!c.id || !c.live) skipped.gone++
    else if (c.frame) skipped.frames++
    else if (c.locked) skipped.locked++
    else winners.push({ ref: c.ref, id: c.id, rank: c.rank, count: c.count })
  }
  return { winners, skipped }
}

export interface WinnerPlace {
  readonly winner: Winner
  /** where the object's top left goes (relative to the frame) */
  readonly x: number
  readonly y: number
  /** the rank line above it */
  readonly rank: PlanText
}

export interface WinnersPlan {
  readonly frameName: string
  readonly width: number
  readonly height: number
  readonly places: readonly WinnerPlace[]
}

const RANK_SIZE = 16
const WIN_GAP = 40
export const TOP_IDEAS_NAME = 'Top ideas'

/** "#1 · 5 votes" */
export const rankLine = (rank: number, count: number) => `#${rank} · ${count} vote${count === 1 ? '' : 's'}`

/**
 * The 'Top ideas' frame: the winners side by side in rank order, each under a "#1 · 5 votes" line, tops
 * aligned. `sizeOf` gives an object's size on the board. Null when there are no winners.
 */
export function winnersPlan(input: {
  winners: readonly Winner[]
  sizeOf(id: string): { width: number; height: number } | null
  measure: Measure
}): WinnersPlan | null {
  const items = input.winners.flatMap((w) => {
    const size = input.sizeOf(w.id)
    return size ? [{ w, size }] : []
  })
  if (items.length === 0) return null
  const m = (text: string) => input.measure(text, { fontFamily: PLAN_FONT_FAMILY, fontSize: RANK_SIZE })
  const rankH = Math.ceil(m('#').height)
  const places: WinnerPlace[] = []
  let x = PAD
  let tallest = 0
  for (const { w, size } of items) {
    const line = rankLine(w.rank, w.count)
    const box = m(line)
    const colW = Math.max(size.width, Math.ceil(box.width))
    places.push({
      winner: w,
      x: round2(x + (colW - size.width) / 2),
      y: PAD + rankH + GAP,
      rank: {
        kind: 'rank',
        text: line,
        x: round2(x + (colW - box.width) / 2),
        y: PAD,
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
        fontSize: RANK_SIZE,
        align: 'center',
      },
    })
    tallest = Math.max(tallest, size.height)
    x += colW + WIN_GAP
  }
  return {
    frameName: TOP_IDEAS_NAME,
    width: Math.ceil(Math.max(MIN_FRAME_W, x - WIN_GAP + PAD)),
    height: Math.ceil(PAD + rankH + GAP + tallest + PAD),
    places,
  }
}

// ---- where it goes -----------------------------------------------------------------------------------------------------

/** Room kept clear around a new frame (scene px); the frame's name label sits just over its top edge. */
export const PLACE_GAP = 80

/**
 * Where a new block of `size` goes: beside what was voted on (`scope`: its bounds, null for the whole board's
 * content), to its right and level with its top, moved to the nearest free spot that keeps PLACE_GAP clear of
 * every `obstacles` rectangle. Never overlaps one of them.
 */
export function placeBeside(
  size: { w: number; h: number },
  scope: SpotRect | null,
  obstacles: readonly SpotRect[],
): { x: number; y: number } {
  const edge = scope ?? union(obstacles)
  const center = edge
    ? { x: edge.x + edge.w + PLACE_GAP + size.w / 2, y: edge.y + size.h / 2 }
    : { x: size.w / 2, y: size.h / 2 }
  return findEmptySpot(size, center, obstacles, { gap: PLACE_GAP })
}

function union(rects: readonly SpotRect[]): SpotRect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return minX === Number.POSITIVE_INFINITY ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
