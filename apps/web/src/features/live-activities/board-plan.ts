// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2.5). The pure plans for "Results to board": what a REVEALED
// activity becomes on the board, as numbers and words (no canvas, no DOM; the measurer is injected: the server's text
// metrics in the app). ./to-board.ts writes a plan in one canvas.transact.
//
//  - a poll: a frame with the question, a line with the date and how many people answered, and one row per option
//    (its words, a bar as long as its count says over the largest, the count and its share);
//  - a scale: the same head, one column per value from min to max (a bar as tall as its count, the count over it,
//    the value under it), the end labels, the average and the median;
//  - a word cloud: the same head over ./word-cloud-layout.ts's cloud; or "as sticky notes", one note per word with
//    its count, in rows.
// Every plan is built from aggregates only (the results everyone sees once revealed): nothing here can name who
// answered what.

import { LOBBY_INK, LOBBY_PALETTE } from '@draftroom/board-ops/elements'
import type { PollResults, ScaleResults, WordsResults } from '@draftroom/contracts'
import { fitLines } from '../workshops/results-plan.ts'
import { CLOUD_FONT_FAMILY, layoutWordCloud, type Measure } from './word-cloud-layout.ts'

export type { Measure }

/** Lobby's sans (Nunito): every text a plan makes. */
export const PLAN_FONT = CLOUD_FONT_FAMILY

export interface PlanText {
  readonly text: string
  /** relative to the frame's top left: the text's left edge (also for a centred one) */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fontSize: number
  readonly align: 'left' | 'center'
  /** a literal Lobby palette value */
  readonly color: string
}

export interface PlanRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fill: string
  readonly stroke: string
}

export interface PlanNote {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly fill: string
}

export interface BoardPlan {
  readonly frameName: string
  readonly width: number
  readonly height: number
  readonly rects: readonly PlanRect[]
  readonly texts: readonly PlanText[]
  readonly notes: readonly PlanNote[]
  /** results left off (options never are; words past the cloud's cap or without a place) */
  readonly left: number
}

const PAD = 32
const TITLE_SIZE = 24
const TITLE_LINES = 3
const SUB_SIZE = 16
const LABEL_SIZE = 16
const COUNT_SIZE = 16
const GAP = 12
const MIN_FRAME_W = 420
/** The longest a frame name gets (code points; the schema allows 200). */
export const FRAME_NAME_MAX = 80

const round2 = (n: number) => Math.round(n * 100) / 100
const MUTED = LOBBY_PALETTE.grey.solid
const TOP = LOBBY_PALETTE.yellow
const REST = LOBBY_PALETTE['light-blue']

/** "1 person answered" / "12 people answered" */
export const answeredText = (n: number) => `${n} ${n === 1 ? 'person' : 'people'} answered`

/** At most `max` code points, with an ellipsis when cut. */
export function clip(s: string, max: number): string {
  const cps = [...s]
  return cps.length <= max
    ? s
    : `${cps
        .slice(0, Math.max(1, max - 1))
        .join('')
        .trimEnd()}…`
}

/** "Poll: Which day?" cut to FRAME_NAME_MAX. */
export const frameNameOf = (kind: string, prompt: string) => clip(`${kind}: ${prompt}`, FRAME_NAME_MAX)

/** The head every plan starts with: the question (wrapped) and the date · answered line. Returns its bottom. */
function head(
  texts: PlanText[],
  m: (text: string, size: number) => { width: number; height: number },
  prompt: string,
  subtitle: string,
  width: number,
): number {
  const lines = fitLines(prompt, width, TITLE_LINES, (l) => m(l, TITLE_SIZE).width).join('\n')
  const t = m(lines, TITLE_SIZE)
  texts.push({
    text: lines,
    x: PAD,
    y: PAD,
    width: Math.ceil(t.width),
    height: Math.ceil(t.height),
    fontSize: TITLE_SIZE,
    align: 'left',
    color: LOBBY_INK,
  })
  const subY = PAD + Math.ceil(t.height) + 6
  const s = m(subtitle, SUB_SIZE)
  texts.push({
    text: subtitle,
    x: PAD,
    y: subY,
    width: Math.ceil(s.width),
    height: Math.ceil(s.height),
    fontSize: SUB_SIZE,
    align: 'left',
    color: MUTED,
  })
  return subY + Math.ceil(s.height)
}

