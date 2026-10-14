// Wave M (W2, M2-1, FTU-6): the board's one top-centre stack, as a model (pure, Node-tested). At the top centre of
// the canvas, in a meeting, five things used to be placed on their own at `top: 12px; left: 50%` and sat on one
// another: the invitation to a presentation, the spotlight bar, the "Following" pill (and "Paused following"), the
// coach's chip, and the toasts under them (a toast came a fixed 100 px down, wherever the bars ended).
//
// Now they are one column (./top-centre.tsx), a flex column with a fixed gap, in this order, and the toasts follow
// its bottom edge. The column registers its box as the `top-centre` obstacle (lib/overlay-obstacles.ts) so popovers
// keep clear of it, and remote cursors and compass chips keep under or away from it (chrome.tsx).

/**
 * The things in the stack, top to bottom. The toasts are not one of them: they follow the stack's bottom edge. Wave N
 * adds 'since', the "Since you were here" chip (features/visits), under the follow pill. Wave P (P-047) adds 'ai': the
 * "Dana is using AI" pills of runs whose area is off screen (features/ai working.tsx), which sat at a fixed spot on
 * top of the since and coach chips (and of one another); the own run's busy pill already goes under the stack.
 * P-016 follow-up adds 'timer', the running session timer's pill (features/workshops TimerBanner), which shared the
 * spotlight's box and so was one box with it; it has its own place, above the spotlight bar.
 */
export const TOP_CENTRE_SLOTS = [
  'invite',
  'timer',
  'spotlight',
  'follow',
  'since',
  'coach',
  'ai',
  'feedback',
] as const
export type TopCentreSlot = (typeof TOP_CENTRE_SLOTS)[number]

/** The gap between two things in the stack, and between the stack and the toasts under it (px). */
export const TOP_CENTRE_GAP = 8
/** The stack's top edge in the canvas (px): 12 on a desktop, under the page's own top controls on a phone. */
export const TOP_CENTRE_TOP = { wide: 12, narrow: 60 } as const
/** A window this wide or narrower is `narrow` (the phone layout of the bars it replaces). */
export const TOP_CENTRE_NARROW_MAX = 560

/** Where a slot sits among the others (the CSS `order` of its box). */
export const slotOrder = (slot: TopCentreSlot): number => TOP_CENTRE_SLOTS.indexOf(slot)

export interface StackItem {
  readonly slot: TopCentreSlot
  /** its measured height (px); an item with no height (not drawn) takes no place and no gap */
  readonly height: number
}

export interface PlacedItem {
  readonly slot: TopCentreSlot
  /** px from the stack's own top */
  readonly top: number
  readonly bottom: number
}

export interface StackLayout {
  /** the drawn items in order, with their places */
  readonly items: readonly PlacedItem[]
  /** the stack's height (0 when nothing is drawn) */
  readonly height: number
  /** where the toasts start, from the stack's top: its bottom edge and one gap; null when nothing is drawn */
  readonly toastsTop: number | null
}

/**
 * The column laid out: items in `slotOrder` (whatever order they are given in), each under the one before with
 * `gap` between, items without a height left out. Each slot at most once (the last given wins).
 */
export function layoutStack(items: readonly StackItem[], gap: number = TOP_CENTRE_GAP): StackLayout {
  const bySlot = new Map<TopCentreSlot, number>()
  for (const i of items) if (Number.isFinite(i.height) && i.height > 0) bySlot.set(i.slot, i.height)
  const placed: PlacedItem[] = []
  let y = 0
  for (const slot of TOP_CENTRE_SLOTS) {
    const h = bySlot.get(slot)
    if (h === undefined) continue
    if (placed.length) y += gap
    placed.push({ slot, top: y, bottom: y + h })
    y += h
  }
  return { items: placed, height: y, toastsTop: placed.length ? y + gap : null }
}

/**
 * The top of the toasts (px from the canvas's top edge, or the page's: whatever `stackTop` is in): below the stack
 * with a gap, never above `minTop` (the toasts' own place when the stack is empty: under the page's top controls).
 */
export function toastsTopFor(layout: StackLayout, stackTop: number, minTop: number): number {
  return layout.toastsTop === null ? minTop : Math.max(minTop, stackTop + layout.toastsTop)
}
