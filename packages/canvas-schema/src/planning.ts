/**
 * Wave T (CONTRACTS_REV 14): the pure planning model every side shares (`@draftroom/canvas-schema/planning`): the web's
 * storyboard strip, player and exports, the Kanban, the card table and the timeline; the sync's rules and seeds; the
 * archive code. The keys and their validation are planning-keys.ts (re-exported here); this module only READS them:
 *  - storyboards: the panels of a head in order and their shot numbers, which are derived, never stored, so two
 *    clients that hold the same converged keys always agree, whatever the order of concurrent writes;
 *  - durations typed as "2.5", "2.5 s", "0:03", "1:02.5" or "36f" (frames at the head's fps), and their words;
 *  - card fields and dates; Kanban columns and bands; timeline scale maths.
 * No engine code: element-like inputs only (`{id, type, customData}`), and the order keys of engine/fractional.ts.
 */
import { indexKeyBetween, indexKeysBetween } from './engine/fractional.ts'
import {
  CARD_DUE_KEY,
  CARD_START_KEY,
  CARD_STATUS_KEY,
  CARD_STATUS_LABELS,
  CARD_STATUSES,
  CARD_WHO_KEY,
  type CardStatus,
  CardStatusValue,
  dayNumber,
  isOrderKey,
  isPlanningDate,
  KANBAN_KEY,
  KanbanValue,
  SB_DEFAULT_DUR_MS,
  SB_DUR_KEY,
  SB_DUR_MAX_MS,
  SB_DUR_MIN_MS,
  SB_HEAD_KEY,
  SB_OF_KEY,
  SB_POS_KEY,
  SB_POS_REBALANCE_CHARS,
  SbHeadValue,
  type StoryboardFps,
  TIMELINE_KEY,
  type TimelineScale,
  TimelineValue,
} from './planning-keys.ts'

export * from './planning-keys.ts'

/** What the planning model reads of an element (a WireElement or the web's CanvasElement). */
export interface PlanningElement {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly customData?:
    | { readonly lobby?: Readonly<Record<string, unknown>> }
    | null
    | Record<string, unknown>
}

const lobbyOf = (el: PlanningElement): Readonly<Record<string, unknown>> => {
  const lobby = (el.customData as { lobby?: unknown } | null | undefined)?.lobby
  return lobby && typeof lobby === 'object' && !Array.isArray(lobby) ? (lobby as Record<string, unknown>) : {}
}

// ---- cards ------------------------------------------------------------------------------------------------------

export interface CardFields {
  readonly status: CardStatus
  readonly who: string | null
  readonly start: string | null
  readonly due: string | null
}

/** The card fields of an element, or null when it is no card (no valid `card:status`). */
export function cardOf(el: PlanningElement): CardFields | null {
  const lobby = lobbyOf(el)
  const status = CardStatusValue.safeParse(lobby[CARD_STATUS_KEY])
  if (!status.success) return null
  const str = (k: string) => (typeof lobby[k] === 'string' ? (lobby[k] as string) : null)
  const start = str(CARD_START_KEY)
  const due = str(CARD_DUE_KEY)
  return {
    status: status.data,
    who: str(CARD_WHO_KEY),
    start: start && isPlanningDate(start) ? start : null,
    due: due && isPlanningDate(due) ? due : null,
  }
}

/** A card status's words (never a colour alone: the chips show these with an icon). */
export const cardStatusLabel = (s: CardStatus): string => CARD_STATUS_LABELS[s]

/** Whether a card is overdue on `today` (`YYYY-MM-DD`): a due date before today, and not done. */
export const isOverdue = (card: CardFields, today: string): boolean =>
  card.due !== null && card.status !== 'done' && card.due < today

/** `date` moved by `days` (`YYYY-MM-DD`), or null when it leaves 2000..2100. */
export function addDays(date: string, days: number): string | null {
  const n = dayNumber(date)
  if (n === null || !Number.isInteger(days)) return null
  const out = dateOfDay(n + days)
  return isPlanningDate(out) ? out : null
}

