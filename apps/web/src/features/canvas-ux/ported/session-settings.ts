// The board's facilitation settings on the Excalidraw canvas: the `workshop` key of the board document
// (lb_doc, canvas-schema doc.ts WorkshopDocValue; the tldraw page's `drWorkshop` document meta,
// features/workshops/session-settings.ts). canvas-ux's board menu reads and toggles "Hide note authors";
// the workshops feature (3f) owns the rest of the setting's behaviour. Written with `canvas.doc.set`
// (never an undo step); the server lets only facilitators (editors, owners) change it.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'

export interface SessionSettings {
  /** Sticky notes show no "last edited by" name, on the board, in Present and in exports. */
  readonly hideNoteAuthors: boolean
  /** Nobody sees other people's cursors. */
  readonly hideCursors: boolean
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = { hideNoteAuthors: false, hideCursors: false }

/** The settings in a `workshop` value (anything missing or malformed reads as off). Pure. */
export function parseSessionSettings(raw: unknown): SessionSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_SESSION_SETTINGS
  const r = raw as Record<string, unknown>
  return { hideNoteAuthors: r.hideNoteAuthors === true, hideCursors: r.hideCursors === true }
}

/** Reactive (inside useValue / react). */
export function readSessionSettings(canvas: Pick<LobbyCanvas, 'doc'>): SessionSettings {
  return parseSessionSettings(canvas.doc.get('workshop'))
}

/** Facilitators only (the sync server refuses the key from anyone else). */
export function writeSessionSettings(canvas: Pick<LobbyCanvas, 'doc'>, patch: Partial<SessionSettings>) {
  canvas.doc.set({ workshop: { ...readSessionSettings(canvas), ...patch } })
}
