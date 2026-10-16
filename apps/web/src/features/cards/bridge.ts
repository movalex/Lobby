// OWNER: WS4 (wave T). Per-canvas state of the cards feature, shared by its declarations (menus, the selection bar),
// its overlay components, the Kanban and the card table: the feature context, the people, and the open popover.
// Reading it inside `useValue`/`computed` is reactive (an overlay can render before the feature mounts).

import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'
import type { CardPopoverRequest } from '../planning/index.ts'
import type { People } from './people.ts'

export interface CardsState {
  readonly ctx: CanvasFeatureContext
  readonly people: People
  /** the open popover (one at a time), or null */
  readonly popover: Atom<CardPopoverRequest | null>
}

const slots = new WeakMap<LobbyCanvas, CardsState>()
const installs = atom('cards.installs', 0)

export function setCards(canvas: LobbyCanvas, s: CardsState | null): void {
  if (s) slots.set(canvas, s)
  else slots.delete(canvas)
  installs.set(installs.get() + 1)
}

export function cardsOf(canvas: LobbyCanvas): CardsState | null {
  installs.get()
  return slots.get(canvas) ?? null
}
