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
