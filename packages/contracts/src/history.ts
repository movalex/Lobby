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
 * Into an internal-only workspace or project (wave J), only confirmed creators' grants are copied and
 * the copy is private while its visibility would reach a member who is not inside; the 201 says so in
 * `warnings` and `outsideLeftOut`.
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
  /**
   * Duplicate with `keepSharing` into an internal-only workspace or project (wave J pre-deploy review,
   * IO-2a): the people whose grants were not copied because they are not confirmed creators (the
   * warnings say so in words). 0, or absent from an older api, otherwise.
   */
  outsideLeftOut: z.number().int().nonnegative().optional(),
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

// ---- selective restore (wave L, L7-2; owner W7) ------------------------------------------------------------
//
// POST /api/boards/:bid/snapshots/:sid/restore-elements  RestoreElementsInput -> RestoreElementsResult
// Edit on an active board, never a name-only guest (W5's refusals-matrix row; not a creator route). The api
// makes a 'before_restore' checkpoint first, reads the checkpoint's elements (a v1 body through the converter),
// closes the set over bound texts and containers, and asks the sync's internal route (sync-internal.ts
// restoreElementsInternalPath) to write them into the live board in one commit. A sync that does not serve the
// route (older than canvas-schema RESTORE_ELEMENTS_REV) answers 404, and the api 503 RESTORE_UNAVAILABLE; the
// web offers "Restore these" only in a room at that revision. Server write: not a Ctrl+Z step; "Undo restore"
// restores the same ids from `checkpointId` with `removeAbsent` (W7): an id that checkpoint does not hold came
// back with the restore, so it is removed again (with its label), instead of being skipped as MISSING.
// Workspace guests are refused like the preview (the checkpoint may hold what was removed before they joined).

/** Ids one restore may name (each brings back its bound text or container too). */
export const RESTORE_ELEMENTS_MAX_IDS = 200
/** An element id as the canvas stores it (canvas-schema limits.ts ELEMENT_ID_PATTERN; a test keeps them equal). */
export const RESTORE_ELEMENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
export const RestoreElementId = z.string().regex(RESTORE_ELEMENT_ID_PATTERN)
export const RESTORE_ELEMENTS_ROUTE = '/api/boards/:bid/snapshots/:sid/restore-elements'
export const restoreElementsPath = (boardId: string, snapshotId: string) =>
  `/api/boards/${encodeURIComponent(boardId)}/snapshots/${encodeURIComponent(snapshotId)}/restore-elements`

export const RestoreElementsInput = z.object({
  ids: z.array(RestoreElementId).min(1).max(RESTORE_ELEMENTS_MAX_IDS),
  /**
   * W7 ("Undo restore", additive): an id the checkpoint does not hold but the board does is removed (with its
   * label), and listed in `restored` (it is back as the checkpoint had it: not there). Absent: skipped MISSING.
   */
  removeAbsent: z.literal(true).optional(),
})
export type RestoreElementsInput = z.infer<typeof RestoreElementsInput>

/**
 * Why an id was not restored: LEASED (its text is under another session's lease), MISSING (not in the
 * checkpoint), INVALID (the checkpoint's copy fails today's element check).
 */
export const RESTORE_ELEMENTS_SKIP_CODES = ['LEASED', 'MISSING', 'INVALID'] as const
export const RestoreElementsSkipCode = z.enum(RESTORE_ELEMENTS_SKIP_CODES)
export type RestoreElementsSkipCode = z.infer<typeof RestoreElementsSkipCode>
export const RestoreElementsSkip = z.object({ id: z.string(), code: RestoreElementsSkipCode })

export const RestoreElementsResult = z.object({
  /**
   * element ids now as the checkpoint has them (the requested ones and the bound texts or containers that came
   * with them; with `removeAbsent`, the ids removed too)
   */
  restored: z.array(z.string()),
  skipped: z.array(RestoreElementsSkip),
  /** the board clock the write committed at (the web waits for it before it says "Restored") */
  clock: z.number().int().nonnegative(),
  /** the 'before_restore' checkpoint made first ("Undo restore" restores the same ids from it) */
  checkpointId: SnapshotId,
})
export type RestoreElementsResult = z.infer<typeof RestoreElementsResult>

export const RESTORE_ELEMENTS_ERROR_CODES = {
  /** 503: the sync does not serve the route (an older sync build) or is unreachable */
  unavailable: 'RESTORE_UNAVAILABLE',
  /** 409: the restore would take the board over its element cap */
  elementLimit: 'ELEMENT_LIMIT',
} as const

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

/**
 * Why an automatic checkpoint was made. Appended (history-polish, R10; migration 0017): right before a
 * private brainstorm's notes are put on the board (`before_reveal`), and before AI "Group into themes"
 * rearranges notes (`before_ai_themes`). Bridge release R0 (migration 0022, docs/EXCALIDRAW-MIGRATION.md
 * §5.5): `engine_migration`, the restore point the Excalidraw build saves right after converting a board.
 */
