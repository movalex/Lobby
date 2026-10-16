// The import job runner (wave R; docs/WAVE-R-CONTRACTS.md §2): in-process, like history/checkpoint-all.ts. OWNER: the
// wave R foundation (the lead); WS1 (Miro) and WS4 (backup restore) each register one source with `useSource` and do
// not edit this file.
//
// A job's boards run one after another; each board is atomic:
//   1. the row becomes `running`; its invisible board is made (finalize.ts createImportingBoard), or kept from a
//      paused or interrupted run;
//   2. the source runs the board (`runBoard`: read, stream files into versions of that board, seed sync), reporting
//      progress (written with the heartbeat at most every IMPORT_PROGRESS_WRITE_MS) and calling `checkpoint()`
//      between its requests and files, which throws ImportStopped once the starter paused or cancelled;
//   3. the source's report is kept with the row as soon as it returns (jobs.ts recordSeeded: sync has the board's file
//      now), then the board is activated in one transaction (the guards again), and the row is `done` with its report.
//      A pause or a restart that lands between the seed and the activation resumes into the activation: a row whose
//      kept importing board has its seed recorded is not run by the source again (sync would refuse a second seed of
//      the board, IMPORT_SEED_FAILED); a row whose importing board is gone starts over with a new one.
// A board that fails is discarded with its files and the row is `failed` with a code; the next board still runs. A
// cancel discards the board in hand and cancels the boards not started (finished boards stay). A pause keeps the board
// in hand and its stored files (board_import_files) and pauses the rest; resume picks them up (a source that needs its
// secret again, Miro's token, gets it with the resume). The rows of a process that is gone (a restart; their secrets
// were in its memory only) become `interrupted` once their heartbeat is IMPORT_STALE_HEARTBEAT_MS old (`recover`, at
// start-up and then on that period); this process's own queued and running jobs are never touched.
//
// Secrets: `start` and `resume` take RedactedSecrets; they live in this runner's map for the job's run and are
// deleted when it ends, pauses or is cancelled. The source runs inside withSecrets (egress/index.ts), so whatever it
// throws leaves without them; rows, logs and views hold codes only (IMPORT_ERROR_CODE_PATTERN). Logs name rows by id.
//
// Limits (IMPORT_CONCURRENCY): this process runs at most `perProcess` jobs (the rest wait in order); a person has at
// most `perPerson` unfinished job and starts at most `startsPerPersonPerDay`; a workspace runs at most `perWorkspace`.

import {
  EMPTY_IMPORT_PROGRESS,
  IMPORT_CODES,
  IMPORT_CONCURRENCY,
  IMPORT_ERROR_CODE_PATTERN,
  IMPORT_PROGRESS_WRITE_MS,
  IMPORT_RESUMABLE_STATUSES,
  IMPORT_STALE_HEARTBEAT_MS,
  IMPORT_TIMING,
  ImportBoardReport,
  type ImportJobView,
  type ImportProgress,
  type ImportSource,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyBaseLogger } from 'fastify'
