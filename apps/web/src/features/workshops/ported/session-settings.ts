// OWNER: 3f. The session's facilitation settings on the Excalidraw page: "Hide note authors" (RETRO-03a)
// and "Hide everyone's cursors" (RETRO-07a), set by a facilitator in the workshop popover. They are the
// board document's `workshop` key (lb_doc, canvas-schema doc.ts `WorkshopDocValue`; the tldraw board's
// `document.meta.drWorkshop`, features/workshops/session-settings.ts), written with `canvas.doc.set`:
// synced to everyone, stored with the board, never an undo step, and refused by the server from anyone
// who may not facilitate.
//
// Readers: this feature (the <html> attribute for note attribution, the cursor filter, reaction
// placement) and, on the Excalidraw page, present-export (3e: exports drop note authors, present mode
// hides cursors) through `workshopSettingsOf`.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'

/** The lb_doc key (canvas-schema doc.ts). */
export const WORKSHOP_DOC_KEY = 'workshop'
/** On <html> while note authors are hidden (whatever draws note attribution hides it; workshops.css). */
export const HIDE_AUTHORS_ATTR = 'data-dr-hide-authors'

export interface SessionSettings {
  /** Sticky notes show no "last edited by" name, on the board, in Present and in exports. */
  readonly hideNoteAuthors: boolean
  /** Nobody sees other people's cursors (each person still sees their own pointer and laser). */
  readonly hideCursors: boolean
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = { hideNoteAuthors: false, hideCursors: false }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The settings in a `workshop` doc value (anything missing or malformed reads as off). */
export function parseWorkshopDoc(value: unknown): SessionSettings {
  if (!isObject(value)) return DEFAULT_SESSION_SETTINGS
  return { hideNoteAuthors: value.hideNoteAuthors === true, hideCursors: value.hideCursors === true }
}

/** Reactive (inside useValue / react): the board's session settings. */
export function workshopSettingsOf(canvas: LobbyCanvas): SessionSettings {
  return parseWorkshopDoc(canvas.doc.get(WORKSHOP_DOC_KEY))
}

/** Facilitators only (the sync server refuses the key from anyone else). The whole value is written. */
export function writeWorkshopSettings(canvas: LobbyCanvas, patch: Partial<SessionSettings>): void {
  canvas.doc.set({ [WORKSHOP_DOC_KEY]: { ...workshopSettingsOf(canvas), ...patch } })
}
