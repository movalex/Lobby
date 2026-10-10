// OWNER: W3 (wave L, L3-2). What the command palette lists and runs, shared by the board's palette and the
// dashboard's. No canvas, no React: the dashboard's palette chunk imports this file too.
import type { Rankable } from './scorer.ts'

/** One line of the palette. */
export interface PaletteEntry extends Rankable {
  /** unique within one open palette ('cmd:canvas-ux.toggle-lock', 'frame:<id>', 'ws:<board>:<object>') */
  readonly id: string
  readonly label: string
  /** the heading it is listed under ('Arrange', 'Tools', 'Frames', 'On this board') */
  readonly group: string
  /** its shortcut, formatted for this platform ('Ctrl+Shift+L', '⌘⇧L') */
  readonly kbd?: string
  /** a second line (a search hit's snippet, a board's project) */
  readonly detail?: string
  /** why it cannot run now, shown instead of hiding it; null or absent: it can */
  readonly disabledReason?: string | null
  /** runs it (the palette has closed by then) */
  run(): void
  /**
   * M3-2: the line is one of the "Try" section an empty palette starts with (what wave L offers, which an empty
   * field used to hide behind Undo and Redo): its place in the section, and the words it has there when they are
   * not its own ("Wrap up this board", with a sentence on what it does). The line keeps its id, so a pick is
   * remembered under its own key and typing finds it as before.
   */
  readonly starter?: { readonly rank: number; readonly label?: string; readonly detail?: string }
}

/** A group the palette fills after a pause in typing (the board's own search, the workspace's). */
export interface PaletteSearch {
  readonly id: string
  readonly title: string
  /** at most this many lines */
  readonly limit: number
  /** the hits for `query` (two or more characters); a superseded search is aborted through `signal` */
  find(query: string, signal: AbortSignal): Promise<readonly PaletteEntry[]>
}

/** Typing pauses this long before the searches go out (and only for two or more characters). */
export const PALETTE_SEARCH_DEBOUNCE_MS = 150
export const PALETTE_SEARCH_MIN_CHARS = 2
/** At most this many lines of the ranked index (the searches add theirs below). */
export const PALETTE_MAX_RESULTS = 40

/** Whether `entry` may run now. */
export const runnable = (entry: Pick<PaletteEntry, 'disabledReason'>): boolean => !entry.disabledReason

/**
 * What choosing `entry` does: a line that may run is run (after the palette closes); one that may not says
 * why and the palette stays open, nothing run.
 */
export function chooseEntry(
  entry: PaletteEntry,
): { readonly run: true } | { readonly run: false; readonly status: string } {
  return runnable(entry) ? { run: true } : { run: false, status: `${entry.label}: ${entry.disabledReason}` }
}

// ---- recents (per viewer, in this browser: a convenience, never shared) -------------------------------------

export const RECENTS_MAX = 12
const recentsKey = (viewer: string) => `lobby:palette-recents:${viewer}`

/** This viewer's recent palette picks, most recent first ([] when storage is missing, blocked or odd). */
export function readRecents(
  viewer: string,
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): string[] {
  try {
    const raw = storage?.getItem(recentsKey(viewer))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === 'string' && k.length <= 200).slice(0, RECENTS_MAX)
  } catch {
    return []
  }
}

/** Puts `key` first in this viewer's recents (nothing happens when storage throws). */
export function pushRecent(
  viewer: string,
  key: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
): string[] {
  const next = [key, ...readRecents(viewer, storage).filter((k) => k !== key)].slice(0, RECENTS_MAX)
  try {
    storage?.setItem(recentsKey(viewer), JSON.stringify(next))
  } catch {
    // not kept: the next palette has no recents
  }
  return next
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
