// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §2). Work cards, pure: what may be a card, the `customData.lobby`
// patches that make, unmake and edit one (a null value removes a key), the date rules, and the words the chips, the
// popover, the table and the exports share. A card is a rectangle or a sticky note with `card:status`; its title is
// its bound label (edited only under the text lease, never here); tags are its `tag:*` keys and its link the native
// `link`. One key per field, so two people editing the status and the due date at once both win, and undo is per field.
import {
  CARD_DUE_KEY,
  CARD_ELEMENT_TYPES,
  CARD_KEY_PREFIX,
  CARD_START_KEY,
  CARD_STATUS_KEY,
  CARD_STATUS_LABELS,
  CARD_STATUSES,
  CARD_WHO_KEY,
  type CardFields,
  type CardStatus,
  dayNumber,
  isPlanningDate,
  PLANNING_DATE_MAX,
  PLANNING_DATE_MIN,
} from '@draftroom/canvas-schema/planning'
import type { CanvasElement } from '../../canvas/api/index.ts'

export {
  CARD_STATUS_LABELS,
  CARD_STATUSES,
  type CardFields,
  type CardStatus,
  PLANNING_DATE_MAX,
  PLANNING_DATE_MIN,
}

/** Each status's icon (never a colour alone: every chip shows the icon and the words). */
export const STATUS_ICONS: Readonly<Record<CardStatus, 'todo' | 'doing' | 'review' | 'blocked' | 'done'>> = {
  todo: 'todo',
  doing: 'doing',
  review: 'review',
  blocked: 'blocked',
  done: 'done',
}

/** Literal colours for exports (an exported SVG has no CSS variables): AA text on its own fill. */
export const STATUS_EXPORT_COLORS: Readonly<Record<CardStatus, { fill: string; ink: string; line: string }>> =
  {
    todo: { fill: '#eef0f3', ink: '#3d4451', line: '#c5cad3' },
    doing: { fill: '#e3edff', ink: '#1d4ed8', line: '#9db8f5' },
    review: { fill: '#fdf0d5', ink: '#8a4b00', line: '#e9c27a' },
    blocked: { fill: '#fde4e4', ink: '#b42318', line: '#f1a9a3' },
    done: { fill: '#dff5e7', ink: '#1a7f44', line: '#93d3ab' },
  }

export const isCardStatus = (v: unknown): v is CardStatus =>
  typeof v === 'string' && (CARD_STATUSES as readonly string[]).includes(v)

/** Whether an element may become a card: a live rectangle or sticky note. */
export function isCardable(el: CanvasElement | undefined | null): el is CanvasElement {
  if (!el || (el as { isDeleted?: boolean }).isDeleted) return false
  return (CARD_ELEMENT_TYPES as readonly string[]).includes(el.type)
}

/** Whether an element is a card now (a valid `card:status`). */
export const isCard = (el: CanvasElement | undefined | null): boolean =>
  isCardable(el) && isCardStatus(el.customData?.lobby?.[CARD_STATUS_KEY])

type LobbyPatch = Record<string, unknown>

/** The element patch that writes these `customData.lobby` keys (null removes one). */
export const lobbyPatch = (lobby: LobbyPatch) => ({ customData: { lobby } })

/** Makes a card: its status only (the other fields stay empty until someone sets them). */
export const makeCardLobby = (status: CardStatus = 'todo'): LobbyPatch => ({ [CARD_STATUS_KEY]: status })

/** Unmakes a card: every `card:*` key it holds goes, in the same op (the server refuses a status-less card key). */
export function unmakeCardLobby(el: CanvasElement): LobbyPatch {
  const out: LobbyPatch = {}
  for (const k of Object.keys(el.customData?.lobby ?? {})) if (k.startsWith(CARD_KEY_PREFIX)) out[k] = null
  out[CARD_STATUS_KEY] = null
  return out
}

