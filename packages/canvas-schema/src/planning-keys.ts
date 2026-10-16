/**
 * Wave T (CONTRACTS_REV 14, protocol.ts PLANNING_REV): the four planning key classes of `customData.lobby`
 * (custom-data.ts LOBBY_KEY_SPECS; docs/WAVE-T-CONTRACTS.md §2), their value schemas and the per-element rules every
 * writer is held to (`planningElementProblem`, run by elements.ts checkElement on every element the room stores):
 *
 *   card:status  `todo` | `doing` | `review` | `blocked` | `done`   on a rectangle or sticky note: it makes a card
 *   card:who     a uid (an ACCOUNT with a role on the board: the room asks the api, assignee-refs)
 *   card:start   `YYYY-MM-DD` (2000-01-01 to 2100-12-31)
 *   card:due     `YYYY-MM-DD`; start <= due when both are there
 *   sb:of        the element id of the storyboard's head (a soft ref: a deleted head leaves an untitled storyboard)
 *   sb:pos       a fractional order key (@excalidraw/fractional-indexing), at most 64 characters
 *   sb:dur       the panel's duration in ms, 100 to 600,000
 *   sb:head      on a free text (the storyboard's title; its element id is the storyboard id): aspect, fps, default
 *                duration, panels per row, the audio card and its offset
 *   kanban       on a frame: column labels, hidden columns and WIP limits per status
 *   timeline     on a frame: start, end (at most two years), scale, lanes, an optional tag filter
 *
 * Nothing here is ever derived and stored: shot numbers, a card's place in a Kanban and a timeline's bars are what
 * readers compute from these keys (planning.ts). A reader below 14 never receives a patch that names one
 * (protocol.ts LOBBY_KEY_ADDITIONS, opForReader), and a writer below 14 never writes one.
 *
 * Pure: zod and limits.ts only (no engine code: only canvas-schema/src/engine may import @excalidraw/*, so the order
 * key rule is restated here and pinned against engine/fractional.ts isValidIndexKey in planning.test.ts). It imports
 * nothing from custom-data.ts (which imports this module), so a freeze copies it as it is
 * (scripts/freeze-protocol-fixture.mjs).
 */
import { z } from 'zod'
import { ELEMENT_ID_PATTERN, MAX_UID_CHARS } from './limits.ts'

// ---- the key classes --------------------------------------------------------------------------------------------

export const CARD_KEY_PREFIX = 'card:'
export const STORYBOARD_KEY_PREFIX = 'sb:'
/** Exact keys. No other key of the registry starts with either (pinned), so a prefix match is the key itself. */
export const KANBAN_KEY = 'kanban'
export const TIMELINE_KEY = 'timeline'
/** The four classes, as protocol.ts LOBBY_KEY_ADDITIONS and the strip-keys route name them. */
export const PLANNING_KEY_CLASSES = [
  CARD_KEY_PREFIX,
  STORYBOARD_KEY_PREFIX,
  KANBAN_KEY,
  TIMELINE_KEY,
] as const
export type PlanningKeyClass = (typeof PLANNING_KEY_CLASSES)[number]

export const CARD_STATUS_KEY = 'card:status'
export const CARD_WHO_KEY = 'card:who'
export const CARD_START_KEY = 'card:start'
export const CARD_DUE_KEY = 'card:due'
export const CARD_KEYS = [CARD_STATUS_KEY, CARD_WHO_KEY, CARD_START_KEY, CARD_DUE_KEY] as const
export type CardKey = (typeof CARD_KEYS)[number]

export const SB_OF_KEY = 'sb:of'
export const SB_POS_KEY = 'sb:pos'
export const SB_DUR_KEY = 'sb:dur'
export const SB_HEAD_KEY = 'sb:head'
export const SB_PANEL_KEYS = [SB_OF_KEY, SB_POS_KEY, SB_DUR_KEY] as const
export const SB_KEYS = [...SB_PANEL_KEYS, SB_HEAD_KEY] as const
export type StoryboardKey = (typeof SB_KEYS)[number]

