// OWNER: WS4 (wave T). Per-canvas state of the Kanban feature, shared by its declarations and its overlay components:
// the feature context, the column menu and the column being renamed. Reading it inside `useValue`/`computed` is
// reactive (an overlay can render before the feature mounts).
import type { CardStatus } from '@draftroom/canvas-schema/planning'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

export interface ColumnMenuRequest {
  readonly frameId: string
  /** the column the menu is for; null: the hidden columns' list */
  readonly status: CardStatus | null
  /** the button's client rect */
  readonly anchor: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

export interface KanbanState {
  readonly ctx: CanvasFeatureContext
  readonly menu: Atom<ColumnMenuRequest | null>
  readonly renaming: Atom<{ readonly frameId: string; readonly status: CardStatus } | null>
}

const slots = new WeakMap<LobbyCanvas, KanbanState>()
const installs = atom('kanban.installs', 0)

export function setKanbanState(canvas: LobbyCanvas, s: KanbanState | null): void {
  if (s) slots.set(canvas, s)
  else slots.delete(canvas)
  installs.set(installs.get() + 1)
}

export function kanbanStateOf(canvas: LobbyCanvas): KanbanState | null {
  installs.get()
  return slots.get(canvas) ?? null
}
