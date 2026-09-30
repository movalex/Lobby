// User-facing words for the save indicator (WRK-03) and the per-property undo notices (WRK-05).
// Pure functions: unit tested in copy.test.ts, rendered by SaveStatus.tsx and BoardPage.

import type { UndoReplayReport } from './perPropUndo.ts'
import type { Rejection } from './saveTracker.ts'
import type { DisplayState } from './useSaveStatus.ts'

export const SAVE_LABEL: Record<DisplayState, string> = {
  connecting: 'Connecting…',
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Offline',
  'offline-pending': 'Offline — changes will sync',
  rejected: 'Change not saved',
  error: 'Not saved — connection ended',
  // The tracker cannot read this protocol version, so it never claims "Saved" (fail safe).
  unsupported: 'Live',
  readonly: 'View only',
  retrying: "Can't save right now — retrying",
}

const SAVE_TITLE: Record<DisplayState, string> = {
  connecting: 'Connecting to the board server',
  saved: 'Every change you made is stored on the board server',
  saving: 'Sending your latest changes to the board server',
  offline:
    'Offline: nothing is waiting to be saved. Changes you make now will sync when the connection returns.',
  'offline-pending':
    'Offline: your latest changes are kept in this tab only and will sync when the connection returns. Reloading or closing the tab now would lose them.',
  rejected: 'The board server did not accept your last change, so it was undone',
  error: 'The connection to this board ended. Changes that were not saved yet are lost.',
  unsupported: 'Connected. This version cannot confirm that your changes are saved.',
  // Never "not saved": a commenter's comments ARE saved, and a viewer has nothing unsaved (RETRO-17).
  readonly: 'You can look around; only people who can edit change this board',
  retrying:
    'The board server cannot store changes right now. Lobby keeps trying; your changes stay on this device until then.',
}

/** A commenter's read-only indicator says what she can do, and that it is kept (RETRO-17). */
export const COMMENTER_READONLY_LABEL = 'Can comment · comments are saved'
const COMMENTER_READONLY_TITLE =
  'You can comment: your comments are saved. Only people who can edit change the board itself.'

/** The indicator's words for `state`; commenters get their own read-only line. */
export function saveLabel(state: DisplayState, role?: string): string {
  if (state === 'readonly' && role === 'commenter') return COMMENTER_READONLY_LABEL
  return SAVE_LABEL[state]
}

type RejectionCause = 'text-lease' | 'readonly' | 'deleted-remotely' | 'refused'

function rejectionCause(rejection: Rejection, readonly: boolean): RejectionCause {
  const msg = rejection.serverMessage as { type?: unknown } | null | undefined
  if (msg && typeof msg === 'object' && msg.type === 'text-lease-denied') return 'text-lease'
  if (readonly) return 'readonly'
  if (rejection.records.some((r) => r.kind === 'deleted-remotely')) return 'deleted-remotely'
  return 'refused'
}

/** The server's reason for a rejection, in words, or null when it gave none we recognise. */
function rejectionReason(rejection: Rejection, readonly: boolean): string | null {
  switch (rejectionCause(rejection, readonly)) {
    case 'text-lease':
      return 'someone else is editing that text'
    case 'readonly':
      return 'you can only view this board'
    case 'deleted-remotely':
      return 'someone else deleted that object'
    case 'refused':
      return null
  }
}

/** Tooltip for the indicator; a rejection says why when the server told us. */
export function saveTitle(
  state: DisplayState,
  rejection: Rejection | null,
  readonly: boolean,
  uploading = 0,
  role?: string,
): string {
  if (state === 'readonly' && role === 'commenter') return COMMENTER_READONLY_TITLE
  if (state === 'rejected' && rejection) {
    const why = rejectionReason(rejection, readonly)
    if (why) return `Your last change was not saved: ${why}`
  }
  if (state === 'saving' && uploading > 0)
    return uploading === 1
      ? 'Uploading a file to the board server'
      : `Uploading ${uploading} files to the board server`
  return SAVE_TITLE[state]
}