/** The `YYYY-MM-DD` of a day number (days since 1970-01-01, UTC). */
export function dateOfDay(day: number): string {
  const d = new Date(day * 86_400_000)
  const p = (v: number, w: number) => String(v).padStart(w, '0')
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1, 2)}-${p(d.getUTCDate(), 2)}`
}

// ---- storyboards --------------------------------------------------------------------------------------------------

export interface Storyboard<E extends PlanningElement = PlanningElement> {
  /** the storyboard id: its head's element id */
  readonly id: string
  /** the head (a free text with `sb:head`), or null when it was deleted ("Untitled storyboard") */
  readonly head: E | null
  readonly settings: SbHeadValue | null
  /** the panels in order: by `sb:pos`, ties by element id */
  readonly panels: readonly E[]
}

const posOf = (el: PlanningElement): string => {
  const p = lobbyOf(el)[SB_POS_KEY]
  return typeof p === 'string' ? p : ''
}

/** Panels in storyboard order: by `sb:pos` (string order, as fractional keys sort), ties by element id. */
export function panelsInOrder<E extends PlanningElement>(panels: readonly E[]): E[] {
  return [...panels].sort((a, b) => {
    const pa = posOf(a)
    const pb = posOf(b)
    if (pa !== pb) return pa < pb ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** The storyboard id an element belongs to: a head's own id, a panel's `sb:of`; null for anything else. */
export function storyboardIdOf(el: PlanningElement): string | null {
  const lobby = lobbyOf(el)
  if (SB_HEAD_KEY in lobby) return el.id
  const of = lobby[SB_OF_KEY]
  return el.type === 'frame' && typeof of === 'string' ? of : null
}

/**
 * Every storyboard among `elements` (live ones; deleted ones are skipped): heads and panels grouped by storyboard
 * id, panels in order. A storyboard whose head is gone still lists its panels (head null).
 */
export function storyboardsOf<E extends PlanningElement>(elements: Iterable<E>): Map<string, Storyboard<E>> {
  const heads = new Map<string, E>()
  const panels = new Map<string, E[]>()
  for (const el of elements) {
    if (el.isDeleted) continue
    const lobby = lobbyOf(el)
    if (SB_HEAD_KEY in lobby) heads.set(el.id, el)
    const of = lobby[SB_OF_KEY]
    if (el.type === 'frame' && typeof of === 'string') {
      const list = panels.get(of)
      if (list) list.push(el)
      else panels.set(of, [el])
    }
  }
  const out = new Map<string, Storyboard<E>>()
  for (const id of new Set([...heads.keys(), ...panels.keys()])) {
    const head = heads.get(id) ?? null
    const parsed = head ? SbHeadValue.safeParse(lobbyOf(head)[SB_HEAD_KEY]) : null
    out.set(id, {
      id,
      head,
      settings: parsed?.success ? parsed.data : null,
      panels: panelsInOrder(panels.get(id) ?? []),
    })
  }
  return out
}

/** Shot numbers 1..N by panel id, in storyboard order (derived, never stored). */
export function shotNumbers(panels: readonly PlanningElement[]): Map<string, number> {
  return new Map(panelsInOrder(panels).map((p, i) => [p.id, i + 1]))
}

/** A panel's duration in ms: its `sb:dur`, else the head's default, else SB_DEFAULT_DUR_MS. */
export function panelDurationMs(panel: PlanningElement, settings: SbHeadValue | null = null): number {
  const d = lobbyOf(panel)[SB_DUR_KEY]
  if (typeof d === 'number' && Number.isInteger(d) && d >= SB_DUR_MIN_MS && d <= SB_DUR_MAX_MS) return d
  return settings?.defaultMs ?? SB_DEFAULT_DUR_MS
}

/** Each panel's start and duration (ms) in order, and the running time. */
export function storyboardTimings(sb: Pick<Storyboard, 'panels' | 'settings'>): {
  panels: { id: string; number: number; startMs: number; durationMs: number }[]
  totalMs: number
} {
  let at = 0
  const panels = sb.panels.map((p, i) => {
    const durationMs = panelDurationMs(p, sb.settings)
    const row = { id: p.id, number: i + 1, startMs: at, durationMs }
    at += durationMs
    return row
  })
  return { panels, totalMs: at }
}

/** An order key between two neighbours (either null for an end): the reorder and insert write only this. */
export const panelPosBetween = (before: string | null, after: string | null): string =>
  indexKeyBetween(before, after)

/** Whether a storyboard's keys should be rebalanced (one passed SB_POS_REBALANCE_CHARS, or one is not valid). */
export const needsRebalance = (panels: readonly PlanningElement[]): boolean =>
  panels.some((p) => {
    const pos = posOf(p)
    return !isOrderKey(pos) || pos.length > SB_POS_REBALANCE_CHARS
  })

/** `n` fresh, short, evenly spread order keys (the actor's rebalance, in the same step as the move). */
export const rebalancedPositions = (n: number): string[] => indexKeysBetween(null, null, n)

// ---- durations ---------------------------------------------------------------------------------------------------

/**
 * A typed duration in ms, or null: seconds ("2.5", "2.5 s", "2.5s", "3 sec"), minutes and seconds ("0:03", "1:02.5")
 * or frames ("36f", at `fps`, 24 when absent). Rounded to the ms and held to 100 ms .. 10 minutes.
 */
export function parseDuration(text: string, fps: StoryboardFps | number = 24): number | null {
  const t = text.trim().toLowerCase()
  const secs = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/.exec(t)
  const clock = /^(\d+):([0-5]\d(?:\.\d+)?)$/.exec(t)
  const frames = /^(\d+)\s*f$/.exec(t)
  const ms = secs
    ? Number(secs[1]) * 1000
    : clock
      ? (Number(clock[1]) * 60 + Number(clock[2])) * 1000
      : frames && fps > 0
        ? (Number(frames[1]) / fps) * 1000
        : null
  if (ms === null || !Number.isFinite(ms)) return null
  const r = Math.round(ms)
  return r >= SB_DUR_MIN_MS && r <= SB_DUR_MAX_MS ? r : null
}

/** A duration in words: "2.5 s", "12 s" (one decimal at most). */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 100) / 10
  return `${Number.isInteger(s) ? s.toFixed(0) : s.toFixed(1)} s`
}

/** A running time as `m:ss` (`h:mm:ss` from an hour). */
export function formatRunningTime(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ---- Kanban ------------------------------------------------------------------------------------------------------

export interface KanbanColumn {
  readonly status: CardStatus
  readonly label: string
  readonly wip: number | null
}

/** A Kanban frame's `kanban` value, or null when it is none. */
export function kanbanOf(el: PlanningElement): KanbanValue | null {
  if (el.type !== 'frame') return null
  const r = KanbanValue.safeParse(lobbyOf(el)[KANBAN_KEY])
  return r.success ? r.data : null
}

/** The visible columns, in the fixed status order, with their labels and WIP limits. */
export function kanbanColumns(k: KanbanValue): KanbanColumn[] {
  const hidden = new Set(k.hidden ?? [])
  return CARD_STATUSES.filter((s) => !hidden.has(s)).map((status) => ({
    status,
    label: k.labels?.[status] ?? CARD_STATUS_LABELS[status],
    wip: k.wip?.[status] ?? null,
  }))
}

export interface Band {
  readonly status: CardStatus
  readonly x: number
  readonly width: number
}

/** The columns as equal bands of a frame `{x, width}` (scene units), left to right. */
export function kanbanBands(frame: { x: number; width: number }, k: KanbanValue): Band[] {
  const cols = kanbanColumns(k)
  const w = cols.length ? frame.width / cols.length : 0
  return cols.map((c, i) => ({ status: c.status, x: frame.x + i * w, width: w }))
}

/** The band a scene x falls in (the nearest at the frame's edges), or null with no column. */
export function bandAt(bands: readonly Band[], x: number): Band | null {
  if (!bands.length) return null
  for (const b of bands) if (x < b.x + b.width) return b
  return bands[bands.length - 1] ?? null
}

// ---- timeline ----------------------------------------------------------------------------------------------------

/** A timeline frame's `timeline` value, or null when it is none. */
export function timelineOf(el: PlanningElement): TimelineValue | null {
  if (el.type !== 'frame') return null
  const r = TimelineValue.safeParse(lobbyOf(el)[TIMELINE_KEY])
  return r.success ? r.data : null
}

/** The days a timeline shows, both ends included. */
export const timelineDays = (t: Pick<TimelineValue, 'start' | 'end'>): number =>
  (dayNumber(t.end) ?? 0) - (dayNumber(t.start) ?? 0) + 1

/** `date` snapped to the start of its scale unit: the day, the Monday of its week, the first of its month. */
export function snapDate(date: string, scale: TimelineScale): string | null {
  const n = dayNumber(date)
  if (n === null) return null
  if (scale === 'day') return date
  if (scale === 'week') {
    // 1970-01-01 was a Thursday: day n's weekday, Monday = 0
    const monday = n - ((n + 3) % 7)
    return dateOfDay(monday)
  }
  return `${date.slice(0, 8)}01`
}

/** A date's x in a timeline frame `{x, width}`: the start of its day. Dates outside the range are clamped. */
export function dateToX(
  t: Pick<TimelineValue, 'start' | 'end'>,
  frame: { x: number; width: number },
  date: string,
) {
  const days = timelineDays(t)
  const at = Math.min(Math.max((dayNumber(date) ?? 0) - (dayNumber(t.start) ?? 0), 0), days)
  return frame.x + (at / days) * frame.width
}

/** The date under a scene x in a timeline frame, snapped to the scale's unit and kept inside the range. */
export function xToDate(t: TimelineValue, frame: { x: number; width: number }, x: number): string {
  const days = timelineDays(t)
  const rel = frame.width > 0 ? (x - frame.x) / frame.width : 0
  const day = (dayNumber(t.start) ?? 0) + Math.min(Math.max(Math.floor(rel * days), 0), days - 1)
  const snapped = snapDate(dateOfDay(day), t.scale) ?? t.start
  return snapped < t.start ? t.start : snapped > t.end ? t.end : snapped
}

/** The scale's ticks inside the range (each unit's first day), for the ruler. */
export function timelineTicks(t: TimelineValue): string[] {
  const out: string[] = []
  let at = snapDate(t.start, t.scale) ?? t.start
  const step = (d: string): string | null => {
    if (t.scale === 'day') return addDays(d, 1)
    if (t.scale === 'week') return addDays(d, 7)
    const y = Number(d.slice(0, 4))
    const m = Number(d.slice(5, 7))
    const next = m === 12 ? `${y + 1}-01-01` : `${d.slice(0, 5)}${String(m + 1).padStart(2, '0')}-01`
    return isPlanningDate(next) ? next : null
  }
  for (let i = 0; i < 800; i++) {
    if (at >= t.start && at <= t.end) out.push(at)
    const next = step(at)
    if (!next || next > t.end) break
    at = next
  }
  return out
}