/** Every planning key (the registry has an exact spec for each). */
export const PLANNING_KEYS = [...CARD_KEYS, ...SB_KEYS, KANBAN_KEY, TIMELINE_KEY] as const
export type PlanningKey = (typeof PLANNING_KEYS)[number]

/** Whether `key` belongs to a planning key class (well formed or not: the class decides, as for `react:`). */
export const isPlanningKey = (key: string): boolean =>
  key.startsWith(CARD_KEY_PREFIX) ||
  key.startsWith(STORYBOARD_KEY_PREFIX) ||
  key === KANBAN_KEY ||
  key === TIMELINE_KEY

// ---- values -----------------------------------------------------------------------------------------------------

/** The fixed card statuses (a Kanban may relabel or hide columns; it never adds one). */
export const CARD_STATUSES = ['todo', 'doing', 'review', 'blocked', 'done'] as const
export type CardStatus = (typeof CARD_STATUSES)[number]
export const CARD_STATUS_LABELS: Readonly<Record<CardStatus, string>> = {
  todo: 'To do',
  doing: 'In progress',
  review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
}
/** The element types a card may be. */
export const CARD_ELEMENT_TYPES = ['rectangle', 'stickynote'] as const

export const PLANNING_DATE_MIN = '2000-01-01'
export const PLANNING_DATE_MAX = '2100-12-31'
/** The longest timeline: two years (731 days, a leap day included). */
export const TIMELINE_MAX_DAYS = 731

export const SB_DUR_MIN_MS = 100
export const SB_DUR_MAX_MS = 600_000
export const SB_DEFAULT_DUR_MS = 2_000
export const SB_POS_MAX_CHARS = 64
/** The length past which the actor rebalances a storyboard's order keys (planning.ts `needsRebalance`). */
export const SB_POS_REBALANCE_CHARS = 48
export const SB_ASPECTS = ['16:9', '9:16', '1:1', '4:5', '2.39:1'] as const
export type StoryboardAspect = (typeof SB_ASPECTS)[number]
export const SB_FPS = [24, 25, 30] as const
export type StoryboardFps = (typeof SB_FPS)[number]
export const SB_PER_ROW_MAX = 12
export const SB_DEFAULT_PER_ROW = 6
export const SB_AUDIO_OFFSET_MAX_MS = 60_000
export const KANBAN_LABEL_MAX_CHARS = 40
export const KANBAN_WIP_MAX = 99
export const TIMELINE_SCALES = ['day', 'week', 'month'] as const
export type TimelineScale = (typeof TIMELINE_SCALES)[number]
export const TIMELINE_LANES = ['none', 'status', 'assignee', 'tag'] as const
export type TimelineLanes = (typeof TIMELINE_LANES)[number]

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The day number (days since 1970-01-01, UTC) of a `YYYY-MM-DD` date in range, or null. */
export function dayNumber(date: string): number | null {
  const m = DATE_RE.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  if (date < PLANNING_DATE_MIN || date > PLANNING_DATE_MAX) return null
  return Math.round(t / 86_400_000)
}
/** Whether `date` is a real calendar date `YYYY-MM-DD` between 2000-01-01 and 2100-12-31. */
export const isPlanningDate = (date: unknown): date is string =>
  typeof date === 'string' && dayNumber(date) !== null

/**
 * Whether `key` is a base-62 order key that @excalidraw/fractional-indexing's `validateOrderKey` accepts (the rule
 * engine/fractional.ts isValidIndexKey applies to element indexes), at most SB_POS_MAX_CHARS long: an integer part
 * whose head letter gives its length (`a`..`z`: 2..27, `Z`..`A`: 2..27), never the smallest one (`A` and 26 zeros),
 * then a fraction that does not end in `0`.
 */