import { errorFacts, type RedactedSecret, SecretSafeError, withSecrets } from '../../egress/index.ts'
import { ApiError, notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { activateBoard, createImportingBoard, discardBoard } from './finalize.ts'
import {
  type ImportRow,
  insertJob,
  jobRows,
  jobView,
  markInterrupted,
  mayControlJob,
  maySeeJob,
  type NewImportBoard,
  recentJobIds,
  recordFile,
  recordSeeded,
  requestStop,
  rowById,
  setStatus,
  stopRequested,
  storedFile,
  writeProgress,
} from './jobs.ts'

/** Thrown by `checkpoint()` when the starter paused or cancelled the job. */
export class ImportStopped extends Error {
  readonly kind: 'cancel' | 'pause'
  constructor(kind: 'cancel' | 'pause') {
    super(`import ${kind}`)
    this.name = 'ImportStopped'
    this.kind = kind
  }
}

/** A source's own failure (MIRO_TOKEN_INVALID, BACKUP_INVALID, QUOTA_EXCEEDED, …): the row's error code. */
export class ImportFailure extends Error {
  readonly code: string
  constructor(code: string) {
    if (!IMPORT_ERROR_CODE_PATTERN.test(code)) throw new Error('not an import error code')
    super(`import failed: ${code}`)
    this.name = 'ImportFailure'
    this.code = code
  }
}

/** What a source gets to run one board. */
export interface ImportStep {
  readonly importId: string
  readonly rowId: string
  readonly workspaceId: string
  readonly projectId: string | null
  /** the person who started the job (authorship of everything it makes) */
  readonly userId: string
  readonly sourceRef: string | null
  readonly title: string
  /** the importing board this row builds (nobody can see it until activation) */
  readonly boardId: string
  /** the job's secrets (a Miro token): send them only through the egress module */
  readonly secrets: readonly RedactedSecret[]
  /** merges into the board's progress line (written with the heartbeat, at most every IMPORT_PROGRESS_WRITE_MS) */
  progress(p: Partial<ImportProgress>): void
  /** throws ImportStopped once the starter paused or cancelled: call it between requests and between files */
  checkpoint(): Promise<void>
  /** the version a source file already became in an earlier run of this row (a resume), or null */
  storedFile(sourceKey: string): Promise<string | null>
  recordFile(sourceKey: string, outcome: { versionId: string } | { failed: string }): Promise<void>
}

export interface ImportBoardResult {
  report: ImportBoardReport
  /** versions of other boards the new board shows (none for Miro and backups: their files are the board's own) */
  links?: readonly { assetId: string; versionId: string }[]
  /** counts for the activation's audit row */
  counts?: Readonly<Record<string, number>>
}

/** The code that runs one board of a source (WS1: 'miro', WS4: 'lobby-backup'). */
export interface ImportSourceRunner {
  readonly source: ImportSource
  /** whether a resume needs the secrets again (Miro: the token was never stored) */
  readonly resumeNeedsSecrets: boolean
  runBoard(step: ImportStep): Promise<ImportBoardResult>
}

export interface StartImport {
  workspaceId: string
  projectId: string | null
  userId: string
  source: ImportSource
  boards: readonly NewImportBoard[]
}

export interface ImportRunner {
  useSource(source: ImportSourceRunner): void
  /** inserts the job (queued) and runs it in the background; the caller did the route's permission checks */
  start(input: StartImport, secrets: readonly RedactedSecret[]): Promise<string>
  pause(importId: string, userId: string): Promise<void>
  cancel(importId: string, userId: string): Promise<void>
  resume(importId: string, userId: string, secrets: readonly RedactedSecret[]): Promise<void>
  /** the job as `viewerId` may see it (null: no such job, or not theirs to see) */
  view(importId: string, viewerId: string): Promise<ImportJobView | null>
  list(workspaceId: string, viewerId: string, opts?: { mine?: boolean }): Promise<ImportJobView[]>
  /** (at start-up, then every IMPORT_STALE_HEARTBEAT_MS) rows of a process that is gone become interrupted */
  recover(): Promise<number>
  /** removes importing boards nobody will finish (expired paused or interrupted rows, orphans) */
  sweep(): Promise<number>
  /** resolves when no job runs or waits (tests) */
  idle(): Promise<void>
  close(): Promise<void>
}

const busy = () =>
  new ApiError(409, IMPORT_CODES.busy, 'An import is already running. Wait for it to finish, then try again.')
const dailyLimit = () =>
  new ApiError(
    429,
    IMPORT_CODES.dailyLimit,
    'You started the most imports allowed for today. Try again tomorrow.',
  )
const wrongState = () => new ApiError(409, IMPORT_CODES.wrongState, 'This import cannot do that now.')
const secretRequired = () =>
  new ApiError(400, IMPORT_CODES.secretRequired, 'Paste the token again to go on with this import.')
const unavailable = () => new ApiError(404, 'NOT_FOUND', 'Not found.')

/** The row's code for an error a board ended with (never its message). */
export function failureCode(e: unknown): string {
  if (e instanceof ImportFailure) return e.code
  if (e instanceof ApiError && IMPORT_ERROR_CODE_PATTERN.test(e.code)) return e.code
  if (e instanceof SecretSafeError && IMPORT_ERROR_CODE_PATTERN.test(e.code)) return e.code
  return IMPORT_CODES.internal
}

async function roleIn(q: Queryable, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const r = await q.maybeOne<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  )
  return r?.role ?? null
}

