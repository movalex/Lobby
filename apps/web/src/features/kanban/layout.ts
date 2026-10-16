// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §2). The Kanban's geometry, pure: where a card goes when it is dropped
// in a column, when its status changes (popover, table), and what Tidy does. A Kanban is a frame with a `kanban` key;
// its columns are equal bands of the frame for the visible statuses (canvas-schema planning.ts `kanbanBands`), under a
// header band drawn by the overlay. Status is canonical and position is not: nothing here infers a status for a reader.
// Only the acting tab ever writes what these functions compute (the echo rule; ./runtime.ts).
import {
  type Band,
  bandAt,
  CARD_STATUSES,
  type CardStatus,
  type KanbanValue,
  kanbanBands,
  kanbanColumns,
} from '@draftroom/canvas-schema/planning'

/** The header band at the top of a Kanban frame (scene units): column names, counts, WIP and the mismatch hint. */
export const KANBAN_HEADER_H = 72
/** Space around and between cards in a column. */
export const KANBAN_PAD = 16
export const KANBAN_GAP = 16
/** A new Kanban's column width and height (scene units). */
export const KANBAN_COLUMN_W = 300
export const KANBAN_NEW_H = 960
/** A frame never grows past this to fit a card (scene units). */
export const KANBAN_MAX_H = 20_000

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface CardBox extends Rect {
  readonly id: string
  readonly status: CardStatus
}

export interface Placement {
  readonly x: number
  readonly y: number
}

const round = (v: number) => Math.round(v)

/** The visible columns as bands of the frame (left to right). */
export const bandsOf = (frame: Rect, value: KanbanValue): Band[] => kanbanBands(frame, value)

/** The band a card's centre falls in (the nearest at the frame's edges). */
export const bandOfBox = (bands: readonly Band[], box: Rect): Band | null =>
  bandAt(bands, box.x + box.width / 2)

/** A card's x in a band: centred when it fits with its padding, else at the band's left padding. */
export const slotX = (band: Band, width: number): number =>
  round(width + 2 * KANBAN_PAD <= band.width ? band.x + (band.width - width) / 2 : band.x + KANBAN_PAD)

/** The first y a card may take in a Kanban (under the header). */
export const topY = (frame: Rect): number => frame.y + KANBAN_HEADER_H + KANBAN_PAD

/** `y` kept under the header and, when the card fits, above the frame's bottom padding. */
export function clampY(frame: Rect, height: number, y: number): number {
  const top = topY(frame)
  const bottom = frame.y + frame.height - height - KANBAN_PAD
  return round(Math.max(top, Math.min(y, Math.max(top, bottom))))
}

/**
 * Where a dropped card lands and the status its column means: the band under its centre, snapped into that band
 * (x) and kept inside the frame under the header (y). Null without a visible column.
 */
export function dropPlacement(
  frame: Rect,
  value: KanbanValue,
  box: Rect,
): { status: CardStatus; at: Placement } | null {
  const band = bandOfBox(bandsOf(frame, value), box)
  if (!band) return null
  return { status: band.status, at: { x: slotX(band, box.width), y: clampY(frame, box.height, box.y) } }
}

/** The frame height that holds a card whose bottom is `bottom` (null: it already fits). */
function grownHeight(frame: Rect, bottom: number): number | null {
  const need = Math.ceil(bottom + KANBAN_PAD - frame.y)
  return need > frame.height ? Math.min(need, KANBAN_MAX_H) : null
}

/**
 * Where a card goes when its status changes to `status` while it sits in this Kanban (the popover, the table): the
 * bottom of that column, under the cards already there; the frame grows to hold it. Null when the column is hidden.
 */
export function appendPlacement(
  frame: Rect,
  value: KanbanValue,
  status: CardStatus,
  box: CardBox,
  others: readonly CardBox[],
): { at: Placement; frameHeight: number | null } | null {
  const bands = bandsOf(frame, value)
  const band = bands.find((b) => b.status === status)
  if (!band) return null
  let bottom = topY(frame) - KANBAN_GAP
  for (const o of others) {
    if (o.id === box.id) continue
    if (bandOfBox(bands, o)?.status !== status) continue
    bottom = Math.max(bottom, o.y + o.height)
  }
  const at = { x: slotX(band, box.width), y: round(bottom + KANBAN_GAP) }
  return { at, frameHeight: grownHeight(frame, at.y + box.height) }
}

