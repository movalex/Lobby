// API schemas for the history feature (docs/FEATURES-M2-CONTRACTS.md "history"): named checkpoints,
// restore-as-new / duplicate / import (new PRIVATE boards), board export, and "Recently deleted".
// Owned by the history engineer. Browser-safe.
//
// This file must not import './index.ts' (index re-exports it: the cycle would leave the imported
// schemas undefined while this module evaluates), so the few shared primitives are restated here.

import { BOARD_ROLES, BOARD_STATUSES, BOARD_VISIBILITIES } from '@draftroom/permissions'
import { z } from 'zod'

const HistoryBoardId = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const HistoryWorkspaceId = z.string().regex(/^wsp_[0-9A-Za-z]{10,40}$/)
const HistoryProjectId = z.string().regex(/^prj_[0-9A-Za-z]{10,40}$/)
const HistoryUserRef = z.object({ id: z.string(), name: z.string() })

// ---- checkpoints (board_snapshots) ------------------------------------------------------------------

export const SNAPSHOT_KINDS = ['manual', 'auto', 'pre_restore'] as const
export const SnapshotKind = z.enum(SNAPSHOT_KINDS)
export type SnapshotKind = z.infer<typeof SnapshotKind>

export const SNAPSHOT_ID_PATTERN = /^snp_[0-9A-Za-z]{10,40}$/
export const SnapshotId = z.string().regex(SNAPSHOT_ID_PATTERN)

export const SnapshotName = z.string().trim().min(1).max(120)

export const BoardSnapshot = z.object({
  id: SnapshotId,
  boardId: HistoryBoardId,
  name: z.string(),
  kind: SnapshotKind,
  /** null when the author's account is gone. */
  createdBy: HistoryUserRef.nullable(),
  createdAt: z.string(),
  documentClock: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshot>

/** GET /api/boards/:bid/snapshots (view): newest first. */
export const ListSnapshotsResponse = z.object({ snapshots: z.array(BoardSnapshot) })
export type ListSnapshotsResponse = z.infer<typeof ListSnapshotsResponse>

/** POST /api/boards/:bid/snapshots (edit) -> 201 BoardSnapshot. */
export const CreateSnapshotInput = z.object({ name: SnapshotName })
export type CreateSnapshotInput = z.infer<typeof CreateSnapshotInput>

// ---- new boards made from existing content --------------------------------------------------------

const NewBoardTitle = z.string().trim().min(1).max(120)

/** POST /api/snapshots/:sid/restore-as-new (view on the source board + workspace member). */
export const RestoreSnapshotInput = z.object({ title: NewBoardTitle.optional() })
export type RestoreSnapshotInput = z.infer<typeof RestoreSnapshotInput>

/**
 * POST /api/boards/:bid/duplicate (view + workspace member). The copy is private to the caller unless
 * `keepSharing` is set, which also needs manage_access on the source: it then copies the board's
 * workspace visibility and its people grants (never invitation/review links).
 */
export const DuplicateBoardInput = z.object({
  title: NewBoardTitle.optional(),
  keepSharing: z.boolean().optional(),
})
export type DuplicateBoardInput = z.infer<typeof DuplicateBoardInput>

/** POST /api/workspaces/:wid/boards/import?title=&projectId= (member). Body: a BoardArchiveV1 (JSON, <= 25 MB). */
export const ImportBoardQuery = z.object({
  title: NewBoardTitle.optional(),
  projectId: HistoryProjectId.optional(),
})
export const IMPORT_BODY_LIMIT_BYTES = 25 * 1024 * 1024

/** The board a history route created (the full BoardWithRole is sent; this is what clients rely on). */
export const HistoryNewBoard = z.object({
  id: HistoryBoardId,
  workspaceId: HistoryWorkspaceId,
  projectId: HistoryProjectId.nullable(),
  title: z.string(),
  visibility: z.enum(BOARD_VISIBILITIES),
  status: z.enum(BOARD_STATUSES),
  role: z.enum(BOARD_ROLES),
  createdAt: z.string(),
})
export type HistoryNewBoard = z.infer<typeof HistoryNewBoard>

/** 201 from restore-as-new, duplicate and import. */
export const HistoryBoardCreated = z.object({
  board: HistoryNewBoard,
  /** User-safe notes (e.g. files that could not be carried over). */
  warnings: z.array(z.string()),
  /** File versions the new board may show (carried over as links, see board_asset_links). */
  linkedFiles: z.number().int().nonnegative(),
  /** Referenced file versions that were NOT carried over (the caller could not view them). */
  droppedFiles: z.number().int().nonnegative(),
})
export type HistoryBoardCreated = z.infer<typeof HistoryBoardCreated>

// ---- recently deleted (captured by the sync server) --------------------------------------------------

/** tldraw shape record ids ("shape:" + printable ASCII). */
export const DeletedShapeId = z.string().regex(/^shape:[\x21-\x7e]{1,200}$/)

export const DeletedShapeEntry = z.object({
  shapeId: DeletedShapeId,
  /** tldraw shape type: note, geo, text, frame, arrow, image, dr-file-card, ... */
  type: z.string(),
  /** Short plain text (note/text/label, frame or file name); may be empty. */
  label: z.string(),
  deletedAt: z.string(),
  deletedBy: HistoryUserRef,
  /** Shapes deleted together with this one inside it (a frame's content); restored with it. */
  childCount: z.number().int().nonnegative(),
})
export type DeletedShapeEntry = z.infer<typeof DeletedShapeEntry>

/** GET /api/boards/:bid/deleted (view): newest first, shapes currently on the board left out. */
export const ListDeletedResponse = z.object({
  entries: z.array(DeletedShapeEntry),
  /** Restorable deletions kept for the board (entries is capped at `limit`). */
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
})
export type ListDeletedResponse = z.infer<typeof ListDeletedResponse>

export const RESTORE_DELETED_MAX_IDS = 500

/** POST /api/boards/:bid/deleted/restore (edit). Each id also brings back what was deleted inside it. */
export const RestoreDeletedInput = z.object({
  ids: z.array(DeletedShapeId).min(1).max(RESTORE_DELETED_MAX_IDS),
})
export type RestoreDeletedInput = z.infer<typeof RestoreDeletedInput>

export const RestoreDeletedSkipReason = z.enum(['not-found', 'exists', 'invalid'])

export const RestoreDeletedResponse = z.object({
  /** Shape ids put back on the board (requested ones and their captured content). */
  restored: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: RestoreDeletedSkipReason })),
  /** Connector bindings reattached (both ends exist again). */
  bindings: z.number().int().nonnegative(),
  /** Shapes whose parent was gone, placed on the page at their previous position. */
  reparented: z.number().int().nonnegative(),
})
export type RestoreDeletedResponse = z.infer<typeof RestoreDeletedResponse>

