// Pure logic of the checkpoint list (docs/WAVE4-CONTRACTS.md checkpoints-2): manual and automatic
// checkpoints, their labels, who may preview or delete (UI hints only: the API enforces), and the
// sentence that explains what Lobby keeps.

import {
  type BoardCheckpoint,
  CHECKPOINT_RETENTION,
  type CheckpointContent,
  type CheckpointReason,
} from '@draftroom/contracts'
import { formatRelativeTime, pluralize } from '../../lib/format.ts'
import {
  type BoardRole,
  type BoardStatus,
  can,
  canCreateInWorkspace,
  type WorkspaceRole,
} from '../../lib/permissions.ts'

/** Manual checkpoints first in the panel; automatic ones (and legacy pre_restore) under their own disclosure. */
export function splitCheckpoints(list: readonly BoardCheckpoint[]) {
  const manual: BoardCheckpoint[] = []
  const automatic: BoardCheckpoint[] = []
  for (const c of list) (c.kind === 'manual' ? manual : automatic).push(c)
  return { manual, automatic }
}

const REASON_LABELS: Record<CheckpointReason, string> = {
  hourly: 'Hourly checkpoint',
  session_end: 'After an editing session',
  before_restore: 'Before a restore',
  import: 'As imported',
  before_reveal: 'Before revealing private notes',
  before_ai_themes: 'Before AI grouped notes into themes',
}

/** The row title: a manual checkpoint's own name; an automatic one's name says why it was made. */
export function checkpointTitle(c: Pick<BoardCheckpoint, 'kind' | 'name' | 'reason'>): string {
  if (c.kind === 'manual') return c.name
  // The server names before_restore ones after the checkpoint that was restored.
  if (c.reason === 'before_restore' && c.name.trim()) return c.name
  return c.reason ? REASON_LABELS[c.reason] : c.name || 'Automatic checkpoint'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14:05" today, "Sep 27, 14:05" this year, "Sep 27, 2025, 14:05" before (local time). */
export function checkpointTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `Today ${hm}`
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? `${md}, ${hm}` : `${md}, ${d.getFullYear()}, ${hm}`
}

/** The row's second line: who saved it (or that Lobby did) and when. */
export function checkpointMeta(
  c: Pick<BoardCheckpoint, 'kind' | 'createdBy' | 'createdAt'>,
  now: Date,
): string {
  const who =
    c.kind === 'manual' ? (c.createdBy?.name ? `saved by ${c.createdBy.name}` : null) : 'saved by Lobby'
  return [who, formatRelativeTime(c.createdAt, now), checkpointTime(c.createdAt, now)]
    .filter(Boolean)
    .join(' · ')
}

export interface CheckpointPermissions {
  /**
   * Preview a checkpoint: workspace members (not guests) who can view the board, the same people who
   * could restore it as a new board. Guests never see earlier content (API: 403).
   */
  canPreview: boolean
  /** Delete checkpoints (either kind): the board's owners, never a guest (API: manage_access). */
  canDelete: boolean
}

export function checkpointPermissions(
  role: BoardRole,
  status: BoardStatus,
  workspaceRole: WorkspaceRole | null | undefined,
): CheckpointPermissions {
  const member = !!workspaceRole && canCreateInWorkspace(workspaceRole)
  return {
    canPreview: member && can(role, 'view', status),
    canDelete: member && can(role, 'manage_access', status),
  }
}

/** A line for people who see the list but can neither open nor restore a checkpoint (guests). */
export function checkpointAccessHint(perms: CheckpointPermissions, canRestore: boolean): string | null {
  if (perms.canPreview || canRestore) return null
  return 'Only members of this workspace can open or restore earlier versions of this board.'
}

const weeksOrMonths = (days: number) => (days >= 180 ? `${Math.round(days / 30.5)} months` : `${days} days`)

/** What the automatic section explains (from CHECKPOINT_RETENTION, so the text follows the policy). */
export const AUTOMATIC_EXPLAINED =
  'Lobby saves the board by itself every hour while it changes, when the last editor leaves, before a ' +
  'checkpoint is restored, before private notes are revealed or AI groups notes into themes, and right ' +
  'after an import. It keeps one an hour for ' +
  `${CHECKPOINT_RETENTION.hourlyHours / 24} days, one a day for ${CHECKPOINT_RETENTION.dailyDays} days and one ` +
  `a week for ${weeksOrMonths(CHECKPOINT_RETENTION.weeklyDays)}. Named checkpoints stay until an owner deletes them.`

/** "Automatic (3)". */
export const automaticSummary = (n: number) => `Automatic (${n})`

/** The empty "Automatic" list: when the first one comes (R10). */
export const AUTOMATIC_NONE_YET =
  'None yet. Lobby saves one when everyone leaves, or after an hour of changes.'

/** One line after a delete. */
export function deletedCheckpointSummary(c: Pick<BoardCheckpoint, 'kind' | 'name' | 'reason'>): string {
  return `Deleted “${checkpointTitle(c)}”.`
}

/** "12 objects · 3 pages" for the preview's header (shapes and pages in the checkpoint). */
export function previewCounts(records: CheckpointContent['records']): {
  shapes: number
  pages: number
  text: string
} {
  let shapes = 0
  let pages = 0
  for (const r of records) {
    if (r.typeName === 'shape') shapes++
    else if (r.typeName === 'page') pages++
  }
  const parts = [pluralize(shapes, 'object')]
  if (pages > 1) parts.push(pluralize(pages, 'page'))
  return { shapes, pages, text: parts.join(' · ') }
}

/**
 * The checkpoint's records as a tldraw store snapshot (`{ store, schema }`), for a read-only preview
 * store that migrates them on load. Only document records: nothing session-scoped belongs in it.
 */
export function previewStoreSnapshot(content: Pick<CheckpointContent, 'records' | 'schema'>) {
  const store: Record<string, CheckpointContent['records'][number]> = {}
  for (const r of content.records) store[r.id] = r
  return { store, schema: content.schema }
}
