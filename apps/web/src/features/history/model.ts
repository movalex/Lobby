// Pure logic of the history panel (unit-tested in node): labels, default names, who may do what
// (UI hints only — the API and sync server enforce), and the texts shown after an action.

import type { DeletedShapeEntry, HistoryBoardCreated, RestoreDeletedResponse } from '@draftroom/contracts'
import { pluralize } from '../../lib/format.ts'
import {
  type BoardRole,
  type BoardStatus,
  can,
  canCreateContent,
  type WorkspaceRole,
} from '../../lib/permissions.ts'
import { timeOfDay } from '../sharing/model.ts'

const TYPE_LABELS: Record<string, string> = {
  note: 'Sticky note',
  text: 'Text',
  geo: 'Shape',
  frame: 'Frame',
  arrow: 'Connector',
  line: 'Line',
  draw: 'Drawing',
  highlight: 'Highlight',
  image: 'Image',
  video: 'Video',
  embed: 'Embed',
  bookmark: 'Link',
  group: 'Group',
  'dr-file-card': 'File',
}

export function shapeTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Object'
}

/** The row title: the object's own text/name, else what kind of object it was. */
export function deletedTitle(entry: Pick<DeletedShapeEntry, 'label' | 'type'>): string {
  const label = entry.label.trim()
  return label || shapeTypeLabel(entry.type)
}

