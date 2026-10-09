// L8-3: the Pieces panel's state and keys, apart from React so they run in Node tests. The panel is a
// combobox: the search box keeps the keyboard, and the arrow keys move which piece is the active one (the
// option it points at with aria-activedescendant); Enter inserts the active piece. Typing or picking a
// category starts the list again from its first piece.
import {
  type PieceCategory,
  type PieceId,
  type PieceInfo,
  searchPieces,
} from '@draftroom/templates/pieces/catalog'

export interface PanelState {
  readonly query: string
  readonly category: PieceCategory | 'all'
  /** index into `resultsOf(state)` */
  readonly active: number
}

export const INITIAL: PanelState = { query: '', category: 'all', active: 0 }

export const resultsOf = (s: Pick<PanelState, 'query' | 'category'>): PieceInfo[] =>
  searchPieces(s.query, s.category)

export type PanelAction =
  | { type: 'query'; query: string }
  | { type: 'category'; category: PieceCategory | 'all' }
  | { type: 'move'; by: 1 | -1 }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'point'; index: number }

const clamp = (i: number, n: number) => (n === 0 ? 0 : Math.max(0, Math.min(n - 1, i)))

export function reduce(s: PanelState, a: PanelAction): PanelState {
  switch (a.type) {
    case 'query':
      return { ...s, query: a.query, active: 0 }
    case 'category':
      return { ...s, category: a.category, active: 0 }
    case 'move': {
      const n = resultsOf(s).length
      return n === 0 ? s : { ...s, active: (s.active + a.by + n) % n }
    }
    case 'home':
      return { ...s, active: 0 }
    case 'end':
      return { ...s, active: clamp(resultsOf(s).length - 1, resultsOf(s).length) }
    case 'point':
      return { ...s, active: clamp(a.index, resultsOf(s).length) }
  }
}

export interface KeyResult {
  readonly state: PanelState
  /** a piece to insert */
  readonly insert?: PieceId
  /** the key was used (the panel stops it) */
  readonly handled: boolean
  /** Escape with nothing typed: the panel closes */
  readonly close?: true
}

/** What a key does in the search box (`key` as `KeyboardEvent.key`). */
export function onKey(s: PanelState, key: string): KeyResult {
  switch (key) {
    case 'ArrowDown':
      return { state: reduce(s, { type: 'move', by: 1 }), handled: true }
    case 'ArrowUp':
      return { state: reduce(s, { type: 'move', by: -1 }), handled: true }
    case 'Home':
      // in a search box Home moves the caret: only with an empty query does it mean "the first piece"
      return s.query ? { state: s, handled: false } : { state: reduce(s, { type: 'home' }), handled: true }
    case 'End':
      return s.query ? { state: s, handled: false } : { state: reduce(s, { type: 'end' }), handled: true }
    case 'Enter': {
      const r = resultsOf(s)[clamp(s.active, resultsOf(s).length)]
      return r ? { state: s, insert: r.id, handled: true } : { state: s, handled: true }
    }
    case 'Escape':
      return s.query
        ? { state: reduce(s, { type: 'query', query: '' }), handled: true }
        : { state: s, handled: true, close: true }
    default:
      return { state: s, handled: false }
  }
}

/** The drag payload of a piece (text/plain, so the board's drop reads it as text): `lobby-piece:<id>`. */
export const DRAG_PREFIX = 'lobby-piece:'
export const dragPayload = (id: PieceId) => `${DRAG_PREFIX}${id}`

/** The piece id a dropped text names, or null (anything else is someone else's text). */
export function pieceOfDrop(text: string): PieceId | null {
  const t = text.trim()
  if (!t.startsWith(DRAG_PREFIX)) return null
  const id = t.slice(DRAG_PREFIX.length)
  return searchPieces('').find((p) => p.id === id)?.id ?? null
}