const measureWith =
  (measure: Measure) =>
  (text: string, fontSize: number): { width: number; height: number } =>
    measure(text, { fontFamily: PLAN_FONT, fontSize })

// ---- a poll ------------------------------------------------------------------------------------------------------

const POLL_LABEL_W = 260
const POLL_BAR_MAX_W = 360
const POLL_BAR_H = 32
const POLL_BAR_MIN_W = 4

/** The share of `count` in `answered`, a whole percent ("57%"); 0 answers: "0%". */
export const shareText = (count: number, answered: number) =>
  `${answered > 0 ? Math.round((count / answered) * 100) : 0}%`

export function pollPlan(input: {
  prompt: string
  options: readonly string[]
  results: PollResults
  dateText: string
  measure: Measure
}): BoardPlan {
  const m = measureWith(input.measure)
  const { results } = input
  const texts: PlanText[] = []
  const rects: PlanRect[] = []
  const counts = input.options.map((_, i) => results.counts[i] ?? 0)
  const max = Math.max(0, ...counts)
  const countTexts = counts.map((c) => `${c} · ${shareText(c, results.answered)}`)
  const countW = Math.max(...countTexts.map((t) => Math.ceil(m(t, COUNT_SIZE).width)), 40)
  const innerW = POLL_LABEL_W + 16 + POLL_BAR_MAX_W + 12 + countW
  let y = head(texts, m, input.prompt, `${input.dateText} · ${answeredText(results.answered)}`, innerW) + 24
  counts.forEach((count, i) => {
    const label = fitLines(input.options[i] ?? '', POLL_LABEL_W, 2, (l) => m(l, LABEL_SIZE).width).join('\n')
    const lb = m(label, LABEL_SIZE)
    const rowH = Math.max(POLL_BAR_H, Math.ceil(lb.height))
    texts.push({
      text: label,
      x: PAD,
      y: round2(y + (rowH - Math.ceil(lb.height)) / 2),
      width: Math.ceil(lb.width),
      height: Math.ceil(lb.height),
      fontSize: LABEL_SIZE,
      align: 'left',
      color: LOBBY_INK,
    })
    const barX = PAD + POLL_LABEL_W + 16
    const barY = round2(y + (rowH - POLL_BAR_H) / 2)
    const w = max > 0 && count > 0 ? round2(Math.max(POLL_BAR_MIN_W, (count / max) * POLL_BAR_MAX_W)) : 0
    const tone = count > 0 && count === max ? TOP : REST
    if (w > 0)
      rects.push({ x: barX, y: barY, width: w, height: POLL_BAR_H, fill: tone.fill, stroke: tone.solid })
    const ct = countTexts[i] ?? ''
    const cb = m(ct, COUNT_SIZE)
    texts.push({
      text: ct,
      x: round2(barX + w + 12),
      y: round2(y + (rowH - Math.ceil(cb.height)) / 2),
      width: Math.ceil(cb.width),
      height: Math.ceil(cb.height),
      fontSize: COUNT_SIZE,
      align: 'left',
      color: LOBBY_INK,
    })
    y += rowH + GAP
  })
  return {
    frameName: frameNameOf('Poll', input.prompt),
    width: Math.ceil(Math.max(MIN_FRAME_W, PAD * 2 + innerW)),
    height: Math.ceil(y - GAP + PAD),
    rects,
    texts,
    notes: [],
    left: 0,
  }
}

// ---- a scale -----------------------------------------------------------------------------------------------------

const SCALE_COL_W = 56
const SCALE_BAR_W = 36
const SCALE_BAR_MAX_H = 200
const SCALE_BAR_MIN_H = 4

