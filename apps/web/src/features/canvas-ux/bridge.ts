// Shared per-editor state for canvas-ux. The feature's overrides and components are module-level (the
// <Tldraw> props must stay referentially stable), so they reach the board's FeatureContext and the
// panels' UI state through these editor-keyed atoms instead of props.

import { type Atom, atom, type Editor } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import type { BulkPasteAnalysis } from './bulk-paste.ts'
import type { SearchFilter } from './search-filter.ts'

const contexts = new WeakMap<Editor, FeatureContext>()

/** The latest context for this editor (kept fresh by the overlay on every render). */
export function setFeatureCtx(editor: Editor, ctx: FeatureContext) {
  contexts.set(editor, ctx)
}
export function getFeatureCtx(editor: Editor): FeatureContext | undefined {
  return contexts.get(editor)
}

export function openPanel(editor: Editor, panelId: string) {
  getFeatureCtx(editor)?.openPanel(panelId)
}

/** Opens the panel, or closes the dock when that panel is already open (toolbar button). */
export function togglePanel(editor: Editor, panelId: string) {
  const ctx = getFeatureCtx(editor)
  ctx?.openPanel(activePanel(editor).get() === panelId ? null : panelId)
}

function perEditor<T>(name: string, initial: () => T) {
  const map = new WeakMap<Editor, Atom<T>>()
  return (editor: Editor): Atom<T> => {
    let a = map.get(editor)
    if (!a) {
      a = atom(name, initial())
      map.set(editor, a)
    }
    return a
  }
}

/**
 * What the start view did when this editor's board opened (applyStartView's result: 'template:<id>',
 * 'deep-link', 'restore', 'restore+fit', 'fit', 'none'), null until it has run. Rendered on the
 * overlay as data-start-view, so tests (and people debugging) know the first view has been decided.
 */
export const startViewResult = perEditor<string | null>('dr-start-view', () => null)

/** The open dock panel, mirrored from FeatureContext.activePanel for module-level components. */
export const activePanel = perEditor<string | null>('dr-active-panel', () => null)

// ---- minimap (MAK-11): one per-browser preference, like tldraw's own (which lives in React state and
// so cannot be toggled from a shortcut). PERF-03: closed unless this browser chose to open it. An open
// minimap redraws on every camera change, which heavy boards pay for on every frame while panning
// zoomed out; closed, it is not mounted at all. M (or the button) opens it, and the choice is kept.
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
export const minimapOpen = atom('dr-minimap-open', readMinimapPref())
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
  query: string
  filter: SearchFilter
  /** The highlighted result (Enter / click went there). */
  activeId: string | null
  /** Bumped by Ctrl/Cmd+F so an already-open panel re-focuses its input. */
  focusTick: number
}
export const searchState = perEditor<SearchState>('dr-search', () => ({
  query: '',
  filter: 'all',
  activeId: null,
  focusTick: 0,
}))
/** Ids of the current matches (for the canvas highlight overlay). */
export const searchMatches = perEditor<readonly string[]>('dr-search-matches', () => [])

// ---- bulk paste prompt (COL-05)
export interface PendingPaste {
  id: number
  /** The text/plain to split into notes. */
  text: string
  analysis: BulkPasteAnalysis
  /** Page point the notes are centred on. */
  center: { x: number; y: number }
  /** Paste as text: hand the original content back to tldraw's default handler. */
  asText(): void | Promise<void>
}
export const pendingPaste = perEditor<PendingPaste | null>('dr-pending-paste', () => null)

// ---- locked hint (F8)
export interface LockedHint {
  id: number
  /** The locked shape (the hit shape itself, or its locked frame / group). */
  sourceId: string
  message: string
  unlockLabel: string
  /** Page point of the click. */
  point: { x: number; y: number }
}
export const lockedHint = perEditor<LockedHint | null>('dr-locked-hint', () => null)

// ---- arrange as grid (MAK-18): the grid last arranged in this browser, for the columns stepper
export interface GridSession {
  /** The selection it was arranged from (sorted ids). */
  selection: string[]
  /** Fill order, kept when the column count changes. */
  order: string[]
  columns: number
  /** Each arranged shape's x/y right after the layout: any later move (by anyone) ends the session. */
  placed: Record<string, { x: number; y: number }>
}
export const gridSession = perEditor<GridSession | null>('dr-grid-session', () => null)
