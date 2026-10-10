// POST /internal/backups/run-all (bridge release R0, docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 4):
// a fresh local and offsite backup of EVERY board file in the data dir, open or not, changed or not, and
// what the cut-over runbook stores for each: the backup's file, its offsite object key and its
// `recordsSha256` (the digest the new build's conversion checks `lb_source` against, §5.3).
//
// - Run after maintenance is on (every socket closed, none accepted), so no edit lands between this
//   backup and the conversion. It also works outside maintenance (then it is just a backup of everything).
// - One board at a time; one run at a time. Every answer comes from a run that STARTED AFTER its call:
//   a call made while a run is in progress (an operator's earlier check, started before maintenance went
//   on) waits for it and gets the next run, which every caller that arrives meanwhile shares. So the
//   cut-over's call made after maintenance is on never gets backups taken before the last edits.
// - The HTTP route answers at once (202 with the run's id) and the run goes on in the server; the
//   report is fetched with GET /internal/backups/run-all/<runId> once the run is done (backup/
//   run-all-cli.ts polls it). A run takes as long as the boards take, and no client waits on one open
//   request for it: Node's fetch gives up on a request after 300 s without response headers, and a
//   report that only arrives at the end of a long request was lost with it. Finished runs stay
//   readable (the newest RUN_ALL_KEEP_RUNS) until the process ends: a restart forgets them, and also
//   turns maintenance off (a runtime switch), so a cut-over starts again from maintenance on.
// - `inMaintenance`: maintenance was on from the start of the run to its end (what §7.5 step 4 needs).
// - Every backup it writes is held for RUN_ALL_HOLD_DAYS (90) outside the count-based retention, locally
//   and offsite (backup.ts BackupEntry.holdUntil): the final set before a cut-over is kept 90 days
//   (§5.6, §7.5 step 4), however many backups the board gets after it.
// - So a run is refused (409 RECENT_HELD_SET) while a RECENT held set exists: every board file has a held
//   local entry made in the last RUN_ALL_RECENT_MS (30 min), read from the local manifests on disk, so a
//   restart forgets nothing. Each run adds one 90-day copy of every board to the rooms' own disk (1 GB on
//   Render), and repeated calls, by hand or from a script, would fill it and stall every SQLite write
//   (security audit L6). `{"force": true}` (the command's --force) runs anyway: after a sync restart in the
//   window, or when boards changed since. A call made while a run is in progress still joins the next run
//   (above): that set is not written yet.
// - Open boards are copied through their room's connection; the others through a read-only connection,
//   so no room is opened and no board file is written (RoomRegistry.backupFresh). A board born on the new
//   canvas is copied whole (backup.ts, format `lobby-elements`).
// - The offsite copy is awaited per board: `offsiteKey` is set only once the store holds the file.
//   `ok` is true when every board has a local backup and, unless offsite backups are off, an offsite one.
//
// The rollback's safety copy (plan §5.9 step 2 "every board's lb_* state is exported to R2", the runbook's
// B4 and gap G7) IS this run on the Excalidraw build, in maintenance, and not a separate
// `rollback-exports/<board>/<time>.json`. Why the held backup replaces the export:
// - it is the whole SQLite file: every lb_* table byte for byte (lb_elements, lb_doc, lb_meta, lb_deleted,
//   lb_source, every lb_prev_<cycle>_*), their indexes and AUTOINCREMENT counters, and the tldraw tables
//   R0 serves. An export would be a second format of the same rows with no reader: no reverse converter
//   is planned (§5.9 "If the rollback becomes permanent"), and a recovery from an export would open the
//   file anyway;
// - its manifest entry describes the lb_* state (`lobby-elements-converted` / `lobby-elements`:
//   `recordsSha256` is the lb_* digest, r0/lb-files.ts), is signed with the entry's format and
//   `holdUntil`, and is held 90 days outside every retention rule, locally and offsite;
// - the restore drill opens it through the element room's store and a staged restore puts it back
//   (backup/drill.ts, staged-restore.ts): it is checked and restorable, which an export would not be.
// The "export keys" the runbook records are the report's `offsiteKey`s. apps/sync/test/r0/
// rollback-safety-copy.test.ts holds the Excalidraw build to it: after Excalidraw-era edits and a
// roll-forward, every lb_* table of the copy has the live file's digest.
//
// Messages carry no credentials; they may name a board id and a file name.

