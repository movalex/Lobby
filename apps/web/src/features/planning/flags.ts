// OWNER: the wave T foundation (the lead): the switches of wave T, storyboards and planning walls
// (docs/WAVE-T-CONTRACTS.md §6). With every switch off a user sees exactly the build before wave T: no storyboard
// strip, chip, player, sheet, card chip, popover, Kanban, table or timeline, and no Elements entry or menu entry for
// any of them. Each workstream turns its own switch on in the change that makes its feature live (one line, through
// the lead).
//
// A switch alone never offers anything: the room must take the planning keys too (`room.contractsRev()` at
// PLANNING_REV or later: a sync with DRAFTROOM_PLANNING off says 13, and so does the deployed one), see
// `planningOffered`. A feature that only READS planning keys a board already holds (chips, the player, exports) may
// show them in any room (`planningShown`): readers below 14 never get a patch that names one, but a rev-14 page does.
//
// A dev-auth build (local dev and the e2e build; never a production bundle: DEV_AUTH_ENABLED) may turn a switch on for
// its page: localStorage PLANNING_FLAG_KEYS[name] = '1' (or '0' to force it off), read when asked (try/catch: a blocked
// store keeps the shipped value). The t1-* to t5-* specs set them with an init script.
import { PLANNING_REV } from '@draftroom/canvas-schema/protocol'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'

export interface PlanningFlags {
  /** WS2: storyboards (create, strip, chips, insert/reorder/delete, Arrange, script to boards, send for review) */
  readonly storyboard: boolean
  /** WS2: "Break down with AI" (the api's `storyboard` action is pending until WS2 too) */
  readonly storyboardAi: boolean
  /** WS3: the animatic player and "Present storyboard" */
  readonly animatic: boolean
  /** WS3: the storyboard PDF sheet and the image sequence + timings CSV + EDL */
  readonly storyboardExports: boolean
  /** WS4: work cards (make/unmake, chips, popover, the assignee picker) */
  readonly cards: boolean
  /** WS4: Kanban frames */
  readonly kanban: boolean
  /** WS4: the card table panel, CSV out and in */
  readonly table: boolean
  /** WS5: timeline frames */
  readonly timeline: boolean
}

export type PlanningFlag = keyof PlanningFlags

// The wave T foundation ships every switch off.
export const PLANNING_FLAGS: PlanningFlags = {
  storyboard: false,
  storyboardAi: false,
  animatic: false,
  storyboardExports: false,
  cards: false,
  kanban: false,
  table: false,
  timeline: false,
}

export const PLANNING_FLAG_KEYS: Readonly<Record<PlanningFlag, string>> = {
  storyboard: 'lobby.planStoryboard',
  storyboardAi: 'lobby.planStoryboardAi',
  animatic: 'lobby.planAnimatic',
  storyboardExports: 'lobby.planStoryboardExports',
  cards: 'lobby.planCards',
  kanban: 'lobby.planKanban',
  table: 'lobby.planTable',
  timeline: 'lobby.planTimeline',
}

const NAMES = Object.keys(PLANNING_FLAGS) as PlanningFlag[]

/** The switches of this page: the shipped ones, or a dev-auth page's overrides (each read in try/catch). */
export function planningFlags(
  devAuth: boolean = DEV_AUTH_ENABLED,
  read: (key: string) => string | null | undefined = (key) => globalThis.localStorage?.getItem(key),
): PlanningFlags {
  if (!devAuth) return PLANNING_FLAGS
  const one = (name: PlanningFlag): boolean => {
    try {
      const v = read(PLANNING_FLAG_KEYS[name])
      return v === '1' ? true : v === '0' ? false : PLANNING_FLAGS[name]
    } catch {
      return PLANNING_FLAGS[name]
    }
  }
  return Object.fromEntries(NAMES.map((n) => [n, one(n)])) as unknown as PlanningFlags
}

/** Whether a room of contracts revision `rev` takes planning writes (null: not known yet, so no). */
export const planningRoom = (rev: number | null): boolean => rev !== null && rev >= PLANNING_REV

/** What a planning offer needs of the canvas: its room's revision and whether this page may edit. */
export interface PlanningGate {
  readonly room: { contractsRev(): number | null }
  readonly readOnly: () => boolean
}

/**
 * Whether this page OFFERS a planning write of `flag`'s feature (a menu entry, a strip control, a drag that writes a
 * key): its switch is on, the room takes planning keys, and the canvas is not read-only. Asked when the offer is drawn
 * (the room's revision can arrive after the first paint, and a reconnect may land in an older room).
 */
export function planningOffered(
  flag: PlanningFlag,
  canvas: PlanningGate,
  flags: PlanningFlags = planningFlags(),
): boolean {
  return flags[flag] && planningRoom(canvas.room.contractsRev()) && !canvas.readOnly()
}

/** Whether this page SHOWS what the board holds for `flag`'s feature (chips, numbers, the player): its switch only. */
export const planningShown = (flag: PlanningFlag, flags: PlanningFlags = planningFlags()): boolean =>
  flags[flag]
