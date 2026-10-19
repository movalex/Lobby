// Wave V (the foundation; docs/WAVE-V-CONTRACTS.md §6.2): the Facilitate menu's extension point, so the wave V
// workstreams add their entries without editing ./WorkshopBar.tsx or ./guest-chrome.ts. OWNER: the wave V lead.
//
// The six built-in entries (Timer, Reactions and raise hand, Raised hands, Voting, Private brainstorm, Spotlight) stay
// as they are (./guest-chrome.ts facilitateEntries: same rules, order and test ids). A registered entry comes after
// them, by `order` (then id): WS2's "Poll or word cloud" (`activities`, 100), WS3's "Show join code" (`join-code`, 200),
// WS4's "Breakouts" (`breakouts`, 300). Each decides when it shows (`shown`: asked on every render of the menu, from the
// same facts the built-ins use plus the board context; a feature checks its own switch there, features/live
// liveEnabled) and renders its own menu item(s): `role="menuitem"` buttons with the `dr-wk-menu__item` class, so the
// menu's arrow keys, Home/End and focus work for them as for the built-ins. `close(refocus)` closes the menu (true:
// the Facilitate button gets the keyboard back).
//
// The pill: a feature may add one live part to the Facilitate button's pill ("4:58 · Vote · Poll"), after the built-in
// parts, with setFacilitatePill(canvas, id, part | null) (its own store calls it; null removes it). Parts are per board
// page (canvas) and never synced. The button reads them with useFacilitatePill.
import type { ComponentType } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../../lib/signals.ts'

/** The registered entries' ids (one line each here, through the lead). */
export type FacilitateExtraId = 'activities' | 'join-code' | 'breakouts'

/** What an entry's `shown` gets: the built-ins' facts and the board context. */
export interface FacilitateEntryInput {
  readonly ctx: CanvasFeatureContext
  /** a name-only guest (UI only: the api decides) */
  readonly guest: boolean
  /** may run the session (edit + an account): workshop-context useIsFacilitator */
  readonly facilitator: boolean
}

export interface FacilitateItemProps extends FacilitateEntryInput {
  /** closes the menu; true gives the keyboard back to the Facilitate button */
  close(refocus: boolean): void
}

export interface FacilitateEntrySpec {
  readonly id: FacilitateExtraId
  /** order among the registered entries (low first); every one comes after the built-ins */
  readonly order: number
  /** whether the menu offers it now (pure: no fetch, no write) */
  shown(input: FacilitateEntryInput): boolean
  /** its menu item(s) */
  readonly Item: ComponentType<FacilitateItemProps>
}

const entries = new Map<FacilitateExtraId, FacilitateEntrySpec>()

/** Adds (or replaces) an entry; returns its removal. Registered once, at module load or on the feature's mount. */
export function registerFacilitateEntry(spec: FacilitateEntrySpec): () => void {
  entries.set(spec.id, spec)
  return () => {
    if (entries.get(spec.id) === spec) entries.delete(spec.id)
  }
}

/** The registered entries the menu shows now, in order. An entry whose `shown` throws is left out. */
export function facilitateExtras(input: FacilitateEntryInput): FacilitateEntrySpec[] {
  return [...entries.values()]
    .filter((e) => {
      try {
        return e.shown(input)
      } catch {
        return false
      }
    })
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ---- the pill --------------------------------------------------------------------------------------------------------

/** One registered entry's live part of the pill ("Poll", "Group 2 · 8:30"). */
export interface FacilitatePillExtra {
  readonly id: FacilitateExtraId
  /** what the pill shows, short (at most 24 characters are shown) */
  readonly text: string
  /** what a screen reader says for it ("a poll is open") */
  readonly spoken: string
}

const PILL_ORDER: Readonly<Record<FacilitateExtraId, number>> = { activities: 0, 'join-code': 1, breakouts: 2 }
const pills = new WeakMap<object, Atom<readonly FacilitatePillExtra[]>>()
const pillOf = (canvas: object): Atom<readonly FacilitatePillExtra[]> => {
  let a = pills.get(canvas)
  if (!a) {
    a = atom<readonly FacilitatePillExtra[]>('lobby-facilitate-pill', [])
    pills.set(canvas, a)
  }
  return a
}

/** Sets (or, with null, removes) entry `id`'s part of this board page's pill. */
export function setFacilitatePill(
  canvas: object,
  id: FacilitateExtraId,
  part: { text: string; spoken: string } | null,
): void {
  const a = pillOf(canvas)
  const rest = a.get().filter((p) => p.id !== id)
  const next = part ? [...rest, { id, text: part.text.slice(0, 24), spoken: part.spoken }] : rest
  a.set(next.sort((x, y) => PILL_ORDER[x.id] - PILL_ORDER[y.id]))
}

/** This board page's registered pill parts, in entry order (no hook: tests and non-React readers). */
export const facilitatePillExtras = (canvas: object): readonly FacilitatePillExtra[] => pillOf(canvas).get()

/** The Facilitate button's reader of the registered pill parts. */
export function useFacilitatePill(canvas: object): readonly FacilitatePillExtra[] {
  return useValue(pillOf(canvas))
}
