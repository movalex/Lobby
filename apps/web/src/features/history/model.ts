// Pure logic of the history panel (unit-tested in node): labels, default names, who may do what
// (UI hints only — the API and sync server enforce), and the texts shown after an action.

import type { DeletedShapeEntry, HistoryBoardCreated, RestoreDeletedResponse } from '@draftroom/contracts'
import { pluralize } from '../../lib/format.ts'
import {
  type BoardRole,
  type BoardStatus,
  can,
  canCreateInWorkspace,
  type WorkspaceRole,
} from '../../lib/permissions.ts'

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

/** A useful default checkpoint name, e.g. "Checkpoint Sep 27, 14:05". */
export function defaultCheckpointName(now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `Checkpoint ${MONTHS[now.getMonth()]} ${now.getDate()}, ${hh}:${mm}`
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
  /** Restore as new / duplicate (workspace members and above; guests cannot create boards). */
  canCreateBoards: boolean
  /** Duplicate with sharing settings (board owners). */
  canKeepSharing: boolean
}

export function historyPermissions(
  role: BoardRole,
  status: BoardStatus,
  workspaceRole: WorkspaceRole | null | undefined,
): HistoryPermissions {
  const canEdit = can(role, 'edit', status)
  return {
    canEdit,
    canSeeDeleted: canEdit,
    canCreateBoards: !!workspaceRole && canCreateInWorkspace(workspaceRole) && can(role, 'view', status),
    canKeepSharing: can(role, 'manage_access', status),
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
  return `${head}${files}`
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
