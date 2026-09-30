// A manual checkpoint of every board, for the cut-over (bridge release R0, docs/EXCALIDRAW-MIGRATION.md
// §7.5 step 4: "Then take a manual checkpoint of every board"; runbook: docs/DEPLOY.md "R0 at the
// cut-over and in a rollback"). Behind the internal secret:
//
//   POST /internal/checkpoints/run-all          → 202 CheckpointAllRunView (started, or queued)
//   GET  /internal/checkpoints/run-all          → 200 { runs: CheckpointAllRunView[] } (newest first)
//   GET  /internal/checkpoints/run-all/:runId   → 200 CheckpointAllRunView, with `report` once done
//
// - Made after sync's maintenance is on and its final run-all backup (§7.5 steps 3 and 4): each board is
//   read from sync's snapshot route, which works in maintenance, so every checkpoint holds what the
//   final backup holds (the report's `documentClock` per board equals run-all's).
// - Each is a MANUAL checkpoint named CHECKPOINT_ALL_NAME with no author (the operator's, not a
//   person's): retention never removes it, and the History panel lists it with the board's own ones. It
//   is a tldraw (v1) checkpoint, which the new build previews and restores (§5.5).
// - A board whose newest tldraw checkpoint is already this one (same name, no author, same content and
//   document clock) is `unchanged`: repeating the step saves nothing twice. A board made on the new canvas (R0 cannot read
//   it) and a board deleted meanwhile are `skipped`. Every board of every workspace, any status (a board
//   in the trash can be restored after the switch).
// - One board at a time, one run at a time. Like sync's run-all, every answer comes from a run that
//   STARTED AFTER its call: a call made while a run goes on gets the next run, shared by every call made
//   meanwhile. The POST answers at once and the run goes on in the api (a run over many boards outlasts
//   any client's patience: Node's fetch gives up after 300 s without response headers);
//   checkpoint-all-cli.ts polls the run's GET. Finished runs stay readable (the newest
//   CHECKPOINT_ALL_KEEP_RUNS) until the api restarts; the checkpoints themselves are durable.
// - A POST, unlike the other internal routes of the api (GETs): the root CSRF hook exempts exactly this
//   route (app.ts). It carries no cookie authority: the internal secret is checked before anything else.

import { randomBytes } from 'node:crypto'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Params } from '../../context.ts'
import { ApiError } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import type { CheckpointService } from './checkpoints.ts'

export const CHECKPOINT_ALL_ROUTE = '/internal/checkpoints/run-all'
export const CHECKPOINT_ALL_RUN_ROUTE = '/internal/checkpoints/run-all/:runId'
/** The checkpoints' name (plain words: what the board looked like before it moved). */
export const CHECKPOINT_ALL_NAME = 'Before the move to the new canvas'
export const CHECKPOINT_ALL_KEEP_RUNS = 20
/** A run's id: `run_` and 16 hex digits. */
export const CHECKPOINT_ALL_ID_RE = /^run_[0-9a-f]{16}$/

export interface CheckpointAllBoard {
  boardId: string
  workspaceId: string
  ok: boolean
  /** saved now; unchanged: the same checkpoint from an earlier run; skipped; failed (see `error`). */
  outcome: 'saved' | 'unchanged' | 'skipped' | 'failed'
  /** The board's checkpoint (saved now, or the earlier one when unchanged); null otherwise. */
  snapshotId: string | null
  documentClock: number | null
  recordCount: number | null
  /** skipped: gone meanwhile, or made on the new canvas (this build cannot read it). */
  why?: 'missing' | 'new-canvas'
  error?: string
}

export interface CheckpointAllReport {
  /** No board failed. */
  ok: boolean
  name: string
  startedAt: string
  finishedAt: string
  saved: number
  unchanged: number
  skipped: number
  failed: number
  boards: CheckpointAllBoard[]
}

export type CheckpointAllStatus = 'queued' | 'running' | 'done' | 'failed'

export interface CheckpointAllRunView {
  runId: string
  status: CheckpointAllStatus
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
  boardsDone: number
  boardsTotal: number | null
  /** Once done: the report's `ok`. */
  ok?: boolean
  /** Once done (GET by id only). */
  report?: CheckpointAllReport
  /** status 'failed': why the run ended without a report. */
  error?: string
}

