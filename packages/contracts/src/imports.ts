// Import jobs (wave R, "Bring the team over"; docs/WAVE-R-CONTRACTS.md §2). One job a person starts in the dashboard
// ("Import from Miro", "Restore a Lobby backup") makes one or more NEW boards; the api runs it in-process
// (apps/api/src/features/imports: the runner, the importing board, activation, cleanup), and the web polls its view.
// OWNER: the wave R foundation (the job machinery is shared by WS1 Miro import and WS4 backup restore; neither edits
// it, a fix goes through the lead). Frozen by the foundation.
//
//   GET  /api/imports/:id                 → 200 ImportJobView           (its starter; workspace owners and admins)
//   GET  /api/workspaces/:wid/imports     → 200 ListImportJobsResponse  (?mine=1: the caller's; 30 days, newest first)
//   POST /api/imports/:id/cancel          → 202 ImportJobView           (its starter)
//   POST /api/imports/:id/pause           → 202 ImportJobView           (its starter; stops between two steps)
//   POST /api/imports/:id/resume          → 202 ImportJobView           (its starter, a creator; paused or interrupted;
//                                                                         a Miro job needs its token again: miro-import.ts)
//   GET  /api/imports/:id/report.csv      → 200 text/csv                (its starter, and the owners of the boards it made)
//
// Ids: a job (what the person started, `importId`) is `imp_…`; each board in it is one row `imb_…` (board_imports, one
// row per board; migration 0035_board_imports). Boards run one after another; each board is atomic: it is made as an
// `importing` board nobody can see (packages/permissions: `can()` refuses everything on it; every list skips it) and
// becomes `active` in one transaction at the end, or is removed with every file it uploaded. A board that failed does
// not stop the others; boards finished before a cancel stay.
//
// Lifecycle (per board row, and the job's own status derived from its rows, IMPORT_STATUSES):
//   queued → running → done | failed | cancelled, and
//   running → paused        (the starter paused it: the runner stops at its next step boundary; nothing is lost)
//   running → interrupted   (the api restarted mid-job; a Miro token lived only in memory, so it is gone)
//   paused | interrupted → running (resume: files already stored are not uploaded again, board_import_files)
// Progress is written at most every IMPORT_PROGRESS_WRITE_MS with a heartbeat; a `running` row whose heartbeat is older
// than IMPORT_STALE_HEARTBEAT_MS when the api starts becomes `interrupted`. The web polls every IMPORT_POLL_MS.
//
// Nothing secret is ever in a view, a row, a log or an error: no token, no signed URL, no file name of the source
// beyond the person's own board titles. Errors are codes (IMPORT_CODES and the source's own), never messages from
// another service.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

const BoardIdLike = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const UserIdLike = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)
const WorkspaceIdLike = z.string().regex(/^wsp_[0-9A-Za-z]{10,40}$/)
const ProjectIdLike = z.string().regex(/^prj_[0-9A-Za-z]{10,40}$/)

// ---- ids, sources, statuses --------------------------------------------------------------------------------------

export const IMPORT_JOB_ID_PATTERN = /^imp_[0-9A-Za-z]{10,40}$/
export const IMPORT_BOARD_ID_PATTERN = /^imb_[0-9A-Za-z]{10,40}$/
export const ImportJobId = z.string().regex(IMPORT_JOB_ID_PATTERN)
export const ImportBoardId = z.string().regex(IMPORT_BOARD_ID_PATTERN)

export const IMPORT_SOURCES = ['miro', 'lobby-backup'] as const
export const ImportSource = z.enum(IMPORT_SOURCES)
export type ImportSource = z.infer<typeof ImportSource>

export const IMPORT_STATUSES = [
  'queued',
  'running',
  'paused',
  'interrupted',
  'done',
  'failed',
  'cancelled',
] as const
export const ImportStatus = z.enum(IMPORT_STATUSES)
export type ImportStatus = z.infer<typeof ImportStatus>
/** No further change happens to a row in one of these. */
export const IMPORT_FINISHED_STATUSES: readonly ImportStatus[] = ['done', 'failed', 'cancelled']
/** Rows the runner holds (or will hold) a slot for. */
export const IMPORT_ACTIVE_STATUSES: readonly ImportStatus[] = ['queued', 'running']
/** Rows a resume picks up. */
export const IMPORT_RESUMABLE_STATUSES: readonly ImportStatus[] = ['paused', 'interrupted']

/** What the runner is doing for one board (the progress line: "Reading items 1,200/2,000", "Images 37/120"). */
export const IMPORT_PHASES = [
  'queued',
  /** the source is checked (a Miro token, a backup's manifest and central directory) */
  'validating',
  /** the source's content is read (Miro items, connectors, groups, tags; a backup's board.json) */
  'reading',
  /** files are streamed into new versions of the board */
  'files',
  /** sync converts and validates the content (the seed) */
  'converting',
  /** the board becomes visible (one transaction) */
  'activating',
  /** a failed or cancelled board is removed with its files */
  'cleaning',
  'finished',
] as const
export const ImportPhase = z.enum(IMPORT_PHASES)
export type ImportPhase = z.infer<typeof ImportPhase>