export function isOrderKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > SB_POS_MAX_CHARS || !/^[A-Za-z][0-9A-Za-z]*$/.test(key))
    return false
  const head = key.charCodeAt(0)
  const intLength = head >= 97 ? head - 97 + 2 : 90 - head + 2
  if (key.length < intLength || key === `A${'0'.repeat(26)}`) return false
  return !key.slice(intLength).endsWith('0')
}

const Uid = z.string().min(1).max(MAX_UID_CHARS)
const ElementRef = z.string().regex(ELEMENT_ID_PATTERN)
export const PlanningDate = z.string().refine(isPlanningDate, 'a date YYYY-MM-DD from 2000 to 2100')
export const CardStatusValue = z.enum(CARD_STATUSES)
export const CardWhoValue = Uid
export const SbDurValue = z.number().int().min(SB_DUR_MIN_MS).max(SB_DUR_MAX_MS)
export const SbPosValue = z.string().refine(isOrderKey, 'a fractional order key')
export const SbOfValue = ElementRef
export const SbHeadValue = z.strictObject({
  aspect: z.enum(SB_ASPECTS),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]).optional(),
  defaultMs: SbDurValue.optional(),
  perRow: z.number().int().min(1).max(SB_PER_ROW_MAX).optional(),
  /** the audio track: a file card or a video card (checked at the write by the room: a live element with `file`) */
  audio: ElementRef.optional(),
  audioOffsetMs: z.number().int().min(-SB_AUDIO_OFFSET_MAX_MS).max(SB_AUDIO_OFFSET_MAX_MS).optional(),
})
export type SbHeadValue = z.infer<typeof SbHeadValue>

const Label = z.string().trim().min(1).max(KANBAN_LABEL_MAX_CHARS)
const Wip = z.number().int().min(1).max(KANBAN_WIP_MAX)
export const KanbanValue = z
  .strictObject({
    labels: z
      .strictObject({
        todo: Label.optional(),
        doing: Label.optional(),
        review: Label.optional(),
        blocked: Label.optional(),
        done: Label.optional(),
      })
      .optional(),
    hidden: z
      .array(CardStatusValue)
      .max(CARD_STATUSES.length - 1)
      .optional(),
    wip: z
      .strictObject({
        todo: Wip.optional(),
        doing: Wip.optional(),
        review: Wip.optional(),
        blocked: Wip.optional(),
        done: Wip.optional(),
      })
      .optional(),
  })
  .refine((v) => !v.hidden || new Set(v.hidden).size === v.hidden.length, 'a hidden column twice')
export type KanbanValue = z.infer<typeof KanbanValue>

/** A tag key as a filter (the `<tagKey>` of `tag:<tagKey>`: 1 to 100 characters, no whitespace). */
const TagKeyRef = z.string().regex(/^\S{1,100}$/u)
export const TimelineValue = z
  .strictObject({
    start: PlanningDate,
    end: PlanningDate,
    scale: z.enum(TIMELINE_SCALES),
    lanes: z.enum(TIMELINE_LANES),
    tag: TagKeyRef.optional(),
  })
  .refine((v) => {
    const a = dayNumber(v.start)
    const b = dayNumber(v.end)
    return a !== null && b !== null && a <= b && b - a < TIMELINE_MAX_DAYS
  }, 'start after end, or more than two years')
export type TimelineValue = z.infer<typeof TimelineValue>

/** Each planning key's value schema and byte cap (custom-data.ts builds the registry's specs from it). */
export const PLANNING_VALUES: Readonly<Record<PlanningKey, { value: z.ZodType; maxBytes: number }>> = {
  [CARD_STATUS_KEY]: { value: CardStatusValue, maxBytes: 16 },
  [CARD_WHO_KEY]: { value: CardWhoValue, maxBytes: MAX_UID_CHARS * 4 + 2 },
  [CARD_START_KEY]: { value: PlanningDate, maxBytes: 16 },
  [CARD_DUE_KEY]: { value: PlanningDate, maxBytes: 16 },
  [SB_OF_KEY]: { value: SbOfValue, maxBytes: 128 },
  [SB_POS_KEY]: { value: SbPosValue, maxBytes: SB_POS_MAX_CHARS + 2 },
  [SB_DUR_KEY]: { value: SbDurValue, maxBytes: 16 },
  [SB_HEAD_KEY]: { value: SbHeadValue, maxBytes: 512 },
  [KANBAN_KEY]: { value: KanbanValue, maxBytes: 512 },
  [TIMELINE_KEY]: { value: TimelineValue, maxBytes: 256 },
}