export interface CheckpointAllRuns {
  /** Resolves with the report of a run that starts after this call. */
  run(): Promise<CheckpointAllReport>
  /** The same run, answered at once (queued or running). */
  request(): CheckpointAllRunView
  get(runId: string): CheckpointAllRunView | null
  list(): CheckpointAllRunView[]
  running(): boolean
  /** The api is closing: the run stops after its current board, a queued one never starts. */
  stop(): Promise<void>
}

interface Run {
  id: string
  status: CheckpointAllStatus
  requestedAt: Date
  startedAt: string | null
  finishedAt: string | null
  boardsDone: number
  boardsTotal: number | null
  report: CheckpointAllReport | null
  error: string | null
  promise: Promise<CheckpointAllReport>
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
const why = (e: unknown) => clip(`${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`)
const noop = () => undefined

export function createCheckpointAllRuns(deps: {
  /** Every board id with its workspace, in a stable order. */
  boards(): Promise<Array<{ id: string; workspace_id: string }>>
  checkpoints: Pick<CheckpointService, 'captureNamed'>
  now: () => Date
  log?: (message: string) => void
  newRunId?: () => string
}): CheckpointAllRuns {
  const log = deps.log ?? (() => {})
  const newRunId = deps.newRunId ?? (() => `run_${randomBytes(8).toString('hex')}`)
  const runs = new Map<string, Run>()
  let current: Run | null = null
  let queued: Run | null = null
  let stopping = false

  async function one(board: { id: string; workspace_id: string }): Promise<CheckpointAllBoard> {
    const row: CheckpointAllBoard = {
      boardId: board.id,
      workspaceId: board.workspace_id,
      ok: false,
      outcome: 'failed',
      snapshotId: null,
      documentClock: null,
      recordCount: null,
    }
    try {
      const got = await deps.checkpoints.captureNamed(board.id, CHECKPOINT_ALL_NAME)
      if (got.status === 'skipped') return { ...row, ok: true, outcome: 'skipped', why: got.why }
      return {
        ...row,
        ok: true,
        outcome: got.status,
        snapshotId: got.checkpoint.id,
        documentClock: got.checkpoint.documentClock,
        recordCount: got.checkpoint.recordCount,
      }
    } catch (e) {
      row.error = why(e)
      log(`checkpoint run-all: board ${board.id}: ${row.error}`)
      return row
    }
  }

  async function once(run: Run): Promise<CheckpointAllReport> {
    if (stopping) throw new Error('the api shut down before the run started')
    const startedAt = deps.now().toISOString()
    run.status = 'running'
    run.startedAt = startedAt
    const list = await deps.boards()
    run.boardsTotal = list.length
    const boards: CheckpointAllBoard[] = []
    for (const b of list) {
      if (stopping) throw new Error(`the api shut down after ${run.boardsDone} boards`)
      boards.push(await one(b))
      run.boardsDone++
    }
    const count = (o: CheckpointAllBoard['outcome']) => boards.filter((b) => b.outcome === o).length
    const report: CheckpointAllReport = {
      ok: boards.every((b) => b.ok),
      name: CHECKPOINT_ALL_NAME,
      startedAt,
      finishedAt: deps.now().toISOString(),
      saved: count('saved'),
      unchanged: count('unchanged'),
      skipped: count('skipped'),
      failed: count('failed'),
      boards,
    }
    log(
      `checkpoint run-all ${run.id}: ${report.saved} saved, ${report.unchanged} unchanged, ${report.skipped} skipped, ${report.failed} failed`,
    )
    return report
  }

  function trim() {
    let finished = [...runs.values()].filter((r) => r.status === 'done' || r.status === 'failed').length
    for (const [id, r] of runs) {
      if (finished <= CHECKPOINT_ALL_KEEP_RUNS) break
      if (r.status !== 'done' && r.status !== 'failed') continue
      runs.delete(id)
      finished--
    }
  }

  function make(): Run {
    let id = newRunId()
    while (runs.has(id)) id = newRunId()
    const run: Run = {
      id,
      status: 'queued',
      requestedAt: deps.now(),
      startedAt: null,
      finishedAt: null,
      boardsDone: 0,
      boardsTotal: null,
      report: null,
      error: null,
      promise: Promise.resolve() as unknown as Promise<CheckpointAllReport>,
    }
    runs.set(id, run)
    return run
  }

  function start(run: Run): Promise<CheckpointAllReport> {
    current = run
    const settle = () => {
      if (current === run) current = null
      trim()
    }
    return once(run).then(
      (report) => {
        run.status = 'done'
        run.report = report
        run.finishedAt = report.finishedAt
        settle()
        return report
      },
      (e: unknown) => {
        run.status = 'failed'
        run.error = `the run stopped (${why(e)})`
        run.finishedAt = deps.now().toISOString()
        log(`checkpoint run-all ${run.id}: ${run.error}`)
        settle()
        throw e
      },
    )
  }

  function enqueue(): Run {
    if (queued) return queued
    const run = make()
    if (!current) run.promise = start(run)
    else {
      // A run in progress started before this call: its checkpoints can predate the caller's last edits.
      queued = run
      run.promise = current.promise.then(noop, noop).then(() => {
        queued = null
        return start(run)
      })
    }
    run.promise.catch(noop) // request() callers never await it: a failure is in the run's status
    return run
  }

  function view(run: Run, withReport: boolean): CheckpointAllRunView {
    return {
      runId: run.id,
      status: run.status,
      requestedAt: run.requestedAt.toISOString(),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      boardsDone: run.boardsDone,
      boardsTotal: run.boardsTotal,
      ...(run.report ? { ok: run.report.ok } : {}),
      ...(withReport && run.report ? { report: run.report } : {}),
      ...(run.error ? { error: run.error } : {}),
    }
  }

  return {
    run: () => enqueue().promise,
    request: () => view(enqueue(), false),
    get(runId) {
      const run = runs.get(runId)
      return run ? view(run, true) : null
    },
    list: () => [...runs.values()].reverse().map((r) => view(r, false)),
    running: () => current !== null || queued !== null,
    async stop() {
      stopping = true
      while (current || queued) await (queued ?? current)?.promise.catch(noop)
    },
  }
}

/** The runs of an app (tests). */
export const checkpointAllRuns = new WeakMap<FastifyInstance, CheckpointAllRuns>()

export function registerCheckpointAllRoutes(
  app: FastifyInstance,
  ctx: FeatureContext,
  checkpoints: CheckpointService,
): void {
  const runs = createCheckpointAllRuns({
    boards: async () =>
      (
        await ctx.db.query<{ id: string; workspace_id: string }>(
          'SELECT id, workspace_id FROM boards ORDER BY workspace_id, id',
        )
      ).rows,
    checkpoints,
    now: ctx.now,
    log: (message) => app.log.warn({ feature: 'history' }, message),
  })
  checkpointAllRuns.set(app, runs)
  // Before the database closes: a run in progress stops after its current board.
  app.addHook('onClose', () => runs.stop())

  const requireSecret = (req: FastifyRequest) => {
    if (!checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], ctx.config.internalSecret))
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'Internal credentials required.')
  }

  app.post(CHECKPOINT_ALL_ROUTE, async (req, reply: FastifyReply) => {
    requireSecret(req)
    const run = runs.request()
    return reply.code(202).header('location', `${CHECKPOINT_ALL_ROUTE}/${run.runId}`).send(run)
  })

  app.get(CHECKPOINT_ALL_ROUTE, async (req) => {
    requireSecret(req)
    return { runs: runs.list() }
  })

  app.get(CHECKPOINT_ALL_RUN_ROUTE, async (req) => {
    requireSecret(req)
    const { runId = '' } = req.params as Params
    const run = CHECKPOINT_ALL_ID_RE.test(runId) ? runs.get(runId) : null
    if (!run)
      throw new ApiError(
        404,
        'RUN_NOT_FOUND',
        'This api has no checkpoint run with that id. Runs are kept until the api restarts; the checkpoints they saved stay.',
      )
    return run
  })
}
