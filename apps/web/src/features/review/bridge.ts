// OWNER: WS1 (wave S). The board page's review store, per canvas, shared by the feature's declarations (menus, the
// selection bar, the panel), its overlay layers, the viewer's header slot and WS4's review page. Reading it inside
// `useValue`/`computed` is reactive (a layer can render before the feature mounts).

import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { atom } from '../../lib/signals.ts'
import type { ReviewStore } from './store.ts'

export interface Review {
  readonly store: ReviewStore
  readonly ctx: CanvasFeatureContext
}

const slots = new WeakMap<LobbyCanvas, Review>()
const installs = atom('review.installs', 0)

export function setReview(canvas: LobbyCanvas, r: Review | null): void {
  if (r) slots.set(canvas, r)
  else slots.delete(canvas)
  installs.set(installs.get() + 1)
}

/** The board page's review (null before the feature mounts, or with the status switch off). */
export function reviewOf(canvas: LobbyCanvas): Review | null {
  installs.get()
  return slots.get(canvas) ?? null
}
