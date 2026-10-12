// OWNER: WS4 (wave N, N4-3). What the highlights show and how the tour walks it: the page's state per canvas, and the
// pure plans (which outlines, which stop is next). Nothing here touches the board: the outlines are an overlay and the
// tour moves the camera only.
import { VISIT_HIGHLIGHT_MAX_OUTLINES } from '@draftroom/contracts'
import type { Bounds, LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'
import type { VisitChanges } from './model.ts'

export type HighlightKind = 'added' | 'changed' | 'removed'

export interface VisitsView {
  readonly changes: VisitChanges
  /** the visit this open stored (the api's `seenAt`): what "Mark all seen" acknowledges on this tab */
  readonly visitSeenAt: number
  /** the last stop of the tour (an index into the stops), -1 before the first */
  readonly tour: number
  /** the outlines are showing (they fade after VISIT_HIGHLIGHT_FADE_MS, or on Mark all seen) */
  readonly outlines: boolean
  /** hidden for this page with the chip's ×, or after Mark all seen */
  readonly hidden: boolean
  /** the list of removed items is open */
  readonly removedOpen: boolean
}

const views = new WeakMap<LobbyCanvas, Atom<VisitsView | null>>()

/** The page's highlights on `canvas` (null: none to show). Reactive. */
export function visitsView(canvas: LobbyCanvas): Atom<VisitsView | null> {
  let a = views.get(canvas)
  if (!a) {
    a = atom<VisitsView | null>('lobby-visits-view', null)
    views.set(canvas, a)
  }
  return a
}

export interface OutlineChoice {
  readonly id: string
  readonly kind: 'added' | 'changed'
}

export interface OutlinePlan {
  /** at most `cap` live elements to outline: the added first, then the changed, in scene order */
  readonly shown: readonly OutlineChoice[]
  /** how many more there are (counted in the chip, not drawn) */
  readonly rest: number
}

/** Which outlines to draw: the added and the changed, at most VISIT_HIGHLIGHT_MAX_OUTLINES; the rest are counted. */
export function planOutlines(changes: VisitChanges, cap: number = VISIT_HIGHLIGHT_MAX_OUTLINES): OutlinePlan {
  const all: OutlineChoice[] = [
    ...changes.added.map((id): OutlineChoice => ({ id, kind: 'added' })),
    ...changes.changed.map((id): OutlineChoice => ({ id, kind: 'changed' })),
  ]
  return { shown: all.slice(0, Math.max(0, cap)), rest: Math.max(0, all.length - cap) }
}

export interface TourStop {
  readonly id: string
  readonly kind: HighlightKind
  readonly bounds: Bounds
}

/**
 * The stops of "Next change", in the chip's order (added, changed, removed): each with the place it has now
 * (`boundsOf`), or for a removed item the place a checkpoint knew it at. What has no place is skipped.
 */
export function tourStops(changes: VisitChanges, boundsOf: (id: string) => Bounds | null): TourStop[] {
  const stops: TourStop[] = []
  for (const [kind, ids] of [
    ['added', changes.added],
    ['changed', changes.changed],
  ] as const)
    for (const id of ids) {
      const bounds = boundsOf(id)
      if (bounds && bounds.width >= 0 && bounds.height >= 0) stops.push({ id, kind, bounds })
    }
  for (const r of changes.removed) if (r.bounds) stops.push({ id: r.id, kind: 'removed', bounds: r.bounds })
  return stops
}

/** The stop after `current` (-1: before the first), wrapping round; -1 when there is none. */
export function nextStop(current: number, count: number): number {
  if (count <= 0) return -1
  return (current + 1 + count) % count
}

/** The camera for a stop: fit its bounds, never magnifying (a note is not a close-up). */
export const TOUR_ZOOM = { animate: true, maxZoom: 1, inset: 120 } as const
