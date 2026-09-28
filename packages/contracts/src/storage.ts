// API schemas for workspace storage: what a workspace stores, and the report of the collector of
// uploaded files nothing references any more (UPL-1, SEAM-02, SEAM-11). Browser-safe.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// Routes (apps/api/src/files/storage-routes.ts):
//   GET  /api/workspaces/:wid/storage             owner, admin, member → WorkspaceStorage
//                                                  (`gc` only for owners and admins; guests 403)
//   GET  /api/workspaces/:wid/storage/gc-report   owner, admin → AssetGcReport
//   POST /api/workspaces/:wid/storage/scan        owner, admin → AssetGcReport (a report-only pass
//                                                  over this workspace now; it never deletes)

import { z } from 'zod'

/**
 * DRAFTROOM_ASSET_GC: `off` (no passes), `report` (default: mark and report, never delete), `delete`
 * (also delete versions unreferenced for ASSET_GC_GRACE_DAYS or more).
 */
export const ASSET_GC_MODES = ['off', 'report', 'delete'] as const
export const AssetGcMode = z.enum(ASSET_GC_MODES)
export type AssetGcMode = z.infer<typeof AssetGcMode>

/** A version must stay unreferenced this long before a delete-mode pass removes it. */
export const ASSET_GC_GRACE_DAYS = 30
/** An upload younger than this always counts as referenced (its shape may not be on a board yet). */
export const ASSET_GC_IN_FLIGHT_DAYS = 7

const Count = z.number().int().nonnegative()
const Bytes = z.number().nonnegative()
const IsoDate = z.string()

export const StorageAmount = z.object({ versions: Count, bytes: Bytes })
export type StorageAmount = z.infer<typeof StorageAmount>

/** The latest pass over one workspace. */
export const AssetGcRun = z.object({
  mode: z.enum(['report', 'delete']),
  startedAt: IsoDate,
  finishedAt: IsoDate,
  /** false: a board or checkpoint could not be read, so the pass marked and deleted nothing new. */
  complete: z.boolean(),
  boardsScanned: Count,
  boardsFailed: Count,
  checkpointsFailed: Count,
  /** Versions newly found unreferenced, and versions referenced again, by this pass. */
  marked: Count,
  cleared: Count,
  deleted: StorageAmount,
})
export type AssetGcRun = z.infer<typeof AssetGcRun>

export const AssetGcSummary = z.object({
  mode: AssetGcMode,
  graceDays: z.number().int().positive(),
  inFlightDays: z.number().int().positive(),
  lastRun: AssetGcRun.nullable(),
  /** Marked unreferenced now (original and preview bytes). */
  unreferenced: StorageAmount,
  /** Unreferenced for graceDays or more: what a delete-mode pass would remove next. */
  eligible: StorageAmount,
})
export type AssetGcSummary = z.infer<typeof AssetGcSummary>

export const WorkspaceStorage = z.object({
  workspaceId: z.string(),
  /** What counts toward the quota: originals, their previews and dashboard thumbnails (not checkpoints). */
  usedBytes: Bytes,
  quotaBytes: Bytes,
  /** Uploaded file versions, and the most the workspace may keep. */
  files: Count,
  maxFiles: Count,
  breakdown: z.object({ originals: Bytes, previews: Bytes, thumbnails: Bytes }),
  /** Every board of the workspace, archived and trashed ones included. */
  boards: z.object({ count: Count, max: Count }),
  /** Owners and admins only. */
  gc: AssetGcSummary.optional(),
})
export type WorkspaceStorage = z.infer<typeof WorkspaceStorage>

export const AssetGcReportEntry = z.object({
  assetId: z.string(),
  versionId: z.string(),
  name: z.string(),
  kind: z.enum(['image', 'pdf', 'video', 'other']),
  /** Original plus previews. */
  bytes: Bytes,
  boardId: z.string(),
  boardTitle: z.string(),
  uploadedAt: IsoDate,
  unreferencedSince: IsoDate,
  /** When a delete-mode pass may remove it (unreferencedSince + graceDays). */
  eligibleAt: IsoDate,
})
export type AssetGcReportEntry = z.infer<typeof AssetGcReportEntry>

/** Most entries one report lists (oldest mark first); `truncated` says there are more. */
export const ASSET_GC_REPORT_LIMIT = 200

export const AssetGcReport = z.object({
  workspaceId: z.string(),
  summary: AssetGcSummary,
  versions: z.array(AssetGcReportEntry),
  truncated: z.boolean(),
})
export type AssetGcReport = z.infer<typeof AssetGcReport>