/**
 * The toast for a rejected change, or null when another notice already says it (the text-lease
 * denial has its own "<name> is editing this text" toast).
 */
export function rejectionNotice(rejection: Rejection, readonly: boolean): string | null {
  switch (rejectionCause(rejection, readonly)) {
    case 'text-lease':
      return null
    case 'readonly':
      return 'You can only view this board, so your change was not saved.'
    case 'deleted-remotely':
      return 'Someone else deleted that object, so your change to it was not saved.'
    case 'refused':
      return 'The board did not accept your last change, so it was undone.'
  }
}

/** The notice after an undo/redo that left something alone (docs/research/undo-per-prop.md §4.2). */
export function undoNotice(r: UndoReplayReport): string | null {
  const gone = r.skipped.filter((s) => s.reason === 'deleted' || s.reason === 'orphan').length
  if (gone)
    return gone === 1
      ? 'Someone deleted that object, so it was not restored.'
      : `Someone deleted ${gone} of those objects, so they were not restored.`
  if (r.skipped.some((s) => s.reason === 'locked'))
    return 'Someone is editing that text, so it was left as is.'
  if (r.noop) return 'Someone changed this since, so there was nothing left to undo.'
  return null // partial skips of fields someone else changed are silent
}

// ---- the Excalidraw engine's indicator (docs/EXCALIDRAW-MIGRATION.md §2.5.7) --------------------------------
//
// The engine keeps offline changes in this browser (IndexedDB, per tab, §2.5.6), so its offline line says
// how many there are and that they are on this device; a guest's are in memory only. A change the server
// refused carries its reject code, said in words here.

/** "Offline — 3 changes on this device" (the engine's queue; none: plain "Offline"). */
export function engineOfflineLabel(changes: number): string {
  if (changes <= 0) return SAVE_LABEL.offline
  return `Offline — ${changes} change${changes === 1 ? '' : 's'} on this device`
}

/** The offline tooltip: a member's changes survive a reload; a guest's live in this tab only. */
export function engineOfflineTitle(changes: number, guest: boolean): string {
  if (changes <= 0) return SAVE_TITLE.offline
  return guest
    ? 'Offline: your latest changes are kept in this tab only and will sync when the connection returns. Reloading or closing the tab now would lose them.'
    : 'Offline: your latest changes are kept on this device and will sync when the connection returns, also after a reload.'
}

const ENGINE_REJECT_REASON: Readonly<Record<string, string>> = {
  READ_ONLY: 'you can only view this board',
  LOCKED: 'that object is locked',
  LEASED: 'someone else is editing that text',
  GONE: 'someone else deleted that object',
  ELEMENT_LIMIT: 'the board is full',
  GUEST_LIMIT: 'the guest limit of this board is reached',
  VOTE_OPEN: 'a vote is open',
  STALE: 'someone changed it while you were offline',
  TOO_LARGE: 'it is too large',
}

/** The words for an engine reject code, or null for a code with none (INVALID, TYPE_CHANGE, …). */
export function engineRejectReason(code: string | null | undefined): string | null {
  return (code && ENGINE_REJECT_REASON[code]) || null
}

/** The tooltip of "Change not saved" for an engine reject. */
export function engineRejectTitle(code: string | null | undefined): string {
  const why = engineRejectReason(code)
  return why ? `Your last change was not saved: ${why}` : SAVE_TITLE.rejected
}

/** The toast for an engine reject (null for LEASED: the lease notice already says who is typing). */
export function engineRejectNotice(code: string, holder?: string | null): string | null {
  if (code === 'LEASED') return holder ? `Change not saved — ${holder} is typing in this note` : null
  if (code === 'READ_ONLY') return 'You can only view this board, so your change was not saved.'
  if (code === 'GONE') return 'Someone else deleted that object, so your change to it was not saved.'
  const why = engineRejectReason(code)
  return why ? `Change not saved — ${why}.` : 'The board did not accept your last change, so it was undone.'
}
