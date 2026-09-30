// The navigation feature's per-canvas UI state (the tldraw build's bridge.ts, on lib/signals.ts): the
// panels, overlays and commands of one board page share it through the canvas they run on. Nothing here
// is board state: the search query, the pending paste, the grid stepper and the first-view result are
// this tab's, and the minimap's open state is this browser's preference.

import type { LobbyCanvas, ScenePoint } from '../../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../../lib/signals.ts'
import type { SearchFilter } from '../../search-filter.ts'

function perCanvas<T>(name: string, initial: () => T) {
  const map = new WeakMap<LobbyCanvas, Atom<T>>()
  return (canvas: LobbyCanvas): Atom<T> => {
    let a = map.get(canvas)
    if (!a) {
      a = atom(name, initial())
      map.set(canvas, a)
    }
    return a
  }
}

/**
 * What the first view did when this board opened ('template:<id>', 'deep-link', 'restore', 'restore+fit',
 * 'start-view', 'start-view+fit', 'fit', 'first-frame', 'none', 'failed'), null until decided. Rendered
 * on the navigation overlay as `data-start-view`, so tests (and people debugging) know it has run.
 */
export const startViewResult = perCanvas<string | null>('nav-start-view', () => null)

// ---- minimap (MAK-11, PERF-03): closed unless this browser chose to open it; not mounted while closed

export const MINIMAP_KEY = 'draftroom:minimap-open'

/** The stored choice wins; nothing stored (or no storage) means closed. */
export function readMinimapPref(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    return store?.getItem(MINIMAP_KEY) === 'true'
  } catch {
    return false
  }
}
export const minimapOpen = atom('nav-minimap-open', readMinimapPref())
export function setMinimapOpen(open: boolean) {
  minimapOpen.set(open)
  try {
    localStorage.setItem(MINIMAP_KEY, String(open))
  } catch {
    // not persisted
  }
}

// ---- board search (MAK-12)

export interface SearchState {
  readonly query: string
  readonly filter: SearchFilter
  /** the highlighted result (Enter / click went there) */
  readonly activeId: string | null
  /** bumped by Ctrl/Cmd+F so an open panel re-focuses its input */
  readonly focusTick: number
}
export const searchState = perCanvas<SearchState>('nav-search', () => ({
  query: '',
  filter: 'all',
  activeId: null,
  focusTick: 0,
}))
/** Ids of the current matches (the canvas highlight overlay). */
export const searchMatches = perCanvas<readonly string[]>('nav-search-matches', () => [])

// ---- bulk paste prompt (COL-05)

export interface PendingPaste {
  readonly id: number
  /** the text/plain to split into notes */
  readonly text: string
  readonly cells: number
  /** scene point the notes are centred on */
  readonly center: ScenePoint
}
export const pendingPaste = perCanvas<PendingPaste | null>('nav-pending-paste', () => null)

// ---- arrange as grid (MAK-18): the grid last arranged in this tab, for the columns stepper

export interface GridSession {
  /** the selection it was arranged from (sorted ids) */
  readonly selection: readonly string[]
  /** fill order, kept when the column count changes */
  readonly order: readonly string[]
  readonly columns: number
  /** each arranged unit's element positions right after the layout: any later move ends the session */
  readonly placed: Readonly<Record<string, { readonly x: number; readonly y: number }>>
}
export const gridSession = perCanvas<GridSession | null>('nav-grid-session', () => null)

// ---- frames panel (DANA2-03): the frame a row click last went to (a second click selects it)

export const lastFrameJump = perCanvas<string | null>('nav-frame-jump', () => null)