import { randomBytes } from 'node:crypto'
import type { BackupFormat } from '../r0/lb-files.ts'
import { type BackupEntry, isHeld, readManifest } from './backup.ts'
import type { BackupService } from './service.ts'

export interface RunAllBoard {
  boardId: string
  ok: boolean
  /** The new local backup's file name (backups/<boardId>/<file>); null when it failed. */
  file: string | null
  /** `lobby-elements` for a board made on the new canvas (copied whole); absent for tldraw boards. */
  format?: BackupFormat
  documentClock: number | null
  recordCount: number | null
  /** The manifest entry's records digest (tldraw: backup.ts readBoardDb; lb_* only: r0/lb-files.ts). */
  recordsSha256: string | null
  /** sha256 of the backup file. */
  sha256: string | null
  sizeBytes: number | null
  /** The offsite object key once the store holds the file; null when offsite is off or the copy failed. */
  offsiteKey: string | null
  /** Kept outside retention until then (ISO, local and offsite); null when the local backup failed. */
  holdUntil: string | null
  error?: string
}

export interface RunAllReport {
  ok: boolean
  /** Where offsite copies go ('off': local backups only). */
  offsite: 'off' | 'fs' | 'r2'
  /** Maintenance was on when this run started and still on when it finished. */
  inMaintenance: boolean
  startedAt: string
  finishedAt: string
  boards: RunAllBoard[]
}

/** How long run-all's backups are kept outside retention (docs/EXCALIDRAW-MIGRATION.md §5.6: 90 days). */
export const RUN_ALL_HOLD_DAYS = 90
/** Finished runs kept readable by id (the newest ones; queued and running ones always are). */
export const RUN_ALL_KEEP_RUNS = 20
/** A run's id: `run_` and 16 hex digits. */
export const RUN_ALL_ID_RE = /^run_[0-9a-f]{16}$/
/** A held set made within this long before a call is "recent": the call is refused unless forced (audit L6). */
export const RUN_ALL_RECENT_MS = 30 * 60_000

/** A held backup of every board file, made recently (findRecentHeldSet). */
export interface RecentHeldSet {
  /** When the newest backup of the set was made (ISO). */
  at: string
  /** Board files it covers (every one there is). */
  boards: number
}

/** POST /internal/backups/run-all refused: a recent held set exists and the call did not say `force`. */
export class RecentHeldSetError extends Error {
  readonly set: RecentHeldSet
  constructor(set: RecentHeldSet) {
    super(
      `a held backup set of every board (${set.boards} boards) was made at ${set.at}, less than ${Math.round(RUN_ALL_RECENT_MS / 60_000)} minutes ago; each run-all adds one 90-day copy of every board to the sync disk. Pass {"force": true} (the command's --force) to write another set: after a sync restart in the window, or when boards changed since.`,
    )
    this.name = 'RecentHeldSetError'
    this.set = set
  }
}

/**
 * The recent held set, when every board file in `boardIds` has a held local manifest entry made within
 * `windowMs` before `now`; null when any board lacks one (a new board, a failed board: the set is not
 * complete, so a run is wanted) or there are no boards. Read-only; a manifest that cannot be read counts
 * as no entry.
 */
export function findRecentHeldSet(
  backupsDir: string,
  boardIds: readonly string[],
  now: Date,
  windowMs = RUN_ALL_RECENT_MS,
): RecentHeldSet | null {
  if (!boardIds.length) return null
  let newest = Number.NEGATIVE_INFINITY
  for (const boardId of boardIds) {
    let found = false
    try {
      const m = readManifest(backupsDir, boardId)
      // M7-4: a held copy whose local file went once offsite held it is still part of the set (offsiteOnly)
      for (const e of [...(m?.backups ?? []), ...(m?.offsiteOnly ?? [])]) {
        const made = Date.parse(e.createdAt)
        if (!isHeld(e, now.getTime()) || !Number.isFinite(made) || now.getTime() - made > windowMs) continue
        found = true
        if (made > newest) newest = made
      }
    } catch {
      return null
    }
    if (!found) return null
  }
  return { at: new Date(newest).toISOString(), boards: boardIds.length }
}

/** queued: waits for the run in progress (it answers a call made after that run started). */
export type RunAllStatus = 'queued' | 'running' | 'done' | 'failed'