/** One card field's keys as a patch (null clears it). */
export function fieldLobby(field: 'status' | 'who' | 'start' | 'due', value: string | null): LobbyPatch {
  const key =
    field === 'status'
      ? CARD_STATUS_KEY
      : field === 'who'
        ? CARD_WHO_KEY
        : field === 'start'
          ? CARD_START_KEY
          : CARD_DUE_KEY
  return { [key]: value }
}

/**
 * Why setting `field` to `value` on `card` is refused, in words the popover and the table show, or null. Dates are
 * `YYYY-MM-DD` from 2000 to 2100 and the start is never after the due date.
 */
export function dateProblem(card: CardFields, field: 'start' | 'due', value: string | null): string | null {
  if (value === null) return null
  if (!isPlanningDate(value)) return 'Pick a date between 2000 and 2100.'
  const start = field === 'start' ? value : card.start
  const due = field === 'due' ? value : card.due
  if (start && due && start > due)
    return field === 'start' ? 'The start is after the due date.' : 'The due date is before the start.'
  return null
}

// ---- words --------------------------------------------------------------------------------------------------------

/** Today as `YYYY-MM-DD` in this person's own time zone. */
export function todayLocal(now: Date = new Date()): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0')
  return `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** A date in words: "12 Oct", with the year when it is not `today`'s ("12 Oct 2027"). */
export function dateWords(date: string, today: string = todayLocal()): string {
  const d = Number(date.slice(8, 10))
  const m = MONTHS[Number(date.slice(5, 7)) - 1] ?? ''
  return date.slice(0, 4) === today.slice(0, 4) ? `${d} ${m}` : `${d} ${m} ${date.slice(0, 4)}`
}

export interface DueWords {
  /** what the chip says: "Due today", "Due tomorrow", "Due Fri", "Due 12 Oct", "Overdue · 3 Oct", "Done · 3 Oct" */
  readonly text: string
  /** the full sentence for a label: "Due Friday 17 October 2026, overdue" */
  readonly label: string
  readonly overdue: boolean
  /** due today or tomorrow (and not done) */
  readonly soon: boolean
}

const LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const LONG_MONTHS = [
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

/** A date in full words: "Friday 17 October 2026". */
export function longDateWords(date: string): string {
  const n = dayNumber(date)
  if (n === null) return date
  // 1970-01-01 was a Thursday
  const wd = LONG_WEEKDAYS[(n + 4) % 7] ?? ''
  return `${wd} ${Number(date.slice(8, 10))} ${LONG_MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${date.slice(0, 4)}`
}

/** A card's due date in words, against `today`. Null without a due date. */
export function dueWords(
  card: Pick<CardFields, 'due' | 'status'>,
  today: string = todayLocal(),
): DueWords | null {
  if (!card.due) return null
  const due = dayNumber(card.due)
  const now = dayNumber(today)
  if (due === null || now === null) return null
  const done = card.status === 'done'
  const diff = due - now
  const overdue = !done && diff < 0
  const soon = !done && (diff === 0 || diff === 1)
  const short = dateWords(card.due, today)
  const text = done
    ? `Due ${short}`
    : overdue
      ? `Overdue · ${short}`
      : diff === 0
        ? 'Due today'
        : diff === 1
          ? 'Due tomorrow'
          : diff < 7
            ? `Due ${WEEKDAYS[(due + 4) % 7]}`
            : `Due ${short}`
  const label = `Due ${longDateWords(card.due)}${overdue ? ', overdue' : diff === 0 && !done ? ', today' : ''}`
  return { text, label, overdue, soon }
}

/** A person's initials for an avatar: the first letters of their first two words ("Ada Lovelace" → "AL"). */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/u)
    .filter(Boolean)
  if (!words.length) return '?'
  const first = [...(words[0] ?? '')][0] ?? ''
  const second = words.length > 1 ? ([...(words[words.length - 1] ?? '')][0] ?? '') : ''
  return (first + second).toUpperCase() || '?'
}

/** A card's status in words with the label a Kanban gives its column, e.g. "In progress". */
export const statusWords = (s: CardStatus): string => CARD_STATUS_LABELS[s]