/**
 * Tidy (the actor's re-layout): every card into its status's column, each column stacked from the top in the order
 * its cards stand now (top to bottom, then left to right, then id); the frame grows to hold the tallest column. A
 * card whose column is hidden stays where it is. Only cards that move are listed.
 */
export function tidyPlan(
  frame: Rect,
  value: KanbanValue,
  cards: readonly CardBox[],
): { moves: Map<string, Placement>; frameHeight: number | null } {
  const bands = bandsOf(frame, value)
  const moves = new Map<string, Placement>()
  let lowest = 0
  for (const band of bands) {
    const col = cards
      .filter((c) => c.status === band.status)
      .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    let y = topY(frame)
    for (const c of col) {
      const at = { x: slotX(band, c.width), y: round(y) }
      if (Math.abs(at.x - c.x) > 0.5 || Math.abs(at.y - c.y) > 0.5) moves.set(c.id, at)
      y += c.height + KANBAN_GAP
      lowest = Math.max(lowest, at.y + c.height)
    }
  }
  return { moves, frameHeight: lowest ? grownHeight(frame, lowest) : null }
}

/**
 * The cards that stand in another column than their status's (a concurrent move, or a rev-13 tab that moved a card
 * but cannot write its status), by the column they stand in. A card whose status's column is hidden is not counted.
 */
export function mismatches(
  frame: Rect,
  value: KanbanValue,
  cards: readonly CardBox[],
): Map<CardStatus, string[]> {
  const bands = bandsOf(frame, value)
  const visible = new Set(bands.map((b) => b.status))
  const out = new Map<CardStatus, string[]>()
  for (const c of cards) {
    if (!visible.has(c.status)) continue
    const at = bandOfBox(bands, c)
    if (!at || at.status === c.status) continue
    const list = out.get(at.status)
    if (list) list.push(c.id)
    else out.set(at.status, [c.id])
  }
  return out
}

/** How many cards each visible column holds by status (what its header counts), and those in hidden columns. */
export function columnCounts(value: KanbanValue, cards: readonly { status: CardStatus }[]) {
  const counts = new Map<CardStatus, number>(CARD_STATUSES.map((s) => [s, 0]))
  for (const c of cards) counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
  const visible = new Set(kanbanColumns(value).map((c) => c.status))
  let hidden = 0
  for (const s of CARD_STATUSES) if (!visible.has(s)) hidden += counts.get(s) ?? 0
  return { counts, hidden }
}

/** A new Kanban's size for its visible columns. */
export const newKanbanSize = (value: KanbanValue) => ({
  width: Math.max(1, kanbanColumns(value).length) * KANBAN_COLUMN_W,
  height: KANBAN_NEW_H,
})

// ---- editing the `kanban` value (labels, hidden columns, WIP limits) ---------------------------------------------

/** The value with `status`'s label set (an empty or default label removes it). */
export function withLabel(
  value: KanbanValue,
  status: CardStatus,
  label: string,
  fallback: string,
): KanbanValue {
  const text = label.trim().slice(0, 40)
  const labels = { ...(value.labels ?? {}) }
  if (!text || text === fallback) delete labels[status]
  else labels[status] = text
  const next: KanbanValue = { ...value, labels }
  if (!Object.keys(labels).length) delete (next as { labels?: unknown }).labels
  return next
}

/** The value with `status` hidden or shown; null when hiding would leave no visible column. */
export function withHidden(value: KanbanValue, status: CardStatus, hidden: boolean): KanbanValue | null {
  const set = new Set(value.hidden ?? [])
  if (hidden) set.add(status)
  else set.delete(status)
  if (set.size >= CARD_STATUSES.length) return null
  const list = CARD_STATUSES.filter((s) => set.has(s))
  const next: KanbanValue = { ...value, hidden: list }
  if (!list.length) delete (next as { hidden?: unknown }).hidden
  return next
}

/** The value with `status`'s WIP limit set (null or out of 1-99 removes it). */
export function withWip(value: KanbanValue, status: CardStatus, wip: number | null): KanbanValue {
  const map = { ...(value.wip ?? {}) }
  if (wip === null || !Number.isInteger(wip) || wip < 1 || wip > 99) delete map[status]
  else map[status] = wip
  const next: KanbanValue = { ...value, wip: map }
  if (!Object.keys(map).length) delete (next as { wip?: unknown }).wip
  return next
}