/** "3.4" (results carry 2 decimals; one is enough to read). */
export const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toString()

/** The scale's summary: "average 3.4 · median 4", or "no answers". */
export function scaleSummary(r: Pick<ScaleResults, 'mean' | 'median'>): string {
  if (r.mean === null || r.median === null) return 'no answers'
  return `average ${oneDecimal(r.mean)} · median ${oneDecimal(r.median)}`
}

export function scalePlan(input: {
  prompt: string
  min: number
  max: number
  minLabel: string | null
  maxLabel: string | null
  results: ScaleResults
  dateText: string
  measure: Measure
}): BoardPlan {
  const m = measureWith(input.measure)
  const { results } = input
  const texts: PlanText[] = []
  const rects: PlanRect[] = []
  const values = Array.from({ length: input.max - input.min + 1 }, (_, i) => input.min + i)
  const counts = values.map((_, i) => results.counts[i] ?? 0)
  const top = Math.max(0, ...counts)
  const colsW = values.length * SCALE_COL_W
  const endLeft = input.minLabel ? `${input.min} = ${input.minLabel}` : ''
  const endRight = input.maxLabel ? `${input.max} = ${input.maxLabel}` : ''
  const endsW = Math.ceil(m(endLeft, LABEL_SIZE).width) + Math.ceil(m(endRight, LABEL_SIZE).width) + 24
  const innerW = Math.max(colsW, endsW)
  const subtitle = `${input.dateText} · ${answeredText(results.answered)} · ${scaleSummary(results)}`
  const headBottom = head(texts, m, input.prompt, subtitle, Math.max(innerW, 360))
  const countH = Math.ceil(m('0', COUNT_SIZE).height) + 4
  const baseline = headBottom + 24 + countH + SCALE_BAR_MAX_H
  values.forEach((v, i) => {
    const count = counts[i] ?? 0
    const cx = PAD + i * SCALE_COL_W + SCALE_COL_W / 2
    const h = top > 0 && count > 0 ? round2(Math.max(SCALE_BAR_MIN_H, (count / top) * SCALE_BAR_MAX_H)) : 0
    const tone = count > 0 && count === top ? TOP : REST
    if (h > 0)
      rects.push({
        x: round2(cx - SCALE_BAR_W / 2),
        y: round2(baseline - h),
        width: SCALE_BAR_W,
        height: h,
        fill: tone.fill,
        stroke: tone.solid,
      })
    const ct = String(count)
    const cb = m(ct, COUNT_SIZE)
    texts.push({
      text: ct,
      x: round2(cx - cb.width / 2),
      y: round2(baseline - h - countH),
      width: Math.ceil(cb.width),
      height: Math.ceil(cb.height),
      fontSize: COUNT_SIZE,
      align: 'center',
      color: LOBBY_INK,
    })
    const vt = String(v)
    const vb = m(vt, LABEL_SIZE)
    texts.push({
      text: vt,
      x: round2(cx - vb.width / 2),
      y: baseline + 8,
      width: Math.ceil(vb.width),
      height: Math.ceil(vb.height),
      fontSize: LABEL_SIZE,
      align: 'center',
      color: LOBBY_INK,
    })
  })
  let bottom = baseline + 8 + Math.ceil(m('0', LABEL_SIZE).height)
  if (endLeft || endRight) {
    const y = bottom + 8
    let h = 0
    if (endLeft) {
      const b = m(endLeft, LABEL_SIZE)
      h = Math.max(h, Math.ceil(b.height))
      texts.push({
        text: endLeft,
        x: PAD,
        y,
        width: Math.ceil(b.width),
        height: Math.ceil(b.height),
        fontSize: LABEL_SIZE,
        align: 'left',
        color: MUTED,
      })
    }
    if (endRight) {
      const b = m(endRight, LABEL_SIZE)
      h = Math.max(h, Math.ceil(b.height))
      texts.push({
        text: endRight,
        x: round2(PAD + innerW - Math.ceil(b.width)),
        y,
        width: Math.ceil(b.width),
        height: Math.ceil(b.height),
        fontSize: LABEL_SIZE,
        align: 'left',
        color: MUTED,
      })
    }
    bottom = y + h
  }
  return {
    frameName: frameNameOf('Scale', input.prompt),
    width: Math.ceil(Math.max(MIN_FRAME_W, PAD * 2 + Math.max(innerW, 360))),
    height: Math.ceil(bottom + PAD),
    rects,
    texts,
    notes: [],
    left: 0,
  }
}

