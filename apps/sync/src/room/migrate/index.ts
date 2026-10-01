// The conversion and roll-forward of the Excalidraw engine's sync (docs/EXCALIDRAW-MIGRATION.md §5.3,
// §5.4, §5.9, §2.13). O4 owns apps/sync/src/room/migrate/**.
//
// For O1's room: create ONE `MigrationService` per sync process (`{ roomsDir: deps.dataDir, log,
// flushCaches }`), call `await service.prepare(boardId)` before a board's room opens its lb_* store (hold
// the board's joiners meanwhile; `busy(boardId)` says whether a job is queued or running), mount
// `service.routes()` with the room's internal routes, and `close()` it in `closeAll()`.

export {
  type ConvertJob,
  type ConvertReport,
  convertBoardFile,
  DISK_FACTOR,
  DISK_MARGIN_BYTES,
} from './convert-board.ts'
export { drDeletedDigests, lbDigests, recordsSha256, tableDigest, tableNames } from './digest.ts'
export {
  DROP_LEGACY_WINDOW_MS,
  type DropLegacyJob,
  type DropLegacyReason,
  type DropLegacyReport,
  dropLegacyBoardFile,
  LEGACY_DELETED_TABLES,
  LEGACY_TLDRAW_TABLES,
} from './drop-legacy.ts'
export { type FinalBackup, finalBackupOf } from './final-backup.ts'
export {
  type BoardStatus,
  DEFAULT_RUNTIME_CAP_MB,
  type JobMode,
  type JobOutcome,
  MAINTENANCE_CAP_MB,
  MigrationQueue,
  type MigrationQueueOptions,
  RUNTIME_RSS_LIMIT_MB,
  TIME_BUDGET_MS,
} from './queue.ts'
export {
  type Conflict,
  changedGroups,
  elementsDigest,
  type RollForwardJob,
  type RollForwardReport,
  rollForwardBoardFile,
} from './rollforward.ts'
export {
  type BoardFileState,
  boardFileState,
  type DropLegacyOptions,
  type DropLegacyOutcome,
  MigrationService,
  type MigrationServiceOptions,
  type PrepareResult,
} from './service.ts'