export function createImportRunner(ctx: FeatureContext, log: FastifyBaseLogger): ImportRunner {
  const { db } = ctx
  const sources = new Map<ImportSource, ImportSourceRunner>()
  const secrets = new Map<string, readonly RedactedSecret[]>()
  const queue: string[] = []
  const running = new Map<string, Promise<void>>()
  let closed = false
  let waiters: (() => void)[] = []

  const settle = () => {
    if (running.size || queue.length) return
    const w = waiters
    waiters = []
    for (const resolve of w) resolve()
  }

  const pump = () => {
    while (!closed && running.size < IMPORT_CONCURRENCY.perProcess && queue.length) {
      const id = queue.shift() as string
      if (running.has(id)) continue
      const run = runJob(id)
        .catch((e) =>
          log.warn({ feature: 'imports', importId: id, err: errorFacts(e) }, 'import job stopped'),
        )
        .finally(() => {
          running.delete(id)
          secrets.delete(id)
          pump()
          settle()
        })
      running.set(id, run)
    }
    settle()
  }

  async function checkLimits(workspaceId: string, userId: string, starting: boolean) {
    const mine = await db.one<{ n: number }>(
      `SELECT count(DISTINCT batch_id)::int AS n FROM board_imports
        WHERE created_by = $1 AND status IN ('queued', 'running')`,
      [userId],
    )
    if (mine.n >= IMPORT_CONCURRENCY.perPerson) throw busy()
    const ws = await db.one<{ n: number }>(
      `SELECT count(DISTINCT batch_id)::int AS n FROM board_imports
        WHERE workspace_id = $1 AND status IN ('queued', 'running')`,
      [workspaceId],
    )
    if (ws.n >= IMPORT_CONCURRENCY.perWorkspace) throw busy()
    if (!starting) return
    const today = await db.one<{ n: number }>(
      `SELECT count(DISTINCT batch_id)::int AS n FROM board_imports WHERE created_by = $1 AND created_at >= $2`,
      [userId, new Date(ctx.now().getTime() - 86_400_000)],
    )
    if (today.n >= IMPORT_CONCURRENCY.startsPerPersonPerDay) throw dailyLimit()
  }

  async function runJob(importId: string) {
    const rows = await jobRows(db, importId)
    let stop: 'cancel' | 'pause' | null = null
    for (const row of rows) {
      if (row.status !== 'queued') continue
      if (closed) return
      if (stop) {
        await settleRow(row, stop)
        continue
      }
      stop = await runRow(importId, row)
    }
  }

  /** A row that never ran: paused with its job, or cancelled (its board, from an earlier run, discarded). */
  async function settleRow(row: ImportRow, kind: 'cancel' | 'pause') {
    if (kind === 'pause') return setStatus(db, row.id, 'paused', ctx.now())
    if (row.board_id) await discardBoard(ctx, row.board_id, { actorId: row.created_by, reason: 'cancelled' })
    await setStatus(db, row.id, 'cancelled', ctx.now(), { report: null })
  }

  /** Runs one board; returns how the job must go on ('cancel' and 'pause' stop the boards after it). */
  async function runRow(importId: string, row: ImportRow): Promise<'cancel' | 'pause' | null> {
    const source = sources.get(row.source)
    if (!source) {
      await setStatus(db, row.id, 'failed', ctx.now(), { errorCode: IMPORT_CODES.internal })
      return null
    }
    const requested = await stopRequested(db, row.id)
    if (requested) {
      await settleRow(row, requested)
      return requested
    }
    await setStatus(db, row.id, 'running', ctx.now())
    let progress: ImportProgress = { ...EMPTY_IMPORT_PROGRESS, phase: 'validating' }
    let dirty = true
    const flush = async () => {
      if (!dirty) return
      dirty = false
      await writeProgress(db, row.id, progress, ctx.now()).catch(() => {
        dirty = true
      })
    }
    const timer = setInterval(() => {
      dirty = true // the heartbeat goes with it
      void flush()
    }, IMPORT_PROGRESS_WRITE_MS)
    timer.unref()
    let boardId: string | null = null
    try {
      const kept = await keptBoard(row)
      boardId = kept ?? (await createBoardFor(row))
      // the source seeded this board in an earlier run (paused or restarted before its activation): activate it
      const seededReport = kept && row.report ? ImportBoardReport.safeParse(row.report) : null
      const step: ImportStep = {
        importId,
        rowId: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        userId: row.created_by,
        sourceRef: row.source_ref,
        title: row.title,
        boardId,
        secrets: secrets.get(importId) ?? [],
        progress: (p) => {
          progress = {
            phase: p.phase ?? progress.phase,
            items: { ...progress.items, ...p.items },
            files: { ...progress.files, ...p.files },
          }
          dirty = true
        },
        checkpoint: async () => {
          if (closed) throw new ImportStopped('pause')
          const kind = await stopRequested(db, row.id)
          if (kind) throw new ImportStopped(kind)
        },
        storedFile: (key) => storedFile(db, row.id, key),
        recordFile: (key, outcome) => recordFile(db, row.id, key, outcome),
      }
      // a stop and a source's own failure carry a kind or a code only: they pass as they are
      const ours = (err: unknown) => err instanceof ImportStopped || err instanceof ImportFailure
      let result: ImportBoardResult
      if (seededReport?.success) {
        result = { report: seededReport.data, counts: { items: seededReport.data.total } }
      } else {
        if (row.report) await recordSeededNot(row.id)
        result = await withSecrets(step.secrets, () => source.runBoard(step), ours)
        // links are not kept with the seed: a source that returns some runs again after a pause here (none does)
        if (!result.links?.length) await recordSeeded(db, row.id, result.report, ctx.now())
      }
      await step.checkpoint()
      progress = { ...progress, phase: 'activating' }
      dirty = true
      await flush()
      await activateBoard(ctx, {
        workspaceId: row.workspace_id,
        userId: row.created_by,
        boardId,
        source: row.source,
        links: result.links,
        counts: result.counts,
      })
      clearInterval(timer)
      progress = { ...progress, phase: 'finished' }
      dirty = true
      await flush()
      await setStatus(db, row.id, 'done', ctx.now(), { report: result.report })
      return null
    } catch (e) {
      clearInterval(timer)
      if (e instanceof ImportStopped && e.kind === 'pause') {
        await flush()
        // the api is shutting down: the job's secrets go with this process (interrupted, resumable)
        await setStatus(db, row.id, closed ? 'interrupted' : 'paused', ctx.now())
        return 'pause'
      }
      const cancelled = e instanceof ImportStopped
      progress = { ...progress, phase: 'cleaning' }
      dirty = true
      await flush()
      if (boardId)
        await discardBoard(ctx, boardId, {
          actorId: row.created_by,
          reason: cancelled ? 'cancelled' : 'failed',
        }).catch((err) =>
          log.warn(
            { feature: 'imports', importRowId: row.id, err: errorFacts(err) },
            'import cleanup failed',
          ),
        )
      if (cancelled) {
        await setStatus(db, row.id, 'cancelled', ctx.now(), { boardId: null, report: null })
        return 'cancel'
      }
      const code = failureCode(e)
      log.warn({ feature: 'imports', importRowId: row.id, code, err: errorFacts(e) }, 'import board failed')
      await setStatus(db, row.id, 'failed', ctx.now(), { errorCode: code, boardId: null, report: null })
      return null
    } finally {
      clearInterval(timer)
    }
  }

  /** The importing board an earlier run of this row made, if it is still there (a pause, a restart). */
  async function keptBoard(row: ImportRow): Promise<string | null> {
    if (!row.board_id) return null
    const kept = await db.maybeOne(`SELECT 1 AS ok FROM boards WHERE id = $1 AND status = 'importing'`, [
      row.board_id,
    ])
    return kept ? row.board_id : null
  }

  /** A row whose seeded board is gone starts over: its old seed's report is not this board's. */
  async function recordSeededNot(rowId: string) {
    await db.query(`UPDATE board_imports SET report = NULL WHERE id = $1 AND status = 'running'`, [rowId])
  }

  function createBoardFor(row: ImportRow): Promise<string> {
    return createImportingBoard(ctx, {
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      userId: row.created_by,
      title: row.title,
      source: row.source,
      importRowId: row.id,
    })
  }

  async function owned(importId: string, userId: string): Promise<ImportRow[]> {
    const rows = await jobRows(db, importId)
    const first = rows[0]
    if (!first || !mayControlJob(first, userId)) throw notFound()
    return rows
  }

  /** A job that is not running here: apply a stop to its rows directly. */
  async function stopIdle(importId: string, kind: 'cancel' | 'pause') {
    const at = queue.indexOf(importId)
    if (at >= 0) queue.splice(at, 1)
    secrets.delete(importId)
    for (const row of await jobRows(db, importId)) {
      const waiting = row.status === 'queued' || IMPORT_RESUMABLE_STATUSES.includes(row.status)
      if (!waiting) continue
      if (kind === 'pause' && row.status !== 'queued') continue
      await settleRow(row, kind)
    }
    settle()
  }

  const runner: ImportRunner = {
    useSource(source) {
      sources.set(source.source, source)
    },

    async start(input, given) {
      if (!sources.has(input.source)) throw unavailable()
      if (!input.boards.length) throw wrongState()
      await checkLimits(input.workspaceId, input.userId, true)
      const importId = await insertJob(db, { ...input, createdBy: input.userId, at: ctx.now() })
      secrets.set(importId, [...given])
      queue.push(importId)
      pump()
      return importId
    },

    async pause(importId, userId) {
      const rows = await owned(importId, userId)
      if (!rows.some((r) => r.status === 'queued' || r.status === 'running')) throw wrongState()
      await requestStop(db, importId, 'pause', ctx.now())
      if (!running.has(importId)) await stopIdle(importId, 'pause')
    },

    async cancel(importId, userId) {
      const rows = await owned(importId, userId)
      const open = (r: ImportRow) =>
        r.status === 'queued' || r.status === 'running' || IMPORT_RESUMABLE_STATUSES.includes(r.status)
      if (!rows.some(open)) throw wrongState()
      await requestStop(db, importId, 'cancel', ctx.now())
      if (!running.has(importId)) await stopIdle(importId, 'cancel')
    },

    async resume(importId, userId, given) {
      const rows = await owned(importId, userId)
      const first = rows[0] as ImportRow
      const source = sources.get(first.source)
      if (!source) throw unavailable()
      if (running.has(importId) || !rows.some((r) => IMPORT_RESUMABLE_STATUSES.includes(r.status)))
        throw wrongState()
      if (source.resumeNeedsSecrets && !given.length) throw secretRequired()
      await checkLimits(first.workspace_id, userId, false)
      await db.query(
        `UPDATE board_imports SET status = 'queued', cancel_requested = false, pause_requested = false, updated_at = $2
          WHERE batch_id = $1 AND status IN ('paused', 'interrupted')`,
        [importId, ctx.now()],
      )
      secrets.set(importId, [...given])
      queue.push(importId)
      pump()
    },

    async view(importId, viewerId) {
      const rows = await jobRows(db, importId)
      const first = rows[0]
      if (!first) return null
      if (!maySeeJob(first, viewerId, await roleIn(db, first.workspace_id, viewerId))) return null
      const user = await db.maybeOne<{ id: string; name: string }>(
        'SELECT id, name FROM users WHERE id = $1',
        [first.created_by],
      )
      const resumeNeedsToken = sources.get(first.source)?.resumeNeedsSecrets ?? first.source === 'miro'
      return jobView(rows, user ?? { id: first.created_by, name: '' }, viewerId, resumeNeedsToken)
    },

    async list(workspaceId, viewerId, opts = {}) {
      const role = await roleIn(db, workspaceId, viewerId)
      if (!role) return []
      const mine = opts.mine || !canManageWorkspace(role)
      const ids = await recentJobIds(db, workspaceId, {
        createdBy: mine ? viewerId : undefined,
        now: ctx.now(),
      })
      const out: ImportJobView[] = []
      for (const id of ids) {
        const v = await runner.view(id, viewerId)
        if (v) out.push(v)
      }
      return out
    },

    async recover() {
      const now = ctx.now()
      const stale = new Date(now.getTime() - IMPORT_STALE_HEARTBEAT_MS)
      return markInterrupted(db, now, stale, [...running.keys(), ...queue])
    },

    async sweep() {
      const cutoff = new Date(ctx.now().getTime() - IMPORT_TIMING.sweepImportingAfterMs)
      // importing boards no live run holds: their row waits (paused, interrupted) too long, or is gone or finished
      const stale = await db.query<{ id: string; row_id: string | null; created_by: string }>(
        `SELECT b.id, i.id AS row_id, b.created_by FROM boards b
           LEFT JOIN board_imports i ON i.board_id = b.id
          WHERE b.status = 'importing' AND b.created_at < $1
            AND (i.id IS NULL OR i.status NOT IN ('queued', 'running'))
            AND (i.id IS NULL OR i.updated_at < $1)
          ORDER BY b.created_at LIMIT 100`,
        [cutoff],
      )
      let removed = 0
      for (const s of stale.rows) {
        if (s.row_id && running.size) {
          const row = await rowById(db, s.row_id)
          if (row && running.has(row.batch_id)) continue
        }
        if (await discardBoard(ctx, s.id, { actorId: null, reason: 'expired' })) removed++
        if (s.row_id) {
          const row = await rowById(db, s.row_id)
          if (row && IMPORT_RESUMABLE_STATUSES.includes(row.status))
            await setStatus(db, row.id, 'failed', ctx.now(), {
              errorCode: IMPORT_CODES.expired,
              boardId: null,
              report: null,
            })
        }
      }
      return removed
    },

    idle() {
      if (!running.size && !queue.length) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    },

    async close() {
      closed = true
      queue.length = 0
      await Promise.allSettled([...running.values()])
      secrets.clear()
      settle()
    },
  }
  return runner
}