export const CHECKPOINT_REASONS = [
  'hourly',
  'session_end',
  'before_restore',
  'import',
  'before_reveal',
  'before_ai_themes',
  'engine_migration',
] as const
export const CheckpointReason = z.enum(CHECKPOINT_REASONS)
export type CheckpointReason = z.infer<typeof CheckpointReason>

/**
 * A checkpoint as the list shows it: `reason` is null for manual (and legacy pre_restore) ones.
 * `newCanvas` (bridge release R0): the checkpoint was made on the new canvas (Excalidraw; a v2 body).
 * This build lists it but can neither preview nor restore it (NEW_CANVAS_CHECKPOINT_MESSAGE). Absent on
 * every other checkpoint.
 */
export const BoardCheckpoint = BoardSnapshot.extend({
  reason: CheckpointReason.nullable(),
  newCanvas: z.literal(true).optional(),
})
export type BoardCheckpoint = z.infer<typeof BoardCheckpoint>

// ---- the new canvas (bridge release R0, docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10) --------------
//
// Lobby's canvas moves from tldraw to Excalidraw. R0 is the last tldraw build: it stays the rollback
// target, so it understands what the new canvas leaves behind and says so instead of failing. These
// words only ever reach people during such a rollback, when Lobby is back on its previous canvas for a
// while: so they say in plain words when the thing opens again (once Lobby is back on the new canvas),
// never "after the switch", which nobody on the page can decode.

/** Shown on a checkpoint made on the new canvas; the answer to previewing or restoring one (409 NEW_CANVAS). */
export const NEW_CANVAS_CHECKPOINT_MESSAGE =
  'Made on the new canvas. Preview and restore it when Lobby is back on the new canvas.'
/** Shown for a board made on the new canvas; the answer to opening, duplicating or exporting it (409 NEW_CANVAS). */
export const NEW_CANVAS_BOARD_MESSAGE =
  'This board was made on the new canvas. It opens again when Lobby is back on the new canvas.'
/** The dashboard card's line under the "New canvas" badge (on screen, not a tooltip). */
export const NEW_CANVAS_CARD_NOTE = 'Opens again when Lobby is back on the new canvas.'
/** The answer to importing a board archive exported from the new canvas (400 NEW_CANVAS_ARCHIVE). */
export const NEW_CANVAS_ARCHIVE_MESSAGE =
  'This file was exported from the new canvas. It can be imported when Lobby is back on the new canvas.'
/** The error code of those refusals. */
export const NEW_CANVAS_ERROR = 'NEW_CANVAS'

/**
 * K6-1 (wave K): 503 CANVAS_STARTING, with Retry-After. The api has not reached its board server since it
 * started (a deploy), so it does not know yet which canvas runs: a ticket for a board made on the new
 * canvas, a new board (its `new_canvas` mark) and the refusals that depend on it wait for that answer. Never
 * a NEW_CANVAS refusal. The web retries it quickly while it says "Connecting".
 */
export const CANVAS_STARTING_ERROR = 'CANVAS_STARTING'
export const CANVAS_STARTING_MESSAGE = 'Lobby is connecting to the board server. Try again in a moment.'
/** The Retry-After of that answer, in seconds. */
export const CANVAS_STARTING_RETRY_AFTER_S = 2

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
  /**
   * Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §3.7, §5.5; CR 2F-3): a v2 checkpoint's content is
   * elements, not records. Then `format` is `lobby-elements`, `records` is empty, `schema` is the element
   * schema version, and `elements` / `doc` hold the board. Absent for a v1 (tldraw) checkpoint.
   */
  format: z.literal('lobby-elements').optional(),
  elements: z.array(z.looseObject({ id: z.string(), type: z.string() })).optional(),
  doc: z.record(z.string(), z.unknown()).optional(),
  /**
   * PARITY-5.5 (§5.5 "v1 is converted on read"): true when `elements` / `doc` are a v1 (tldraw)
   * checkpoint converted for this answer, by the converter a restore as a new board uses. The stored body
   * stays v1. Absent for a v2 body and for v1 records (an api on the tldraw sync, or a body the converter
   * cannot read). Older clients ignore it and draw the elements like a v2 body's.
   */
  converted: z.literal(true).optional(),
})
export type CheckpointContent = z.infer<typeof CheckpointContent>

// DELETE /api/snapshots/:sid (board owners: manage_access, never a workspace guest) -> 204, audited as
// `board.checkpoint.delete`. Both kinds: an owner may need to purge content from automatic ones too.

/** Hints (ids only): clients refetch the list. `{ snapshotIds }` after checkpoints were deleted or pruned. */
export const CHECKPOINT_EVENTS = { removed: 'history.snapshot.removed' } as const
