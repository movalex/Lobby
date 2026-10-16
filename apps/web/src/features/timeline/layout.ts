// OWNER: WS5 (wave T, docs/WAVE-T-CONTRACTS.md §2 and the design's §5). The timeline's layout, pure: a timeline frame's
// value (range, scale, lanes), the cards of the board and today go in; the ruler, the lanes and the bars come out, in
// the FRAME's own coordinates (0,0 is the frame's top-left, scene units). Nothing here reads the canvas or writes:
// the board page draws it as an overlay (./Overlay.tsx) and exports draw the same layout as SVG (./export.ts), so the
// two cannot disagree. A bar is never stored: its geometry is what two card keys (`card:start`, `card:due`) and the
// frame's `timeline` value say, so two clients with the same converged keys draw the same bars.
import {
  addDays,
  CARD_STATUS_LABELS,
  CARD_STATUSES,
  type CardStatus,
  dateToX,
  isOverdue,
  isPlanningDate,
  snapDate,
  type TimelineValue,
  timelineDays,
  timelineTicks,
} from '@draftroom/canvas-schema/planning'
import { MONTHS, MONTHS_LONG, partsOf } from './dates.ts'

/** One card as the timeline reads it (./cards.ts makes them from the canvas). */
export interface TimelineCard {
  readonly id: string
  readonly title: string
  readonly status: CardStatus
  readonly who: string | null
  readonly start: string | null
  readonly due: string | null
  /** the card's tags (key and the board's name for it), in name order */
  readonly tags: readonly { readonly key: string; readonly name: string }[]
  /** a locked card takes no planning write (no lock exemption) */
  readonly locked: boolean
}

export const MAX_BARS = 500

// ---- geometry constants (scene units) -------------------------------------------------------------------------------
export const RULER_TOP_H = 22
export const RULER_H = 48
export const LABEL_W = 132
export const BAR_H = 22
export const ROW_STEP = 28
export const LANE_PAD = 6
export const MILESTONE_HALF = 9
export const MIN_BAR_W = 6
export const BAR_FONT = 12
export const RULER_FONT = 11

/** The average advance of a character of a UI sans-serif, as a fraction of the font size (a safe over-estimate). */
export const CHAR_EM = 0.56
export const textWidth = (s: string, size: number): number => s.length * size * CHAR_EM

/** `s` cut to fit `maxW` (with an ellipsis), or '' when not even a few letters fit. */
export function fitText(s: string, maxW: number, size: number): string {
  if (textWidth(s, size) <= maxW) return s
  const n = Math.floor(maxW / (size * CHAR_EM)) - 1
  return n >= 2 ? `${s.slice(0, n).trimEnd()}…` : ''
}

export interface Frame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LayoutInput {
  readonly t: TimelineValue
  /** the frame's size (its position is only the caller's) */
  readonly size: { readonly width: number; readonly height: number }
  readonly cards: readonly TimelineCard[]
  /** today, `YYYY-MM-DD` (the viewer's) */
  readonly today: string
  /**
   * uid → name for the assignee lanes: null while the members are not known yet (the lane says "Assigned"); a uid
   * missing from a loaded map is a person who is no longer on the board.
   */
  readonly names?: ReadonlyMap<string, string> | null
  readonly maxBars?: number
}

export interface Tick {
  readonly x: number
  readonly w: number
  readonly date: string
  readonly label: string
  readonly major: boolean
}
export interface Span {
  readonly x: number
  readonly w: number
  readonly label: string
}
export interface Lane {
  readonly key: string
  readonly label: string | null
  readonly y: number
  readonly h: number
  /** the lane's band is cut by the frame's bottom edge */
  readonly cut: boolean
}

export type BarKind = 'bar' | 'milestone'
export interface Bar {
  readonly id: string
  readonly kind: BarKind
  readonly card: TimelineCard
  readonly lane: number
  readonly row: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** the label, cut to fit; drawn inside a bar that has room, else to the right of the bar */
  readonly label: string
  readonly labelInside: boolean
  readonly clippedLeft: boolean
  readonly overdue: boolean
}

