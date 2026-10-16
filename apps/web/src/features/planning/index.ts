// OWNER: the wave T foundation (the lead): the web contracts wave T's workstreams share (docs/WAVE-T-CONTRACTS.md §6).
// Not a canvas feature of its own: each workstream's feature is registered empty in features/canvas-registry.ts
// (storyboard, storyboard-play, cards, kanban, card-table, timeline) and fills itself. What lives here:
//  - the switches and the room gate (./flags.ts), the read model (./model.ts);
//  - PLANNING_ENTRIES: every place a wave T feature is offered (the Elements panel, the palette, the context and
//    selection menus), with its owner and switch, so that no workstream edits another's entry and each turns on
//    only its own (the palette ids are @draftroom/contracts WAVE_T_PALETTE_COMMAND_IDS, pending until registered);
//  - the card popover seam: WS4 implements and registers it, WS5 (a timeline bar) and WS4's table open it.
import type { WAVE_T_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { PlanningFlag } from './flags.ts'

export {
  PLANNING_FLAG_KEYS,
  PLANNING_FLAGS,
  type PlanningFlag,
  type PlanningFlags,
  planningFlags,
  planningOffered,
  planningRoom,
  planningShown,
} from './flags.ts'
export {
  type Card,
  cardsIn,
  cardsOn,
  kanbansOn,
  type PlanningFrame,
  type PlanningScene,
  storyboardOfSelection,
  storyboardsOn,
  timelinesOn,
} from './model.ts'

export type PlanningOwner = 'WS2' | 'WS3' | 'WS4' | 'WS5'
export type PlanningPlace = 'elements' | 'palette' | 'context-menu' | 'selection-bar' | 'main-menu' | 'export'

export interface PlanningEntry {
  /** the palette command id (contracts WAVE_T_PALETTE_COMMAND_IDS) the entry runs, wherever it is offered */
  readonly id: (typeof WAVE_T_PALETTE_COMMAND_IDS)[number]
  readonly label: string
  readonly owner: PlanningOwner
  /** the switch that offers it (./flags.ts) */
  readonly flag: PlanningFlag
  readonly places: readonly PlanningPlace[]
  /** whether it writes planning keys (then offered only in a rev-14 room, never read-only: `planningOffered`) */
  readonly writes: boolean
}

/** Every wave T entry (the words are the design's; each owner may refine its own label). */
export const PLANNING_ENTRIES: readonly PlanningEntry[] = [
  {
    id: 'storyboard.new',
    label: 'New storyboard',
    owner: 'WS2',
    flag: 'storyboard',
    places: ['elements', 'palette'],
    writes: true,
  },
  {
    id: 'storyboard.from-frames',
    label: 'Make storyboard from frames',
    owner: 'WS2',
    flag: 'storyboard',
    places: ['context-menu', 'selection-bar', 'palette'],
    writes: true,
  },
  {
    id: 'storyboard.from-script',
    label: 'Script to boards…',
    owner: 'WS2',
    flag: 'storyboard',
    places: ['elements', 'palette'],
    writes: true,
  },
  {
    id: 'storyboard.play',
    label: 'Play animatic',
    owner: 'WS3',
    flag: 'animatic',
    places: ['selection-bar', 'context-menu', 'palette'],
    writes: false,
  },
  {
    id: 'storyboard.present',
    label: 'Present storyboard',
    owner: 'WS3',
    flag: 'animatic',
    places: ['context-menu', 'palette'],
    writes: false,
  },
  {
    id: 'cards.make',
    label: 'Make a card',
    owner: 'WS4',
    flag: 'cards',
    places: ['context-menu', 'selection-bar', 'palette'],
    writes: true,
  },
  {
    id: 'kanban.new',
    label: 'Kanban board',
    owner: 'WS4',
    flag: 'kanban',
    places: ['elements', 'palette'],
    writes: true,
  },
  {
    id: 'card-table.open',
    label: 'Card table',
    owner: 'WS4',
    flag: 'table',
    places: ['main-menu', 'palette'],
    writes: false,
  },
  {
    id: 'timeline.new',
    label: 'Timeline',
    owner: 'WS5',
    flag: 'timeline',
    places: ['elements', 'palette'],
    writes: true,
  },
]

// ---- the card popover seam (WS4 implements; WS4's table and WS5's timeline open it) -----------------------------

export interface CardPopoverRequest {
  /** the card element */
  readonly id: string
  /** where to anchor it on screen (a timeline bar's or a table row's rect); absent: the card's own bounds */
  readonly anchor?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  /** the field to focus first */
  readonly focus?: 'status' | 'who' | 'start' | 'due' | 'tags' | 'link'
}
/** Opens the card popover; false when it cannot (no popover registered, not a card, its switch off). */
export type CardPopoverOpener = (ctx: CanvasFeatureContext, req: CardPopoverRequest) => boolean

let opener: CardPopoverOpener | null = null

/** WS4 registers its popover (features/cards) once, on mount; returns the unregister. */
export function registerCardPopover(open: CardPopoverOpener): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

/** Opens the card popover through WS4's registration (false until WS4 lands, or when its switch is off). */
export const openCardPopover = (ctx: CanvasFeatureContext, req: CardPopoverRequest): boolean =>
  opener ? opener(ctx, req) : false