// ---- a word cloud ------------------------------------------------------------------------------------------------

/** The palette value of a cloud colour name. */
const solidOf = (name: keyof typeof LOBBY_PALETTE) =>
  name === 'black' ? LOBBY_INK : LOBBY_PALETTE[name].solid

export function cloudPlan(input: {
  prompt: string
  results: WordsResults
  dateText: string
  measure: Measure
  seed: number
}): BoardPlan {
  const m = measureWith(input.measure)
  const cloud = layoutWordCloud({ words: input.results.words, measure: input.measure, seed: input.seed })
  const texts: PlanText[] = []
  const innerW = Math.max(cloud.width, 360)
  const top =
    head(texts, m, input.prompt, `${input.dateText} · ${answeredText(input.results.answered)}`, innerW) + 32
  const dx = PAD + (innerW - cloud.width) / 2
  for (const w of cloud.words)
    texts.push({
      text: w.text,
      x: round2(dx + w.x),
      y: round2(top + w.y),
      width: w.width,
      height: w.height,
      fontSize: w.fontSize,
      align: 'left',
      color: solidOf(w.color),
    })
  // words past the top list (results carry 100) count as left off too
  const left = cloud.left + Math.max(0, input.results.distinct - input.results.words.length)
  return {
    frameName: frameNameOf('Word cloud', input.prompt),
    width: Math.ceil(Math.max(MIN_FRAME_W, PAD * 2 + innerW)),
    height: Math.ceil(top + cloud.height + PAD),
    rects: [],
    texts,
    notes: [],
    left,
  }
}

/** One note's words: "agile (5)". */
export const noteTextOf = (w: { text: string; count: number }) => `${w.text} (${w.count})`

const NOTE_SIDE = 200
const NOTE_GAP = 24
const NOTES_PER_ROW = 6

/** "As sticky notes": one note per word (the cloud's words, in its order: highest count first), six to a row. */
export function notesPlan(input: {
  prompt: string
  results: WordsResults
  dateText: string
  measure: Measure
  maxNotes: number
}): BoardPlan {
  const m = measureWith(input.measure)
  const words = input.results.words.slice(0, Math.max(0, input.maxNotes))
  const cols = Math.max(1, Math.min(NOTES_PER_ROW, words.length))
  const innerW = cols * NOTE_SIDE + (cols - 1) * NOTE_GAP
  const texts: PlanText[] = []
  const top =
    head(texts, m, input.prompt, `${input.dateText} · ${answeredText(input.results.answered)}`, innerW) + 24
  const notes: PlanNote[] = words.map((w, i) => ({
    text: noteTextOf(w),
    x: PAD + (i % cols) * (NOTE_SIDE + NOTE_GAP),
    y: top + Math.floor(i / cols) * (NOTE_SIDE + NOTE_GAP),
    fill: LOBBY_PALETTE.yellow.noteFill,
  }))
  const rows = Math.max(1, Math.ceil(words.length / cols))
  return {
    frameName: frameNameOf('Word cloud', input.prompt),
    width: Math.ceil(Math.max(MIN_FRAME_W, PAD * 2 + innerW)),
    height: Math.ceil(top + rows * NOTE_SIDE + (rows - 1) * NOTE_GAP + PAD),
    rects: [],
    texts,
    notes,
    left: Math.max(0, input.results.distinct - words.length),
  }
}