export const IMPORT_TIMING = {
  /** the web polls the job's view this often */
  pollMs: 1_500,
  /** the runner writes progress (and its heartbeat) at most this often */
  progressWriteMs: 2_000,
  /** a `running` row whose heartbeat is older than this when the api starts is `interrupted` */
  staleHeartbeatMs: 120_000,
  /** a job is listed this long after it finished */
  listDays: 30,
  /** an `importing` board whose job is not running and is older than this is swept with its files */
  sweepImportingAfterMs: 24 * 60 * 60_000,
} as const
export const IMPORT_POLL_MS = IMPORT_TIMING.pollMs
export const IMPORT_PROGRESS_WRITE_MS = IMPORT_TIMING.progressWriteMs
export const IMPORT_STALE_HEARTBEAT_MS = IMPORT_TIMING.staleHeartbeatMs

/** The runner's concurrency (per api process, per person, per workspace). */
export const IMPORT_CONCURRENCY = {
  /** running jobs per api process */
  perProcess: 2,
  /** concurrent file streams per job */
  fileStreamsPerJob: 2,
  /** running jobs per person */
  perPerson: 1,
  /** jobs a person may start per day */
  startsPerPersonPerDay: 10,
  /** running jobs per workspace */
  perWorkspace: 3,
} as const

/** The stored report of one board is capped (checked in code and by a CHECK in 0035). */
export const IMPORT_REPORT_MAX_BYTES = 262_144
/** Report rows (one per source item) kept for the CSV; beyond it the report says how many were left out. */
export const IMPORT_REPORT_MAX_ROWS = 10_000
export const IMPORT_TITLE_MAX = 120

/**
 * The job-level refusals and failures the web tells apart (a source adds its own: miro-import.ts MIRO_CODES,
 * board-backup.ts BACKUP_CODES). A stored `errorCode` is always one of the known codes (the 0035 CHECK keeps it an
 * upper-case word); anything unexpected is stored as INTERNAL and logged by code only.
 */
export const IMPORT_CODES = {
  /** 409: the person already runs a job, or the workspace runs its limit, or the api its limit */
  busy: 'IMPORT_BUSY',
  /** 429: the person started IMPORT_CONCURRENCY.startsPerPersonPerDay jobs today */
  dailyLimit: 'IMPORT_DAILY_LIMIT',
  /** 413: over a source's limits (items, connectors, files, bytes, boards in one job) */
  tooLarge: 'IMPORT_TOO_LARGE',
  /** 413: the workspace's storage quota was reached (checked before every file) */
  quota: 'QUOTA_EXCEEDED',
  /** 409: pause/resume/cancel on a job in a status that does not allow it */
  wrongState: 'IMPORT_WRONG_STATE',
  /** the caller stopped being a creator, or lost the project, before the board was activated */
  creatorRevoked: 'CREATOR_REQUIRED',
  /** sync refused the converted content, or was unreachable */
  seedFailed: 'IMPORT_SEED_FAILED',
  /** the api restarted while the board ran (resume to go on) */
  interrupted: 'IMPORT_INTERRUPTED',
  cancelled: 'IMPORT_CANCELLED',
  /** anything else (a bug): logged by code and board id only */
  internal: 'INTERNAL',
} as const
export const IMPORT_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/

// ---- progress and report ---------------------------------------------------------------------------------------

const Count = z.number().int().nonnegative()

/** board_imports.progress (jsonb): what the progress line shows. */
export const ImportProgress = z.object({
  phase: ImportPhase,
  items: z.object({ read: Count, total: Count.nullable() }),
  files: z.object({ done: Count, failed: Count, total: Count.nullable(), bytes: Count }),
})
export type ImportProgress = z.infer<typeof ImportProgress>
export const EMPTY_IMPORT_PROGRESS: ImportProgress = {
  phase: 'queued',
  items: { read: 0, total: null },
  files: { done: 0, failed: 0, total: null, bytes: 0 },
}

/** How one source item ended up (a report row's `result`). */
export const IMPORT_ITEM_RESULTS = ['native', 'approximate', 'placeholder', 'failed', 'skipped'] as const
export const ImportItemResult = z.enum(IMPORT_ITEM_RESULTS)
export type ImportItemResult = z.infer<typeof ImportItemResult>

/** A short machine note on a report row (never content): `curved-connector`, `file-host-refused`, … */
export const ImportNote = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/)
  .max(48)

/** One source item in the CSV: its id there, its type, what became of it, the element made for it. */
export const ImportReportRow = z.object({
  sourceId: z.string().max(80),
  type: z.string().max(48),
  result: ImportItemResult,
  elementId: z.string().max(64).nullable(),
  note: ImportNote.nullable(),
})
export type ImportReportRow = z.infer<typeof ImportReportRow>

