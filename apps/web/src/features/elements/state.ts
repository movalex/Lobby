// OWNER: WS3 (wave Q). The Elements panel's page state, per board page (a WeakMap on the canvas: a closed board
// leaves nothing behind): which tab another entry asked for (the `pieces.open` command asks for Shapes), the open
// "Save to library" dialog and the selection it saves, and a counter the Library tab re-reads its list on.
import { type Atom, atom } from '../../lib/signals.ts'
import type { ElementTab } from './model.ts'

export interface ElementsPageState {
  /** a tab to show the next time the panel renders (then cleared) */
  readonly requestedTab: Atom<ElementTab | null>
  /** the selection being saved, or null when the dialog is closed */
  readonly saving: Atom<readonly string[] | null>
  /** +1 after every library change made on this page */
  readonly libraryVersion: Atom<number>
}

const pages = new WeakMap<object, ElementsPageState>()

export function elementsState(canvas: object): ElementsPageState {
  let s = pages.get(canvas)
  if (!s) {
    s = {
      requestedTab: atom<ElementTab | null>('elements.requestedTab', null),
      saving: atom<readonly string[] | null>('elements.saving', null),
      libraryVersion: atom('elements.libraryVersion', 0),
    }
    pages.set(canvas, s)
  }
  return s
}
