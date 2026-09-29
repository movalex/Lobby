// The save indicator on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §2.5.7): the engine
// core's SaveStatus ("Saved, exactly": nothing dirty, in flight or queued, every push acknowledged after
// COMMIT) shown with the tldraw page's indicator (SaveStatus.tsx) and words (copy.ts).
//
//   engine state   page state                 indicator
//   (no welcome)   connecting                 Connecting…
//   saved          ready                      Saved (View only for read-only roles; Saving… while an
//                                             upload of this tab is still on its way)
//   saving         ready                      Saving…
//   offline        after a disconnect         Offline / "Offline — N changes on this device"
//   not-saved      ready                      Change not saved (the reject code's reason in the title)
//   retrying       ready                      Can't save right now — retrying
//   (any)          terminal close             Not saved — connection ended
//
// Pure: no DOM, no engine, no tldraw (Node-tested).

import type { SaveStatus as EngineSaveStatus } from '../canvas/sync/types.ts'
import { engineOfflineLabel, engineOfflineTitle, engineRejectTitle } from './copy.ts'
import type { SaveStatusView } from './SaveStatus.tsx'
import type { DisplayState } from './useSaveStatus.ts'

export interface EngineSaveInput {
  readonly status: EngineSaveStatus
  /** the first `welcome` of this page was processed */
  readonly welcomed: boolean
  /** the socket closed for good (4099) */
  readonly terminal: boolean
  /** the session may not write (the welcome says read-only, or the role cannot edit) */
  readonly readonly: boolean
  /** a name-only guest: offline changes are kept in this tab only */
  readonly guest: boolean
  /** this tab's uploads in flight */
  readonly uploading: number
  /** the board role (a commenter's read-only line says her comments are saved) */
  readonly role?: string
}

/** The indicator's state for the engine's status. */
export function engineDisplayState(i: EngineSaveInput): DisplayState {
  if (i.terminal) return 'error'
  const s = i.status
  if (!i.welcomed && s.state === 'offline') return s.offlineChanges > 0 ? 'offline-pending' : 'connecting'
  switch (s.state) {
    case 'saved':
      if (i.uploading > 0) return 'saving'
      return i.readonly ? 'readonly' : 'saved'
    case 'saving':
      return 'saving'
    case 'offline':
      return s.offlineChanges > 0 ? 'offline-pending' : 'offline'
    case 'not-saved':
      return 'rejected'
    case 'retrying':
      return 'retrying'
  }
}

/** The view SaveStatus.tsx renders, with the engine's own words where they differ. */
export function engineSaveView(
  i: EngineSaveInput,
  state: DisplayState = engineDisplayState(i),
): SaveStatusView {
  const view: SaveStatusView = {
    state,
    rejection: null,
    readonly: i.readonly,
    uploading: i.uploading,
    ...(i.role !== undefined ? { role: i.role } : {}),
  }
  if (state === 'offline-pending' || state === 'offline') {
    const n = i.status.offlineChanges
    return { ...view, label: engineOfflineLabel(n), title: engineOfflineTitle(n, i.guest) }
  }
  if (state === 'rejected') return { ...view, title: engineRejectTitle(i.status.lastReject?.code) }
  return view
}

/**
 * Leaving now would lose changes: only a guest's (their queue is in memory). A member's dirty and queued
 * changes are in this tab's IndexedDB queue, which the reloaded tab (same tab id) replays.
 */
export function engineUnloadRisk(i: EngineSaveInput): boolean {
  if (i.uploading > 0) return true
  return i.guest && i.status.pending > 0
}
