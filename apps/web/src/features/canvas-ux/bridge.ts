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

/** The open dock panel, mirrored from FeatureContext.activePanel for module-level components. */
export const activePanel = perEditor<string | null>('dr-active-panel', () => null)

// ---- minimap (MAK-11): one per-browser preference, like tldraw's own (which lives in React state and
// so cannot be toggled from a shortcut).
const MINIMAP_KEY = 'draftroom:minimap-open'
function readMinimapPref(): boolean {
  try {
    const v = localStorage.getItem(MINIMAP_KEY)
    return v === null ? true : v === 'true'
  } catch {
    return true
  }
}
export const minimapOpen = atom(
  'dr-minimap-open',
  typeof localStorage === 'undefined' ? true : readMinimapPref(),
)
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
