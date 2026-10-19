// OWNER: WS4 (wave V, breakouts). What the breakouts chip, panel and pill say, and where "Make N frames" puts the
// frames (pure: Node-tested, no canvas, no fetch).
import {
  BREAKOUT_LIMITS,
  type BreakoutGroup,
  type BreakoutMember,
  type BreakoutState,
  breakoutGroupDefaultName,
  cleanDisplayText,
} from '@draftroom/contracts'

/** "8:30", "1:05:00" (rounded up to the second: 0.2 s left still reads 0:01). */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** "8 minutes 30 seconds" for a screen reader. */
export function spokenClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '')
  return [part(h, 'hour'), part(m, 'minute'), part(sec, 'second')].filter(Boolean).join(' ') || '0 seconds'
}

/** What is left of the session (ms), null without an end time. */
export function remainingMs(
  session: Pick<NonNullable<BreakoutState['session']>, 'endsAt'>,
  nowMs: number,
): number | null {
  if (!session.endsAt) return null
  return Math.max(0, Date.parse(session.endsAt) - nowMs)
}

export const groupOf = (
  state: Pick<BreakoutState, 'session'>,
  groupId: string | null,
): BreakoutGroup | null => (groupId && state.session?.groups.find((g) => g.id === groupId)) || null

/** A group's members, in the state's order. */
export const membersOf = (state: Pick<BreakoutState, 'members'>, groupId: string): BreakoutMember[] =>
  state.members.filter((m) => m.groupId === groupId)

/** The element id of a group's frame ref (`shape:<id>`). */
export const frameElementId = (frameId: string): string =>
  frameId.startsWith('shape:') ? frameId.slice('shape:'.length) : frameId

export type ChipKind = 'member' | 'facilitator' | 'choose' | 'waiting' | 'ended'

export interface ChipModel {
  readonly kind: ChipKind
  /** "Group 2" / "Breakouts" / "Pick your group" / "Breakouts ended" */
  readonly title: string
  /** "8:30 left" / "Time's up" / null without an end time */
  readonly time: string | null
  /** what a screen reader says for the whole chip */
  readonly spoken: string
  /** the member's frame is gone from the board (the facilitator picks another) */
  readonly frameRemoved: boolean
  /** "Go to my frame" applies */
  readonly canGo: boolean
}

/**
 * The chip for this person now (null: no chip). A member: their group and the time. A manager in no group: the
 * session at a glance. Choose mode, in no group: "Pick your group". Anyone else in no group: "Waiting for a group".
 * Ended (within `endedShowMs` of its end, and only if this page saw it run): "Breakouts ended".
 */
export function chipModel(
  state: BreakoutState | null,
  opts: {
    nowMs: number
    frameExists: (frameId: string) => boolean
    sawRunning: boolean
    endedShowMs?: number
  },
): ChipModel | null {
  const s = state?.session
  if (!state || !s) return null
  if (s.status === 'ended') {
    const at = s.endedAt ? Date.parse(s.endedAt) : 0
    if (!opts.sawRunning || opts.nowMs - at > (opts.endedShowMs ?? 60_000)) return null
    return {
      kind: 'ended',
      title: 'Breakouts ended',
      time: null,
      spoken: 'Breakouts ended',
      frameRemoved: false,
      canGo: false,
    }
  }
  const left = remainingMs(s, opts.nowMs)
  const time = left === null ? null : left > 0 ? `${clockText(left)} left` : "Time's up"
  const spokenTime = left === null ? '' : left > 0 ? `, ${spokenClock(left)} left` : ", time's up"
  const group = groupOf(state, state.myGroupId)
  if (group) {
    const removed = !opts.frameExists(group.frameId)
    return {
      kind: 'member',
      title: group.name,
      time,
      spoken: `Breakouts: you are in ${group.name}${spokenTime}${removed ? '. Its frame was removed' : ''}`,
      frameRemoved: removed,
      canGo: !removed,
    }
  }
  if (state.canManage) {
    const n = s.groups.length
    return {
      kind: 'facilitator',
      title: `Breakouts · ${n} groups`,
      time,
      spoken: `Breakouts are running in ${n} groups${spokenTime}`,
      frameRemoved: false,
      canGo: false,
    }
  }
  if (s.mode === 'choose')
    return {
      kind: 'choose',
      title: 'Pick your group',
      time,
      spoken: `Breakouts: pick your group${spokenTime}`,
      frameRemoved: false,
      canGo: false,
    }
  return {
    kind: 'waiting',
    title: 'Breakouts',
    time,
    spoken: `Breakouts are running. The facilitator will put you in a group${spokenTime}`,
    frameRemoved: false,
    canGo: false,
  }
}