/** A run as GET /internal/backups/run-all/<runId> answers it (POST and the list leave `report` out). */
export interface RunAllRunView {
  runId: string
  status: RunAllStatus
  /** When the first call this run answers was made. */
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Boards this run has finished (backed up or failed) so far, of `boardsTotal` (null until it starts). */
  boardsDone: number
  boardsTotal: number | null
  /** Once done: the report's `ok` and `inMaintenance`. */
  ok?: boolean
  inMaintenance?: boolean
  /** Once done (GET by id only): the whole report. */
  report?: RunAllReport
  /** status 'failed': why the run ended without a report. */
  error?: string
}

export interface RunAllDeps {
  /** The board files and a fresh backup of one (backup/element-backups.ts ElementBackups fits). */
  registry: {
    boardFileIds(): string[]
    backupFresh(boardId: string, opts?: { holdUntil?: Date }): Promise<BackupEntry>
  }
  backups: Pick<BackupService, 'copyOffsite' | 'status'>
  /** Whether maintenance mode is on (app.ts). Absent: never. */
  maintenance?: () => boolean
  /**
   * The local backups root (rooms.ts backupsDirFor), read for the recent held set (findRecentHeldSet).
   * Absent or null: no run is ever refused for one (tests with registry stand-ins; backups off).
   */
  backupsDir?: () => string | null
  /** The recent window (default RUN_ALL_RECENT_MS). */
  recentWindowMs?: number
  now?: () => Date
  log?: (...a: unknown[]) => void
  /** Run ids (tests); default `run_` + 16 random hex digits. */
  newRunId?: () => string
}

/** `force`: write a set although a recent held set exists (the header). */
export interface RunAllCall {
  force?: boolean
}

export interface RunAll {
  /**
   * Resolves with the report of a run that starts after this call (see the header). Throws
   * RecentHeldSetError (before any run) when a recent held set exists and `force` is not set.
   */
  run(opts?: RunAllCall): Promise<RunAllReport>
  /** The same run, for the HTTP route: answered at once, queued or running. Throws like run(). */
  request(opts?: RunAllCall): RunAllRunView
  /** A run by id, with its report once done; null when unknown (or no longer kept). */
  get(runId: string): RunAllRunView | null
  /** The runs this process knows, newest first, without reports. */
  list(): RunAllRunView[]
  /** A run is in progress or queued. */
  running(): boolean
  /**
   * The server is shutting down: a run in progress stops after the board it is on, a queued one never
   * starts (both end 'failed'), and no new one starts. Resolves once none is left.
   */
  stop(): Promise<void>
}