export interface Layout {
  readonly width: number
  readonly height: number
  /** the date axis: x of its left edge and its width */
  readonly axis: { readonly x: number; readonly w: number }
  readonly months: readonly Span[]
  readonly ticks: readonly Tick[]
  readonly lanes: readonly Lane[]
  readonly bars: readonly Bar[]
  /** the today marker's x, or null when today is outside the range */
  readonly todayX: number | null
  /** the cards in range (before the cap) */
  readonly inRange: number
  /** drawn */
  readonly shown: number
  /** cut by the cap */
  readonly capped: number
  /** cards in range that do not fit under the frame's bottom edge */
  readonly below: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The month name row: months for days and weeks, years for months. */
function monthSpans(t: TimelineValue, axis: { x: number; w: number }): Span[] {
  const out: Span[] = []
  const frame = { x: axis.x, width: axis.w }
  let at = t.start
  for (let i = 0; i < 40 && at <= t.end; i++) {
    const p = partsOf(at)
    if (!p) break
    const unitEnd =
      t.scale === 'month'
        ? `${p.y}-12-31`
        : `${p.y}-${pad2(p.m)}-${pad2(new Date(Date.UTC(p.y, p.m, 0)).getUTCDate())}`
    const last = unitEnd < t.end ? unitEnd : t.end
    const x1 = dateToX(t, frame, at)
    const x2 = dateToX(t, frame, addDays(last, 1) ?? last)
    const w = x2 - x1
    const long = t.scale === 'month' ? String(p.y) : `${MONTHS_LONG[p.m - 1]} ${p.y}`
    const short = t.scale === 'month' ? String(p.y) : `${MONTHS[p.m - 1]} ${p.y}`
    const label =
      textWidth(long, RULER_FONT) + 8 <= w ? long : textWidth(short, RULER_FONT) + 8 <= w ? short : ''
    out.push({ x: x1, w, label })
    const next = addDays(last, 1)
    if (!next) break
    at = next
  }
  return out
}

/** The ruler's ticks with the labels that fit (the finer scales thin out their labels as they get narrow). */
function rulerTicks(t: TimelineValue, axis: { x: number; w: number }): Tick[] {
  const frame = { x: axis.x, width: axis.w }
  const dates = timelineTicks(t)
  const xs = dates.map((d) => dateToX(t, frame, d))
  const unitPx = timelineDays(t) > 0 ? axis.w / timelineDays(t) : 0
  return dates.map((date, i) => {
    const x = xs[i] as number
    const w = (xs[i + 1] ?? axis.x + axis.w) - x
    const p = partsOf(date)
    const monthStart = p?.d === 1
    let label = ''
    if (p) {
      if (t.scale === 'day') {
        if (unitPx >= 16) label = String(p.d)
        else if (snapDate(date, 'week') === date && unitPx * 7 >= 30) label = String(p.d)
        else if (monthStart && unitPx * 30 >= 26) label = MONTHS[p.m - 1] as string
      } else if (t.scale === 'week') {
        if (w >= 46) label = `${p.d} ${MONTHS[p.m - 1]}`
        else if (w >= 22) label = String(p.d)
        else if (monthStart && w * 4 >= 26) label = MONTHS[p.m - 1] as string
      } else {
        label = w >= 26 ? (MONTHS[p.m - 1] as string) : w >= 12 ? (MONTHS[p.m - 1] as string).slice(0, 1) : ''
      }
    }
    // a label drawn at x must not run into the next tick's
    if (label && textWidth(label, RULER_FONT) + 6 > w && t.scale !== 'day') label = ''
    return { x, w, date, label, major: t.scale === 'month' ? p?.m === 1 : monthStart === true }
  })
}

interface LaneSpec {
  readonly key: string
  readonly label: string | null
}

/** The lanes the cards need, in order, and which one each card goes to. */
function laneSpecs(
  t: TimelineValue,
  cards: readonly TimelineCard[],
  names: ReadonlyMap<string, string> | null | undefined,
): { specs: LaneSpec[]; laneOf: (c: TimelineCard) => string } {
  if (t.lanes === 'none') return { specs: [{ key: '', label: null }], laneOf: () => '' }
  if (t.lanes === 'status') {
    const used = new Set(cards.map((c) => c.status))
    return {
      specs: CARD_STATUSES.filter((s) => used.has(s)).map((s) => ({ key: s, label: CARD_STATUS_LABELS[s] })),
      laneOf: (c) => c.status,
    }
  }
  if (t.lanes === 'assignee') {
    const keys = [...new Set(cards.map((c) => c.who ?? ''))]
    const nameOf = (k: string) =>
      k === '' ? 'No assignee' : names ? (names.get(k) ?? 'No longer on this board') : 'Assigned'
    const named = keys
      .filter((k) => k !== '')
      .map((k) => ({ key: k, label: nameOf(k) }))
      .sort((a, b) => a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1))
    return {
      specs: [...named, ...(keys.includes('') ? [{ key: '', label: nameOf('') }] : [])],
      laneOf: (c) => c.who ?? '',
    }
  }
  // by tag: a card goes to its first tag (by name); a card with none to "Untagged"
  const tagged = new Map<string, string>()
  for (const c of cards) {
    const first = c.tags[0]
    if (first && !tagged.has(first.key)) tagged.set(first.key, first.name)
  }
  const sorted = [...tagged.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1))
  const untagged = cards.some((c) => c.tags.length === 0)
  return {
    specs: [...sorted, ...(untagged ? [{ key: '', label: 'Untagged' }] : [])],
    laneOf: (c) => c.tags[0]?.key ?? '',
  }
}

