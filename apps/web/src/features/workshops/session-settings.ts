// Facilitation settings for the whole session, set by a facilitator (anyone who may edit the board)
// in the Timer / workshop popover: hide note authors (RETRO-03a) and hide everyone's cursors
// (RETRO-07a). Stored in the tldraw document record's `meta` (key `drWorkshop`), so they are synced
// to everyone by the board's own sync, persist with the board, and never enter anyone's undo history
// (`editor.updateDocumentSettings` writes with history: 'ignore'). Read-only roles cannot change the
// document, so only facilitators can change them; everyone applies them.
//
// Who reads them: this feature (html[data-dr-hide-authors] for the canvas and Present, see
// workshops.css) and present-export (exports drop note authors; the CollaboratorCursor slot hides
// other people's cursors).

import type { Editor } from 'tldraw'

export const SESSION_META_KEY = 'drWorkshop'
/** On <html> while note authors are hidden (workshops.css hides tldraw's `.tl-note__attribution`). */
export const HIDE_AUTHORS_ATTR = 'data-dr-hide-authors'

export interface SessionSettings {
  /** Sticky notes show no "last edited by" name, on the board, in Present and in exports. */
  hideNoteAuthors: boolean
  /** Nobody sees other people's cursors (each person still sees their own pointer and laser). */
  hideCursors: boolean
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = { hideNoteAuthors: false, hideCursors: false }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The settings in a document record's meta (anything missing or malformed reads as off). */
export function parseSessionSettings(meta: unknown): SessionSettings {
  const raw = isObject(meta) ? meta[SESSION_META_KEY] : undefined
  if (!isObject(raw)) return DEFAULT_SESSION_SETTINGS
  return { hideNoteAuthors: raw.hideNoteAuthors === true, hideCursors: raw.hideCursors === true }
}

/** The new document meta with `patch` applied (other features' meta keys are kept). */
export function withSessionSettings(meta: unknown, patch: Partial<SessionSettings>): Record<string, unknown> {
  const base = isObject(meta) ? meta : {}
  return { ...base, [SESSION_META_KEY]: { ...parseSessionSettings(base), ...patch } }
}

/** Reactive (inside useValue / react) and cheap. */
export function readSessionSettings(editor: Editor): SessionSettings {
  return parseSessionSettings(editor.getDocumentSettings().meta)
}

/** Facilitators only (the sync server refuses document writes from read-only roles). */
export function writeSessionSettings(editor: Editor, patch: Partial<SessionSettings>) {
  const doc = editor.getDocumentSettings()
  editor.updateDocumentSettings({ meta: withSessionSettings(doc.meta, patch) as typeof doc.meta })
}
