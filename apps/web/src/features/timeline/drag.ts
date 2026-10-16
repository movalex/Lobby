// OWNER: WS5 (wave T). What dragging, resizing and nudging a bar does to a card's dates, pure: the pointer's x (frame
// coordinates) or a key press in, the new `start`/`due` out, snapped to the scale's unit (a day; a week moves by 7 days
// so the weekday stays; a month by calendar months, an edge snaps to the unit's first or last day) and clamped so that
// `start <= due` (the server's rule backs it) and the due date stays inside the timeline's range. Nothing is written
// here: the board page writes the result once, when the gesture ends, in one transaction (one undo step).
import {
  CARD_DUE_KEY,
  CARD_START_KEY,
  dateOfDay,
  dayNumber,
  snapDate,
  type TimelineValue,
  timelineDays,
} from '@draftroom/canvas-schema/planning'
import { shiftByUnit, shiftMonths, unitEnd } from './dates.ts'

export type DragMode = 'move' | 'start' | 'end'

/** A card's dates: a bar has both, a milestone only its due date. */
export interface Dates {
  readonly start: string | null
  readonly due: string
}

export const sameDates = (a: Dates, b: Dates): boolean => a.start === b.start && a.due === b.due

/** The day under frame x `x` (the axis' left edge is `axis.x`), kept inside the range. */
export function dayAtX(t: TimelineValue, axis: { x: number; w: number }, x: number): string {
  const days = timelineDays(t)
  const rel = axis.w > 0 ? (x - axis.x) / axis.w : 0
  const idx = Math.min(Math.max(Math.floor(rel * days), 0), days - 1)
  return dateOfDay((dayNumber(t.start) ?? 0) + idx)
}

const inRange = (t: TimelineValue, due: string) => due >= t.start && due <= t.end

/** The units between two days, by the scale. */
function unitsBetween(scale: TimelineValue['scale'], days: number): number {
  if (scale === 'day') return days
  if (scale === 'week') return Math.round(days / 7)
  return Math.round(days / 30.4375)
}

/** Both dates moved by `n` units; fewer units when the due date would leave the range; unchanged when none fits. */
function moved(t: TimelineValue, from: Dates, n: number): Dates {
  for (let k = n; k !== 0; k += k > 0 ? -1 : 1) {
    const due = shiftByUnit(from.due, t.scale, k)
    const start = from.start === null ? null : shiftByUnit(from.start, t.scale, k)
    if (due === null || (from.start !== null && start === null)) continue
    if (inRange(t, due)) return { start, due }
  }
  return from
}

/**
 * The dates after dragging from frame x `grabX` (where the pointer went down) to `curX`. `move` shifts both dates (a
 * milestone: its due date); `start` and `end` move that edge to the unit under the pointer, never past the other.
 */
export function pointerDates(args: {
  readonly t: TimelineValue
  readonly axis: { readonly x: number; readonly w: number }
  readonly orig: Dates
  readonly mode: DragMode
  readonly grabX: number
  readonly curX: number
}): Dates {
  const { t, axis, orig, mode } = args
  if (mode === 'move' || orig.start === null) {
    const a = dayNumber(dayAtX(t, axis, args.grabX)) ?? 0
    const b = dayNumber(dayAtX(t, axis, args.curX)) ?? 0
    return moved(t, orig, unitsBetween(t.scale, b - a))
  }
  const under = dayAtX(t, axis, args.curX)
  if (mode === 'start') {
    const start = snapDate(under, t.scale) ?? under
    return { start: start > orig.due ? orig.due : start, due: orig.due }
  }
  const due = unitEnd(under, t.scale) ?? under
  const clamped = due < orig.start ? orig.start : due > t.end ? t.end : due
  return { start: orig.start, due: clamped }
}

/**
 * A key press on a focused bar: ←/→ move it one unit (`move`), Shift+←/→ move its end edge one unit (`end`; a
 * milestone has no edge and moves). The same snapping and clamps as a drag.
 */
export function nudgeDates(t: TimelineValue, orig: Dates, mode: 'move' | 'end', dir: -1 | 1): Dates {
  if (mode === 'move' || orig.start === null) return moved(t, orig, dir)
  const shifted = t.scale === 'month' ? shiftMonths(orig.due, dir) : shiftByUnit(orig.due, t.scale, dir)
  const next = shifted === null ? null : t.scale === 'month' ? unitEnd(shifted, 'month') : shifted
  if (next === null) return orig
  const due = next < orig.start ? orig.start : next
  return inRange(t, due) ? { start: orig.start, due } : orig
}

/** The `customData.lobby` keys that differ between two dates (only these are written: per-key last-writer-wins). */
export function datePatch(from: Dates, to: Dates): Record<string, string> {
  const out: Record<string, string> = {}
  if (to.start !== null && to.start !== from.start) out[CARD_START_KEY] = to.start
  if (to.due !== from.due) out[CARD_DUE_KEY] = to.due
  return out
}
