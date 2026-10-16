// Import jobs in Postgres (migration 0035_board_imports; @draftroom/contracts imports.ts). OWNER: the wave R foundation
// (the lead); WS1 and WS4 read it through the runner and do not edit it.
//
// One job (imp_…, `batch_id`) is one row per board (imb_…). Rows hold no secret: a source's token lives only in the
// runner's memory; `source_ref` is a Miro board id or a backup's sha256; `error_code` is an upper-case code (0035
// CHECKs it); progress and the report are the contract's shapes, written by the runner only. A row that is not done
// but has a report has its board seeded already (recordSeeded): a resume activates that board and seeds nothing.

import {
  EMPTY_IMPORT_PROGRESS,
  IMPORT_ERROR_CODE_PATTERN,
  IMPORT_FINISHED_STATUSES,
  IMPORT_REPORT_MAX_BYTES,
  IMPORT_RESUMABLE_STATUSES,
  IMPORT_TIMING,
  type ImportBoardReport,
  type ImportBoardView,
  type ImportJobView,
  type ImportProgress,
  ImportProgress as ImportProgressSchema,
  type ImportSource,
  type ImportStatus,
  importJobStatus,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'

export interface ImportRow {
  id: string
  batch_id: string
  workspace_id: string
  project_id: string | null
  created_by: string
  source: ImportSource
  source_ref: string | null
  title: string
  position: number
  board_id: string | null
  status: ImportStatus
  cancel_requested: boolean
  pause_requested: boolean
  progress: unknown
  report: ImportBoardReport | null
  error_code: string | null
  heartbeat_at: Date | null
  created_at: Date
  updated_at: Date
  finished_at: Date | null
}

const COLUMNS = `id, batch_id, workspace_id, project_id, created_by, source, source_ref, title, position, board_id,
  status, cancel_requested, pause_requested, progress, report, error_code, heartbeat_at, created_at, updated_at,
  finished_at`

export const newImportId = () => newId('imp')
export const newImportBoardId = () => newId('imb')

export interface NewImportBoard {
  sourceRef: string | null
  title: string
}

/** Inserts a job: one queued row per board, in order. Returns the job's id. */
export async function insertJob(
  q: Queryable,
  job: {
    workspaceId: string
    projectId: string | null
    createdBy: string
    source: ImportSource
    boards: readonly NewImportBoard[]
    at: Date
  },
): Promise<string> {
  const importId = newImportId()
  for (const [position, b] of job.boards.entries())
    await q.query(
      `INSERT INTO board_imports (id, batch_id, workspace_id, project_id, created_by, source, source_ref, title,
                                  position, status, progress, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10::jsonb, $11, $11)`,
      [
        newImportBoardId(),
        importId,
        job.workspaceId,
        job.projectId,
        job.createdBy,
        job.source,
        b.sourceRef,
        b.title,
        position,
        JSON.stringify(EMPTY_IMPORT_PROGRESS),
        job.at,
      ],
    )
  return importId
}

/** A job's rows in order (empty when there is no such job). */
export async function jobRows(
  q: Queryable,
  importId: string,
  opts: { lock?: boolean } = {},
): Promise<ImportRow[]> {
  return (
    await q.query<ImportRow>(
      `SELECT ${COLUMNS} FROM board_imports WHERE batch_id = $1 ORDER BY position${opts.lock ? ' FOR UPDATE' : ''}`,
      [importId],
    )
  ).rows
}

export async function rowById(q: Queryable, rowId: string): Promise<ImportRow | null> {
  return q.maybeOne<ImportRow>(`SELECT ${COLUMNS} FROM board_imports WHERE id = $1`, [rowId])
}

/** The progress written for a running row, and its heartbeat. */
export async function writeProgress(q: Queryable, rowId: string, progress: ImportProgress, at: Date) {
  await q.query(
    `UPDATE board_imports SET progress = $2::jsonb, heartbeat_at = $3, updated_at = $3
      WHERE id = $1 AND status = 'running'`,
    [rowId, JSON.stringify(progress), at],
  )
}

export async function setStatus(
  q: Queryable,
  rowId: string,
  status: ImportStatus,
  at: Date,
  extra: { errorCode?: string | null; report?: ImportBoardReport | null; boardId?: string | null } = {},
): Promise<void> {
  const finished = IMPORT_FINISHED_STATUSES.includes(status)
  const errorCode = extra.errorCode ?? null
  if (errorCode !== null && !IMPORT_ERROR_CODE_PATTERN.test(errorCode))
    throw new Error('not an import error code')
  const report = extra.report === undefined ? undefined : extra.report
  if (report && Buffer.byteLength(JSON.stringify(report)) > IMPORT_REPORT_MAX_BYTES)
    throw new Error('import report too large')
  await q.query(
    `UPDATE board_imports
        SET status = $2, updated_at = $3, finished_at = $4, error_code = $5,
            report = CASE WHEN $6::boolean THEN $7::jsonb ELSE report END,
            board_id = CASE WHEN $8::boolean THEN $9 ELSE board_id END,
            heartbeat_at = CASE WHEN $2 = 'running' THEN $3 ELSE heartbeat_at END,
            cancel_requested = CASE WHEN $2 IN ('running', 'queued') THEN cancel_requested ELSE false END,
            pause_requested = CASE WHEN $2 IN ('running', 'queued') THEN pause_requested ELSE false END
      WHERE id = $1`,
    [
      rowId,
      status,
      at,
      finished ? at : null,
      errorCode,
      report !== undefined,
      report == null ? null : JSON.stringify(report),
      extra.boardId !== undefined,
      extra.boardId ?? null,
    ],
  )
}

/** Asks a job's unfinished rows to stop at their next step (`cancel` wins over `pause`). Returns how many. */
export async function requestStop(q: Queryable, importId: string, kind: 'cancel' | 'pause', at: Date) {
  const column = kind === 'cancel' ? 'cancel_requested' : 'pause_requested'
  const r = await q.query(
    `UPDATE board_imports SET ${column} = true, updated_at = $2
      WHERE batch_id = $1 AND status IN ('queued', 'running', 'paused', 'interrupted')`,
    [importId, at],
  )
  return r.rowCount
}

/** What a stop request says for a row now (the runner asks between its steps). */
export async function stopRequested(q: Queryable, rowId: string): Promise<'cancel' | 'pause' | null> {
  const r = await q.maybeOne<{ cancel_requested: boolean; pause_requested: boolean }>(
    'SELECT cancel_requested, pause_requested FROM board_imports WHERE id = $1',
    [rowId],
  )
  if (!r || r.cancel_requested) return 'cancel'
  return r.pause_requested ? 'pause' : null
}

/**
 * The rows of a process that is gone become `interrupted` (their secrets were in its memory): `queued` and `running`
 * rows whose heartbeat (or, never run, last change) is older than `staleBefore`, except the jobs `mine` (this
 * process runs or queues them). A running row writes its heartbeat every IMPORT_PROGRESS_WRITE_MS, so only a dead
 * process's rows go stale; during a deploy's overlap the old instance's rows are left alone until then.
 */
export async function markInterrupted(
  q: Queryable,
  at: Date,
  staleBefore: Date,
  mine: readonly string[] = [],
): Promise<number> {
  const r = await q.query(
    `UPDATE board_imports SET status = 'interrupted', updated_at = $1
      WHERE status IN ('queued', 'running')
        AND COALESCE(heartbeat_at, updated_at) < $2
        AND batch_id <> ALL($3::text[])`,
    [at, staleBefore, [...mine]],
  )
  return r.rowCount
}

/** Who may see a job: the person who started it, and the workspace's owners and admins (now). */
export function maySeeJob(
  row: Pick<ImportRow, 'created_by'>,
  viewerId: string,
  viewerRole: WorkspaceRole | null,
): boolean {
  return row.created_by === viewerId || canManageWorkspace(viewerRole)
}

/** Who may pause, cancel or resume it: only the person who started it. */
export const mayControlJob = (row: Pick<ImportRow, 'created_by'>, viewerId: string) =>
  row.created_by === viewerId

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function boardView(r: ImportRow): ImportBoardView {
  const progress = ImportProgressSchema.safeParse(r.progress)
  const { rows: _rows, ...summary } = r.report ?? { rows: [] }
  return {
    id: r.id,
    sourceRef: r.source_ref,
    title: r.title,
    status: r.status,
    progress: progress.success ? progress.data : EMPTY_IMPORT_PROGRESS,
    // the board is shown only once it is active (an importing board's id is nobody's to know)
    boardId: r.status === 'done' ? r.board_id : null,
    errorCode: r.error_code,
    // a report on a row that is not done marks its seed (recordSeeded): no summary until the board is there
    summary: r.report && r.status === 'done' ? (summary as ImportBoardView['summary']) : null,
    finishedAt: iso(r.finished_at),
  }
}

/** The view of a job (its rows in order) for `viewerId`; `startedBy` is the starter's display name. */
export function jobView(
  rows: readonly ImportRow[],
  startedBy: { id: string; name: string },
  viewerId: string,
  resumeNeedsToken: boolean,
): ImportJobView {
  const first = rows[0]
  if (!first) throw new Error('a job has at least one board')
  const status = importJobStatus(rows.map((r) => r.status))
  const finished = rows.every((r) => IMPORT_FINISHED_STATUSES.includes(r.status))
  const lastFinish = Math.max(...rows.map((r) => r.finished_at?.getTime() ?? 0))
  return {
    importId: first.batch_id,
    workspaceId: first.workspace_id,
    projectId: first.project_id,
    source: first.source,
    status,
    startedBy,
    createdAt: first.created_at.toISOString(),
    updatedAt: new Date(Math.max(...rows.map((r) => r.updated_at.getTime()))).toISOString(),
    finishedAt: finished ? new Date(lastFinish).toISOString() : null,
    resumable: first.created_by === viewerId && IMPORT_RESUMABLE_STATUSES.includes(status),
    resumeNeedsToken,
    boards: rows.map(boardView),
  }
}

/** The jobs of a workspace (only the caller's with `mine`), newest first, within IMPORT_TIMING.listDays. */
export async function recentJobIds(
  q: Queryable,
  workspaceId: string,
  opts: { createdBy?: string; now: Date; limit?: number },
): Promise<string[]> {
  const since = new Date(opts.now.getTime() - IMPORT_TIMING.listDays * 86_400_000)
  const rows = await q.query<{ batch_id: string }>(
    `SELECT batch_id FROM board_imports
      WHERE workspace_id = $1 AND created_at >= $2 AND ($3::text IS NULL OR created_by = $3)
      GROUP BY batch_id ORDER BY max(created_at) DESC LIMIT $4`,
    [workspaceId, since, opts.createdBy ?? null, opts.limit ?? 50],
  )
  return rows.rows.map((r) => r.batch_id)
}

// ---- files (a resumed job uploads nothing twice) --------------------------------------------------------------------

export async function storedFile(q: Queryable, rowId: string, sourceKey: string): Promise<string | null> {
  const r = await q.maybeOne<{ version_id: string | null }>(
    `SELECT version_id FROM board_import_files WHERE import_id = $1 AND source_key = $2 AND status = 'stored'`,
    [rowId, sourceKey],
  )
  return r?.version_id ?? null
}

/**
 * The board of a running row is seeded (sync committed it): its report is kept with the row, so a pause or a restart
 * before the activation resumes into the activation instead of a second seed (sync refuses one: the board has its
 * file). Cleared again (setStatus `report: null`) when the row fails or is cancelled.
 */
export async function recordSeeded(q: Queryable, rowId: string, report: ImportBoardReport, at: Date) {
  if (Buffer.byteLength(JSON.stringify(report)) > IMPORT_REPORT_MAX_BYTES)
    throw new Error('import report too large')
  await q.query(
    `UPDATE board_imports SET report = $2::jsonb, heartbeat_at = $3, updated_at = $3 WHERE id = $1 AND status = 'running'`,
    [rowId, JSON.stringify(report), at],
  )
}

export async function recordFile(
  q: Queryable,
  rowId: string,
  sourceKey: string,
  outcome: { versionId: string } | { failed: string },
): Promise<void> {
  const stored = 'versionId' in outcome
  await q.query(
    `INSERT INTO board_import_files (import_id, source_key, version_id, status, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (import_id, source_key) DO UPDATE
       SET version_id = EXCLUDED.version_id, status = EXCLUDED.status, note = EXCLUDED.note`,
    [
      rowId,
      sourceKey,
      stored ? outcome.versionId : null,
      stored ? 'stored' : 'failed',
      stored ? null : outcome.failed,
    ],
  )
}