/** The x extent of a card's dates on the axis (a bar, or a milestone's centre), with whether it starts before the range. */
export function spanOf(
  t: TimelineValue,
  axis: { x: number; w: number },
  start: string | null,
  due: string,
): { x1: number; x2: number; clippedLeft: boolean } {
  const frame = { x: axis.x, width: axis.w }
  const x2 = dateToX(t, frame, addDays(due, 1) ?? due)
  if (start === null || start > due) {
    const x = dateToX(t, frame, due)
    return { x1: x, x2, clippedLeft: false }
  }
  return { x1: dateToX(t, frame, start), x2, clippedLeft: start < t.start }
}

/** A bar's (or milestone's) x and width on the axis for these dates; a card with no start (or a start after its due) is a milestone. */
export function barBox(
  t: TimelineValue,
  axis: { x: number; w: number },
  start: string | null,
  due: string,
): { x: number; w: number; kind: BarKind; clippedLeft: boolean } {
  const s = spanOf(t, axis, start, due)
  if (start === null || start > due)
    return {
      x: (s.x1 + s.x2) / 2 - MILESTONE_HALF,
      w: MILESTONE_HALF * 2,
      kind: 'milestone',
      clippedLeft: false,
    }
  return { x: s.x1, w: Math.max(MIN_BAR_W, s.x2 - s.x1), kind: 'bar', clippedLeft: s.clippedLeft }
}

/** Whether a card is on this timeline: a due date in its range (and the tag, when the timeline filters by one). */
export function onTimeline(t: TimelineValue, c: TimelineCard): boolean {
  if (c.due === null || !isPlanningDate(c.due) || c.due < t.start || c.due > t.end) return false
  return t.tag === undefined || c.tags.some((g) => g.key === t.tag)
}

