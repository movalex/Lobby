// OWNER: WS5 (wave T). The timeline's date arithmetic on `YYYY-MM-DD` strings (UTC day numbers, no time zones), on top
// of canvas-schema's planning model (`addDays`, `snapDate`, `dayNumber`, `dateOfDay`). Pure.
import {
  addDays,
  dateOfDay,
  dayNumber,
  isPlanningDate,
  snapDate,
  type TimelineScale,
} from '@draftroom/canvas-schema/planning'

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const
export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** Today in the viewer's own calendar, as `YYYY-MM-DD` (the timeline's today marker and "overdue"). */
export function todayOf(now: Date = new Date()): string {
  const p = (v: number, w: number) => String(v).padStart(w, '0')
  return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1, 2)}-${p(now.getDate(), 2)}`
}

/** The parts of a date, or null when it is none. */
export function partsOf(date: string): { y: number; m: number; d: number } | null {
  if (!isPlanningDate(date)) return null
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) }
}

/** The days between two dates (`b - a`), or null when either is none. */
export function daysBetween(a: string, b: string): number | null {
  const x = dayNumber(a)
  const y = dayNumber(b)
  return x === null || y === null ? null : y - x
}

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** `date` moved by `n` calendar months, keeping its day of the month where the month has it (else the last day). */
export function shiftMonths(date: string, n: number): string | null {
  const p = partsOf(date)
  if (!p || !Number.isInteger(n)) return null
  const index = p.y * 12 + (p.m - 1) + n
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  const d = Math.min(p.d, daysInMonth(y, m))
  const out = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isPlanningDate(out) ? out : null
}

/** `date` moved by `n` units of the scale: days, weeks (7 days, so the weekday stays) or calendar months. */
export function shiftByUnit(date: string, scale: TimelineScale, n: number): string | null {
  if (scale === 'month') return shiftMonths(date, n)
  return addDays(date, scale === 'week' ? 7 * n : n)
}

/** The first day of the unit that follows the one `date` is in. */
export function nextUnitStart(date: string, scale: TimelineScale): string | null {
  const start = snapDate(date, scale)
  return start === null ? null : shiftByUnit(start, scale, 1)
}

/** The last day of the unit `date` is in (a day: itself, a week: its Sunday, a month: its last day). */
export function unitEnd(date: string, scale: TimelineScale): string | null {
  if (scale === 'day') return isPlanningDate(date) ? date : null
  const next = nextUnitStart(date, scale)
  return next === null ? null : addDays(next, -1)
}

/** The Monday on or before `date`. */
export const mondayOf = (date: string): string | null => snapDate(date, 'week')

/** "5 Oct" */
export function shortDate(date: string): string {
  const p = partsOf(date)
  return p ? `${p.d} ${MONTHS[p.m - 1]}` : date
}

/** "5 Oct 2026" */
export function longDate(date: string): string {
  const p = partsOf(date)
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : date
}

/** The weekday, Monday = 0. */
export function weekdayOf(date: string): number | null {
  const n = dayNumber(date)
  return n === null ? null : (((n + 3) % 7) + 7) % 7
}

export { addDays, dateOfDay }