/** The Facilitate pill's part ("Group 2 · 8:30", "Breakouts · 8:30"), null when nothing runs. */
export function pillPart(
  state: BreakoutState | null,
  nowMs: number,
): { text: string; spoken: string } | null {
  const s = state?.session
  if (!state || !s || s.status !== 'running') return null
  const left = remainingMs(s, nowMs)
  const group = groupOf(state, state.myGroupId)
  const head = group ? group.name : 'Breakouts'
  const text = left === null ? head : `${head} · ${clockText(left)}`
  const spoken = group
    ? `breakouts, you are in ${group.name}${left === null ? '' : `, ${spokenClock(left)} left`}`
    : `breakouts are running${left === null ? '' : `, ${spokenClock(left)} left`}`
  return { text, spoken }
}

/** "3 people" / "1 person" / "Empty" (and the cap in choose mode: "2 of 5"). */
export function countText(n: number, cap: number | null): string {
  if (cap !== null) return `${n} of ${cap}`
  if (n === 0) return 'Empty'
  return `${n} ${n === 1 ? 'person' : 'people'}`
}

// ---- Make N frames ------------------------------------------------------------------------------------------------

export const MADE_FRAME_SIZE = { w: 960, h: 640 } as const
export const MADE_FRAME_GAP = 80

export interface PlannedFrame {
  readonly name: string
  /** relative to the block's top-left */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** N frames in a grid (columns ≈ √N, at most 5), named "Group 1" … "Group N", and the block's size. */
export function framesPlan(n: number): { frames: PlannedFrame[]; width: number; height: number } {
  const count = Math.max(BREAKOUT_LIMITS.groupsMin, Math.min(BREAKOUT_LIMITS.groupsMax, Math.floor(n)))
  const cols = Math.min(5, Math.ceil(Math.sqrt(count)))
  const rows = Math.ceil(count / cols)
  const { w, h } = MADE_FRAME_SIZE
  const frames = Array.from({ length: count }, (_, i) => ({
    name: breakoutGroupDefaultName(i + 1),
    x: (i % cols) * (w + MADE_FRAME_GAP),
    y: Math.floor(i / cols) * (h + MADE_FRAME_GAP),
    w,
    h,
  }))
  return {
    frames,
    width: cols * w + (cols - 1) * MADE_FRAME_GAP,
    height: rows * h + (rows - 1) * MADE_FRAME_GAP,
  }
}

/**
 * A frame's name as a group name: one line, at most 40 characters, "Group n" when it has none. Cleaned as any text
 * people type for others (contracts cleanDisplayText: controls, bidi and zero-width characters out; ZWJ and ZWNJ kept
 * where they join an emoji or a word), also after the cut (it must not end on a joiner), so a frame named "👩‍💻 Devs"
 * or with a stray control character always gives a name the api takes (review m7).
 */
export function groupNameOf(frameName: string | null | undefined, n: number): string {
  const one = cleanDisplayText((frameName ?? '').replace(/\s+/gu, ' '))
  const cut = cleanDisplayText([...one].slice(0, BREAKOUT_LIMITS.groupNameMaxChars).join(''))
  return cut || breakoutGroupDefaultName(n)
}

/** Durations the setup offers (ms; null: no end time). The default is 10 minutes. */
export const DURATION_CHOICES: readonly (number | null)[] = [
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  20 * 60_000,
  30 * 60_000,
  45 * 60_000,
  60 * 60_000,
  null,
]
export const DEFAULT_DURATION_MS = 10 * 60_000
export const EXTEND_MS = 5 * 60_000

export const durationLabel = (ms: number | null) =>
  ms === null ? 'No end time' : `${Math.round(ms / 60_000)} min`