// ---- the per-element rules (checkElement) ------------------------------------------------------------------------

/**
 * Why an element of `type` (a bound text when `containerId` is set) may not hold these planning keys, or null.
 * Held by every writer, the room's merge, the seed and every import (elements.ts checkElement):
 *  - `card:*` only on a rectangle or a sticky note, and never without `card:status` (removing the status unmakes
 *    the card, so the same op removes the other card keys); `card:start` <= `card:due` when both are there;
 *  - `sb:of`, `sb:pos`, `sb:dur`, `kanban` and `timeline` only on a frame; a panel names its storyboard (`sb:of`
 *    and `sb:pos` together; `sb:dur` alone is no panel);
 *  - `sb:head` only on a free text (no container).
 * Which keys a writer may write (roles, guests, the assignee check, the kill switch) is the room's
 * (apps/sync/src/room/custom-data.ts); references to other elements stay soft (a deleted head or audio card).
 */
export function planningElementProblem(
  type: string,
  containerId: string | null | undefined,
  lobby: Readonly<Record<string, unknown>>,
): string | null {
  let card = false
  let panel = false
  for (const k of Object.keys(lobby)) {
    if (k.startsWith(CARD_KEY_PREFIX)) card = true
    else if (k === SB_OF_KEY || k === SB_POS_KEY || k === SB_DUR_KEY) panel = true
  }
  if (card) {
    if (!(CARD_ELEMENT_TYPES as readonly string[]).includes(type)) return `card keys on a ${type}`
    if (!(CARD_STATUS_KEY in lobby)) return 'card keys without card:status'
    const start = lobby[CARD_START_KEY]
    const due = lobby[CARD_DUE_KEY]
    if (typeof start === 'string' && typeof due === 'string' && start > due)
      return 'card:start after card:due'
  }
  if (panel) {
    if (type !== 'frame') return `storyboard panel keys on a ${type}`
    if (!(SB_OF_KEY in lobby) || !(SB_POS_KEY in lobby)) return 'a panel needs sb:of and sb:pos'
  }
  if ((KANBAN_KEY in lobby || TIMELINE_KEY in lobby) && type !== 'frame')
    return `kanban or timeline on a ${type}`
  if (KANBAN_KEY in lobby && TIMELINE_KEY in lobby) return 'a frame is a kanban or a timeline, not both'
  if (SB_HEAD_KEY in lobby && (type !== 'text' || containerId)) return 'sb:head on anything but a free text'
  return null
}

// ---- duplicate: `relink-keep` -------------------------------------------------------------------------------------

/**
 * The value of a `relink-keep` key on a copy (custom-data.ts DuplicateRule): every element id inside it that the
 * copy set maps (`idMap`, original → copy) points at the copy, every other one is KEPT (a panel copied without its
 * head joins the same storyboard; a head copied without its audio card keeps that card). `sb:of` is the ref itself;
 * `sb:head` holds `audio`. `value` itself when nothing changes.
 */
export function relinkKeep(key: string, value: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (key === SB_OF_KEY) return typeof value === 'string' ? (idMap.get(value) ?? value) : value
  if (key === SB_HEAD_KEY && value && typeof value === 'object' && !Array.isArray(value)) {
    const audio = (value as { audio?: unknown }).audio
    const to = typeof audio === 'string' ? idMap.get(audio) : undefined
    return to ? { ...(value as Record<string, unknown>), audio: to } : value
  }
  return value
}