/** Lays the timeline out: the ruler, the lanes and every bar that is in range (up to the cap). */
export function layoutTimeline(input: LayoutInput): Layout {
  const { t, size, today } = input
  const cap = input.maxBars ?? MAX_BARS
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const axisX = t.lanes === 'none' ? 0 : Math.min(LABEL_W, width / 3)
  const axis = { x: axisX, w: Math.max(1, width - axisX) }

  const inRange = input.cards.filter((c) => onTimeline(t, c))
  inRange.sort(
    (a, b) => (a.due as string).localeCompare(b.due as string) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const kept = inRange.slice(0, cap)
  const { specs, laneOf } = laneSpecs(t, kept, input.names)

  const bars: Bar[] = []
  const lanes: Lane[] = []
  let y = RULER_H
  for (let li = 0; li < specs.length; li++) {
    const spec = specs[li] as LaneSpec
    const members = kept.filter((c) => laneOf(c) === spec.key)
    // pack the lane's bars into rows: a bar goes on the first row it does not run into
    const ends: number[] = []
    const placed: {
      card: TimelineCard
      row: number
      x1: number
      w: number
      kind: BarKind
      clippedLeft: boolean
    }[] = []
    for (const card of members) {
      const box = barBox(t, axis, card.start, card.due as string)
      const milestone = box.kind === 'milestone'
      const w = box.w
      const x1 = box.x
      const inside = !milestone && w - 28 >= 36
      const ownLabel = card.title.trim() || 'Untitled card'
      const reach = inside ? x1 + w : x1 + w + 6 + Math.min(textWidth(ownLabel, BAR_FONT), 160)
      let row = ends.findIndex((e) => e + 4 <= x1)
      if (row < 0) {
        row = ends.length
        ends.push(reach)
      } else ends[row] = reach
      placed.push({ card, row, x1, w, kind: box.kind, clippedLeft: box.clippedLeft })
    }
    const rows = Math.max(1, ends.length)
    const laneH = rows * ROW_STEP + LANE_PAD * 2
    const cut = y + laneH > height
    lanes.push({ key: spec.key, label: spec.label, y, h: Math.max(0, Math.min(laneH, height - y)), cut })
    for (const p of placed) {
      const by = y + LANE_PAD + p.row * ROW_STEP + (ROW_STEP - BAR_H) / 2
      if (by + BAR_H > height - 2) continue
      const ownLabel = p.card.title.trim() || 'Untitled card'
      const inside = p.kind === 'bar' && p.w - 28 >= 36
      const label = inside ? fitText(ownLabel, p.w - 28, BAR_FONT) : fitText(ownLabel, 160, BAR_FONT)
      bars.push({
        id: p.card.id,
        kind: p.kind,
        card: p.card,
        lane: li,
        row: p.row,
        x: p.x1,
        y: by,
        w: p.w,
        h: BAR_H,
        label,
        labelInside: inside && label !== '',
        clippedLeft: p.clippedLeft,
        overdue: isOverdue(
          { status: p.card.status, who: p.card.who, start: p.card.start, due: p.card.due },
          today,
        ),
      })
    }
    y += laneH
    if (y >= height) break
  }

  const todayX =
    today >= t.start && today <= t.end
      ? dateToX(t, { x: axis.x, width: axis.w }, today) + axis.w / Math.max(1, timelineDays(t)) / 2
      : null
  return {
    width,
    height,
    axis,
    months: monthSpans(t, axis),
    ticks: rulerTicks(t, axis),
    lanes,
    bars,
    todayX,
    inRange: inRange.length,
    shown: bars.length,
    capped: Math.max(0, inRange.length - kept.length),
    below: kept.length - bars.length,
  }
}

/** The text a bar is announced and exported with: title, status, dates, assignee. */
export function barDescription(bar: Pick<Bar, 'card' | 'kind' | 'overdue'>, who: string | null): string {
  const c = bar.card
  const parts = [c.title.trim() || 'Untitled card', CARD_STATUS_LABELS[c.status]]
  parts.push(bar.kind === 'milestone' ? `due ${c.due}` : `${c.start} to ${c.due}`)
  if (bar.overdue) parts.push('overdue')
  if (who) parts.push(`assigned to ${who}`)
  return parts.join(', ')
}