// ---- events (GET /api/boards/:bid/events) ------------------------------------------------------------

/** Hints only (payloads carry ids, never content): clients refetch the list they show. */
export const HISTORY_EVENTS = {
  /** `{ snapshotId }` after a checkpoint was saved. */
  snapshot: 'history.snapshot',
  /** `{ restored }` (a count) after shapes came back from Recently deleted. */
  deletedRestored: 'history.deleted',
} as const

// ---- automatic checkpoints and retention (wave 4, checkpoints-2; docs/WAVE4-CONTRACTS.md, REV-10) ----
//
// Lobby saves a board by itself (kind `auto`): at most once an hour while people edit it, when the last
// editor leaves after changes, before a checkpoint of it is restored as a new board, and right after an
// import. A checkpoint whose content equals the board's newest one is never saved again. Manual
// checkpoints are kept (up to MAX_MANUAL_CHECKPOINTS); automatic ones are thinned out over time
// (CHECKPOINT_RETENTION) and deleted together with their stored content.

/** Why an automatic checkpoint was made. */
export const CHECKPOINT_REASONS = ['hourly', 'session_end', 'before_restore', 'import'] as const
export const CheckpointReason = z.enum(CHECKPOINT_REASONS)
export type CheckpointReason = z.infer<typeof CheckpointReason>

/** A checkpoint as the list shows it: `reason` is null for manual (and legacy pre_restore) ones. */
export const BoardCheckpoint = BoardSnapshot.extend({ reason: CheckpointReason.nullable() })
export type BoardCheckpoint = z.infer<typeof BoardCheckpoint>

/** GET /api/boards/:bid/snapshots (view) as the checkpoints UI reads it: every kind, newest first. */
export const ListCheckpointsResponse = z.object({ snapshots: z.array(BoardCheckpoint) })
export type ListCheckpointsResponse = z.infer<typeof ListCheckpointsResponse>

/** Manual checkpoints kept per board (a save past it answers 409 SNAPSHOT_LIMIT). Automatic ones do not count. */
export const MAX_MANUAL_CHECKPOINTS = 500

/** At most one hourly checkpoint per this interval while a board keeps changing. */
export const AUTO_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000

/**
 * What happens to automatic checkpoints as they age (UTC calendar buckets; the newest checkpoint of a
 * bucket is the one kept): younger than `hourlyHours`, one per hour (those made before a restore and
 * right after an import are all kept); then one per day until `dailyDays`; then one per week until
 * `weeklyDays`; after that they are deleted. Manual checkpoints are never deleted by retention.
 */
export const CHECKPOINT_RETENTION = { hourlyHours: 48, dailyDays: 30, weeklyDays: 183 } as const

/**
 * GET /api/snapshots/:sid/content: the checkpoint's records, to preview it read-only. Needs view on the
 * board AND a workspace membership above guest (the people who could restore it as a new board anyway);
 * name-only guests and workspace guests get 403. 410 when its stored content is gone.
 */
export const CheckpointContent = z.object({
  snapshot: BoardCheckpoint,
  /** The serialized tldraw schema the records are in (the preview's store migrates them on load). */
  schema: z.unknown(),
  records: z.array(z.looseObject({ id: z.string(), typeName: z.string() })),
})
export type CheckpointContent = z.infer<typeof CheckpointContent>

// DELETE /api/snapshots/:sid (board owners: manage_access, never a workspace guest) -> 204, audited as
// `board.checkpoint.delete`. Both kinds: an owner may need to purge content from automatic ones too.

/** Hints (ids only): clients refetch the list. `{ snapshotIds }` after checkpoints were deleted or pruned. */
export const CHECKPOINT_EVENTS = { removed: 'history.snapshot.removed' } as const