interface Run {
  id: string
  status: RunAllStatus
  requestedAt: Date
  startedAt: string | null
  finishedAt: string | null
  boardsDone: number
  boardsTotal: number | null
  report: RunAllReport | null
  error: string | null
  promise: Promise<RunAllReport>
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
const why = (e: unknown) => clip(`${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`)
const noop = () => undefined

export function createRunAll(deps: RunAllDeps): RunAll {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const maintenance = deps.maintenance ?? (() => false)
  const newRunId = deps.newRunId ?? (() => `run_${randomBytes(8).toString('hex')}`)
  /** Every run this process keeps, oldest first. */
  const runs = new Map<string, Run>()
  let current: Run | null = null
  /** The run that starts once `current` is done, shared by every call made while `current` runs. */
  let queued: Run | null = null
  /** stop() was called: the server is shutting down. */
  let stopping = false

  async function backupOne(boardId: string, holdUntil: Date, offsite: RunAllReport['offsite']) {
    const row: RunAllBoard = {
      boardId,
      ok: false,
      file: null,
      documentClock: null,
      recordCount: null,
      recordsSha256: null,
      sha256: null,
      sizeBytes: null,
      offsiteKey: null,
      holdUntil: null,
    }
    try {
      const made = await deps.registry.backupFresh(boardId, { holdUntil })
      Object.assign(row, {
        file: made.file,
        ...(made.format ? { format: made.format } : {}),
        documentClock: made.documentClock,
        recordCount: made.recordCount,
        recordsSha256: made.recordsSha256,
        sha256: made.sha256,
        sizeBytes: made.sizeBytes,
        holdUntil: made.holdUntil ?? null,
      })
    } catch (e) {
      row.error = `local backup failed (${why(e)})`
      log(`[backup] run-all: board ${boardId}: ${row.error}`)
      return row
    }
    if (offsite === 'off') {
      row.ok = true
      return row
    }
    try {
      row.offsiteKey = await deps.backups.copyOffsite(boardId, row.file as string)
    } catch (e) {
      row.error = `offsite copy failed (${why(e)})`
    }
    if (!row.offsiteKey) {
      row.error ??= 'offsite copy did not complete (see GET /internal/backups/status)'
      log(`[backup] run-all: board ${boardId}: ${row.error}`)
      return row
    }
    row.ok = true
    return row
  }

  async function once(run: Run): Promise<RunAllReport> {
    if (stopping) throw new Error('the sync server shut down before the run started')
    const started = now()
    const startedAt = started.toISOString()
    run.status = 'running'
    run.startedAt = startedAt
    const maintenanceAtStart = maintenance()
    const holdUntil = new Date(started.getTime() + RUN_ALL_HOLD_DAYS * 86_400_000)
    const offsite = deps.backups.status().store
    const ids = deps.registry.boardFileIds()
    run.boardsTotal = ids.length
    const boards: RunAllBoard[] = []
    for (const boardId of ids) {
      if (stopping) throw new Error(`the sync server shut down after ${run.boardsDone} boards`)
      boards.push(await backupOne(boardId, holdUntil, offsite))
      run.boardsDone++
    }
    const report: RunAllReport = {
      ok: boards.every((b) => b.ok),
      offsite,
      inMaintenance: maintenanceAtStart && maintenance(),
      startedAt,
      finishedAt: now().toISOString(),
      boards,
    }
    log(
      `[backup] run-all ${run.id}: ${boards.filter((b) => b.ok).length} of ${boards.length} boards backed up (offsite ${offsite})`,
    )
    return report
  }

  /** Forgets the oldest finished runs beyond RUN_ALL_KEEP_RUNS (never a queued or running one). */
  function trim() {
    let finished = [...runs.values()].filter((r) => r.status === 'done' || r.status === 'failed').length
    for (const [id, r] of runs) {
      if (finished <= RUN_ALL_KEEP_RUNS) break
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
      requestedAt: now(),
      startedAt: null,
      finishedAt: null,
      boardsDone: 0,
      boardsTotal: null,
      report: null,
      error: null,
      promise: Promise.resolve() as unknown as Promise<RunAllReport>,
    }
    runs.set(id, run)
    return run
  }

  function start(run: Run): Promise<RunAllReport> {
    current = run
    return once(run).then(
      (report) => {
        run.status = 'done'
        run.report = report
        run.finishedAt = report.finishedAt
        if (current === run) current = null
        trim()
        return report
      },
      (e: unknown) => {
        run.status = 'failed'
        run.error = `the run stopped (${why(e)})`
        run.finishedAt = now().toISOString()
        log(`[backup] run-all ${run.id}: ${run.error}`)
        if (current === run) current = null
        trim()
        throw e
      },
    )
  }

  /** The recent held set on disk (the header), or null; never consulted while a run is in progress. */
  function recentHeldSet(): RecentHeldSet | null {
    const dir = deps.backupsDir?.()
    if (!dir) return null
    return findRecentHeldSet(dir, deps.registry.boardFileIds(), now(), deps.recentWindowMs)
  }

  /** The run that answers a call made now (see the header). */
  function enqueue(opts?: RunAllCall): Run {
    if (queued) return queued
    if (!current && !opts?.force) {
      const set = recentHeldSet()
      if (set) throw new RecentHeldSetError(set)
    }
    let run: Run
    if (!current) {
      run = make()
      run.promise = start(run)
    } else {
      // A run in progress started before this call: its backups can predate the caller's last edits.
      run = make()
      queued = run
      const next = run
      run.promise = current.promise.then(noop, noop).then(() => {
        queued = null
        return start(next)
      })
    }
    // Callers of request() never await the promise: its failure is in the run's status.
    run.promise.catch(noop)
    return run
  }

  function view(run: Run, withReport: boolean): RunAllRunView {
    return {
      runId: run.id,
      status: run.status,
      requestedAt: run.requestedAt.toISOString(),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      boardsDone: run.boardsDone,
      boardsTotal: run.boardsTotal,
      ...(run.report ? { ok: run.report.ok, inMaintenance: run.report.inMaintenance } : {}),
      ...(withReport && run.report ? { report: run.report } : {}),
      ...(run.error ? { error: run.error } : {}),
    }
  }

  return {
    run: (opts) => {
      try {
        return enqueue(opts).promise
      } catch (e) {
        return Promise.reject(e)
      }
    },
    request: (opts) => view(enqueue(opts), false),
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