/** board_imports.report (jsonb) of one finished board; the summary is what the dialog shows. */
export const ImportBoardReport = z.object({
  /** items the source returned */
  total: Count,
  counts: z.object({ native: Count, approximate: Count, placeholder: Count, failed: Count, skipped: Count }),
  /** per source type: how many of each result */
  byType: z.record(z.string().max(48), z.partialRecord(ImportItemResult, Count)),
  /** machine notes and how often each happened (`color-substituted`, `group-dropped`, …) */
  notes: z.record(ImportNote, Count),
  rows: z.array(ImportReportRow).max(IMPORT_REPORT_MAX_ROWS),
  /** rows left out past IMPORT_REPORT_MAX_ROWS */
  rowsOmitted: Count,
})
export type ImportBoardReport = z.infer<typeof ImportBoardReport>

// ---- views ---------------------------------------------------------------------------------------------------

/** One board of a job, as the dialog shows it. */
export const ImportBoardView = z.object({
  id: ImportBoardId,
  /** the source's own reference (a Miro board id, a backup's sha256): never a secret */
  sourceRef: z.string().max(128).nullable(),
  /** the title the new board gets (the source's, or the one the person typed) */
  title: z.string().max(IMPORT_TITLE_MAX),
  status: ImportStatus,
  progress: ImportProgress,
  /** the new board, once it is active (null before, and for a board that failed or was cancelled) */
  boardId: BoardIdLike.nullable(),
  errorCode: z.string().regex(IMPORT_ERROR_CODE_PATTERN).nullable(),
  /** the report's summary (no rows: the CSV has them), once the board is done */
  summary: ImportBoardReport.omit({ rows: true }).nullable(),
  finishedAt: z.string().nullable(),
})
export type ImportBoardView = z.infer<typeof ImportBoardView>

export const ImportJobView = z.object({
  importId: ImportJobId,
  workspaceId: WorkspaceIdLike,
  projectId: ProjectIdLike.nullable(),
  source: ImportSource,
  /** derived from its boards: running while any runs, paused/interrupted while any waits, else the worst ending */
  status: ImportStatus,
  startedBy: z.object({ id: UserIdLike, name: z.string() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** whether the caller may resume it now (its starter, a creator, the job paused or interrupted) */
  resumable: z.boolean(),
  /** a Miro job asks for the token again on resume (it was never stored) */
  resumeNeedsToken: z.boolean(),
  boards: z.array(ImportBoardView).min(1),
})
export type ImportJobView = z.infer<typeof ImportJobView>

export const ListImportJobsQuery = z.strictObject({ mine: z.enum(['1']).optional() })
export const ListImportJobsResponse = z.object({ imports: z.array(ImportJobView) })
export type ListImportJobsResponse = z.infer<typeof ListImportJobsResponse>

/** 202 of every start (a Miro import, a backup restore): poll `location` (= importJobPath(importId)). */
export const StartImportResponse = z.object({ importId: ImportJobId, location: z.string() })
export type StartImportResponse = z.infer<typeof StartImportResponse>

/** The job's own status from its boards' (the rule ImportJobView.status states). */
export function importJobStatus(boards: readonly ImportStatus[]): ImportStatus {
  const has = (s: ImportStatus) => boards.includes(s)
  if (has('running')) return 'running'
  if (has('queued')) return 'queued'
  if (has('interrupted')) return 'interrupted'
  if (has('paused')) return 'paused'
  if (has('failed')) return 'failed'
  if (has('cancelled')) return 'cancelled'
  return 'done'
}

// ---- routes ----------------------------------------------------------------------------------------------------

export const IMPORT_ROUTES = {
  job: '/api/imports/:id',
  list: '/api/workspaces/:wid/imports',
  cancel: '/api/imports/:id/cancel',
  pause: '/api/imports/:id/pause',
  resume: '/api/imports/:id/resume',
  report: '/api/imports/:id/report.csv',
} as const

const R = IMPORT_ROUTES
/** The job routes, as the api's guard lists key them (`METHOD pattern`). */
export const IMPORT_ROUTE_KEYS = [
  `GET ${R.job}`,
  `GET ${R.list}`,
  `POST ${R.cancel}`,
  `POST ${R.pause}`,
  `POST ${R.resume}`,
  `GET ${R.report}`,
] as const
export type ImportRouteKey = (typeof IMPORT_ROUTE_KEYS)[number]
/** Resuming makes boards: a creator only (the guard, 'always'; and again at activation). */
export const IMPORT_CREATOR_ROUTE_KEYS: readonly ImportRouteKey[] = [`POST ${R.resume}`]

export const IMPORT_GUESTS_MESSAGE =
  'Importing boards is for people with an account. Sign in with an account to import boards.'

const enc = encodeURIComponent
export const importJobPath = (id: string) => `/api/imports/${enc(id)}`
export const importListPath = (workspaceId: string, mine = false) =>
  `/api/workspaces/${enc(workspaceId)}/imports${mine ? '?mine=1' : ''}`
export const importCancelPath = (id: string) => `${importJobPath(id)}/cancel`
export const importPausePath = (id: string) => `${importJobPath(id)}/pause`
export const importResumePath = (id: string) => `${importJobPath(id)}/resume`
export const importReportPath = (id: string) => `${importJobPath(id)}/report.csv`