/** "Frame · 3 objects inside" / "Sticky note". */
export function deletedDetail(entry: Pick<DeletedShapeEntry, 'type' | 'childCount' | 'label'>): string {
  const kind = entry.label.trim() ? shapeTypeLabel(entry.type) : ''
  const inside = entry.childCount > 0 ? `${pluralize(entry.childCount, 'object')} inside` : ''
  return [kind, inside].filter(Boolean).join(' · ')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A useful default checkpoint name, e.g. "Checkpoint Sep 27, 2:05 PM" (R2-08: the time in the
 * browser's locale and hour cycle, like every other time on the board).
 */
export function defaultCheckpointName(now: Date = new Date(), locale?: string): string {
  return `Checkpoint ${MONTHS[now.getMonth()]} ${now.getDate()}, ${timeOfDay(now, locale)}`
}

/** What the name field submits: the typed name trimmed and capped, or the default. */
export function checkpointNameToSave(typed: string, now: Date = new Date()): string {
  const name = typed.replace(/\s+/g, ' ').trim()
  return (name || defaultCheckpointName(now)).slice(0, 120)
}

export interface HistoryPermissions {
  /** Save checkpoints, restore deleted objects (canvas editors of an active board). */
  canEdit: boolean
  /**
   * See (and fetch) "Recently deleted" at all. Editors only (authz-001): the list shows the text of
   * deleted objects, including notes deleted before the board was shared with a viewer, a commenter or
   * a review-link guest. The API requires `edit` for GET /api/boards/:bid/deleted too.
   */
  canSeeDeleted: boolean
  /**
   * Restore as new / duplicate: creators (domain access, `/api/me` `access.creator`) who are workspace
   * members and above; guests and outside accounts cannot create boards (the api answers 403).
   */
  canCreateBoards: boolean
  /** Duplicate with sharing settings (board owners). */
  canKeepSharing: boolean
}

export interface HistoryPermissionOptions {
  /**
   * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9): whether the caller may create boards at all
   * (`me.access.creator`; true for an api from before domain access, `reason: 'legacy'`).
   */
  creator: boolean
}

export function historyPermissions(
  role: BoardRole,
  status: BoardStatus,
  workspaceRole: WorkspaceRole | null | undefined,
  { creator }: HistoryPermissionOptions = { creator: true },
): HistoryPermissions {
  const canEdit = can(role, 'edit', status)
  return {
    canEdit,
    canSeeDeleted: canEdit,
    canCreateBoards: !!workspaceRole && canCreateContent(creator, workspaceRole) && can(role, 'view', status),
    canKeepSharing: can(role, 'manage_access', status),
  }
}

/** How an action shows: usable, shown but turned off (with the reason), or not offered at all. */
export type ActionState = 'on' | 'off' | 'hidden'

export interface CopyActions {
  duplicate: ActionState
  restoreAsNew: ActionState
  exportJson: ActionState
  /** Show the export-off reason (EXPORT_OFF_TEXT) next to the turned-off actions. */
  exportOff: boolean
}

/**
 * Duplicate, restore a checkpoint as a new board and the .json export are full copies of the board:
 * when the owner turned exporting off for viewers and commenters (`canExport` false), the api refuses
 * them (403 EXPORT_DISABLED), so they are shown turned off with the reason. People who cannot create
 * boards (guests) are not offered the first two at all.
 */
export const CHECKPOINTS_HINT =
  'A checkpoint keeps this board as it is now. Restoring one makes a new board that only you can see; this board is not changed.'

/**
 * The line under "Checkpoints". It promises restoring only to someone who is offered "Restore as new
 * board"; an outside account (domain access) is told who can, an unconfirmed one that it is paused.
 */
export function checkpointsHint(
  restoreAsNew: ActionState,
  access: { creator: boolean; reason: string },
): string {
  if (restoreAsNew !== 'hidden') return CHECKPOINTS_HINT
  const keeps = 'A checkpoint keeps this board as it is now.'
  if (access.creator) return keeps
  if (access.reason === 'outside')
    return `${keeps} Only people at Dark Burn Creative or Trailer Park Group can restore one as a new board.`
  if (access.reason === 'unconfirmed')
    return `${keeps} Restoring one as a new board is paused until Lobby can confirm your account.`
  return keeps
}

export function copyActions(perms: HistoryPermissions, canExport: boolean): CopyActions {
  const creating: ActionState = !perms.canCreateBoards ? 'hidden' : canExport ? 'on' : 'off'
  return {
    duplicate: creating,
    restoreAsNew: creating,
    exportJson: canExport ? 'on' : 'off',
    exportOff: !canExport,
  }
}

/** One line after a "Recently deleted" restore. */
export function restoreSummary(r: RestoreDeletedResponse): string {
  if (r.restored.length === 0) {
    if (r.skipped.some((s) => s.reason === 'exists')) return 'That object is already back on the board.'
    return 'Nothing could be restored. It may have been restored by someone else.'
  }
  const parts = [`Restored ${pluralize(r.restored.length, 'object')}`]
  // `bindings` counts connector ENDS attached again: one connector bound at both ends is 2. Saying
  // "2 connectors" for a single restored connector would be wrong, so this counts connections.
  if (r.bindings > 0) parts.push(`reconnected ${pluralize(r.bindings, 'connection')}`)
  if (r.reparented > 0)
    parts.push(`${pluralize(r.reparented, 'object')} placed on the board (the frame is gone)`)
  return `${parts.join(', ')}.`
}

/** One line after restore-as-new / duplicate. */
export function createdSummary(kind: 'restore' | 'duplicate', created: HistoryBoardCreated): string {
  const head =
    kind === 'restore'
      ? `Restored as “${created.board.title}”, a new board only you can see.`
      : `Made “${created.board.title}”${created.board.visibility === 'private' ? ', a private copy only you can see' : ''}.`
  const files =
    created.droppedFiles > 0 ? ` ${pluralize(created.droppedFiles, 'file')} could not be carried over.` : ''
  // What keep sharing left out of a copy in an internal-only scope (wave J pre-deploy review IO-2a), in the
  // server's words. The files are said above from droppedFiles, so their notes ("file(s)") are skipped.
  const sharing = created.warnings.filter((w) => !w.includes('file(s)')).map((w) => ` ${w}`)
  return `${head}${files}${sharing.join('')}`
}

/** "Pitch v2.lobby.json": the board title with characters file systems reject replaced. */
export function archiveFileName(title: string): string {
  const safe = [...title]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '-' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
  return `${safe || 'board'}.lobby.json`
}

/** The shapes to select after a restore: those now on the board, in the order the server gave. */
export function restoredOnBoard(restored: readonly string[], has: (id: string) => boolean): string[] {
  return restored.filter((id) => has(id))
}

/**
 * A document change that can change the "Recently deleted" list: a shape removed (by anyone), or a
 * listed shape coming back (undo, another tab's restore).
 */
export function touchesDeleted(
  changes: { added: Record<string, { typeName: string }>; removed: Record<string, { typeName: string }> },
  listed: ReadonlySet<string>,
): boolean {
  for (const r of Object.values(changes.removed)) if (r.typeName === 'shape') return true
  for (const id of Object.keys(changes.added)) if (listed.has(id)) return true
  return false
}
