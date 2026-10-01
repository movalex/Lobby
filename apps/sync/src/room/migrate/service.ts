// The migration service of the Excalidraw engine's sync (docs/EXCALIDRAW-MIGRATION.md §5.3 "Two entry
// points", §5.9 steps 3 and 5). O4, then 2B. What the room (O1) and the router call:
//
//  - `prepare(boardId)`: on room open. Reads the board file READ-ONLY and decides:
//      no file                                → ready (a new board: the room creates its lb_* tables);
//      tldraw tables and no lb_meta           → lazy conversion (runtime cap and RSS gate), then ready;
//      converted, and the tldraw side moved   → roll-forward (the tldraw documentClock is above
//        (documentClock or dr_deleted seq)      converted_from.documentClock, or dr_deleted has rows past
//                                               converted_from.deletedSeq), then ready;
//      converted, nothing moved; or born on the new canvas → ready.
//    Joiners wait on the promise (the join queue holds them while the job is queued or running). A job
//    that fails leaves the board closed on the new engine: `{ ready: false, reason }` (a maintenance run
//    converts it; the owner sees the report).
//  - `convertAll()`: the cut-over's maintenance window (sync refuses sockets; no room is open): every
//    tldraw board, one at a time, with the 256 MB cap. Each conversion is given the board's final backup
//    (final-backup.ts: the newest held, tldraw-described entry of the local manifest), whose digest the
//    converted records must equal (`backup-digest` otherwise, nothing written) and whose object key becomes
//    `converted_from.backupKey`. Lazy conversions get no backup (§5.3 "Lazy"). Progress at
//    `GET /internal/migrate/status`.
//  - `dropLegacyAll()`: day 7 after the cut-over (§5.9 step 5): removes the tldraw side of every converted
//    board file through the same queue (drop-legacy.ts has the guards: the 7-day window unless forced, never
//    an unconverted or a roll-forward-pending board). Each board's outcome is logged (ids and counts only).
//  - `routes()`: `POST /internal/migrate/convert-all` (202, runs in the background; 409 MAINTENANCE_REQUIRED
//    while maintenance is off unless the body says {"confirm": true}: it rewrites every tldraw board file,
//    and the runbook runs it inside the maintenance window, where no room is open and no lazy conversion
//    competes with it; security audit L6),
//    `POST /internal/migrate/drop-legacy` ({confirm: "drop-legacy", force?, dryRun?, boards?}; 202, in the
//    background; 409 while a convert-all or a drop-legacy runs) and `GET /internal/migrate/status`, mounted
//    behind the internal secret like every internal route.
//
// No code here writes a board file: only the worker does, one job at a time.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InternalRoute } from '../../engine-switch.ts'
import { readJson } from '../../http/body.ts'
import { HttpError, sendJson } from '../../http/respond.ts'
import { BOARD_ID_RE, boardDbPath } from '../../rooms.ts'
import { boardFileState } from './board-state.ts'
import type { DropLegacyJob, DropLegacyReport } from './drop-legacy.ts'
import { finalBackupOf } from './final-backup.ts'
import { maintenanceState } from './maintenance.ts'
import { type JobMode, type JobOutcome, MigrationQueue, type MigrationQueueOptions } from './queue.ts'

export { type BoardFileState, boardFileState } from './board-state.ts'

export type PrepareResult =
  | { readonly ready: true; readonly did: 'none' | 'converted' | 'rolled-forward' }
  | { readonly ready: false; readonly reason: string }

export interface MigrationServiceOptions extends MigrationQueueOptions {
  /** the rooms folder (board files are `boardDbPath(roomsDir, id)`) */
  readonly roomsDir: string
  /** where reports go; default `<data>/migration` (the rooms folder's sibling) */
  readonly reportDir?: string
  /** the local backups root the final backups are read from; default `<data>/backups` (the rooms folder's sibling) */
  readonly backupsDir?: string
  /**
   * The final pre-cut-over backup of a board and its recordsSha256 (§5.6), for maintenance-mode conversions;
   * default: final-backup.ts over `backupsDir`. Null = no final backup (no check, `backupKey` null).
   */
  readonly backupOf?: (boardId: string) => { key: string; recordsSha256: string } | null
  /** run the local-mode diff in every conversion (slower; B8 runs it) */
  readonly verifyLocalMode?: boolean
  /** a queue to share (default: a new one with these options) */
  readonly queue?: MigrationQueue
  /**
   * Whether maintenance mode is on (app.ts). Set: `POST /internal/migrate/convert-all` is refused while it
   * is off unless the body says {"confirm": true}. Absent (tests, the B8 scripts' direct calls): no check.
   */
  readonly maintenance?: () => boolean
}

export interface DropLegacyOptions {
  readonly force: boolean
  readonly dryRun: boolean
  /** only these boards (default: every board file) */
  readonly boards?: readonly string[]
}

export type DropLegacyOutcome =
  | { readonly ok: true; readonly report: DropLegacyReport }
  | { readonly ok: false; readonly reason: string; readonly report?: DropLegacyReport }

/** The POST body's limit (a list of board ids at most). */
const DROP_LEGACY_BODY_LIMIT = 1024 * 1024
const CONVERT_ALL_BODY_LIMIT = 1024

/**
 * Whether a request carries a body: the runbook's `int POST … convert-all` sends a JSON content-type with
 * an empty body, which is no body (queue.test.ts calls the handler with a bare object).
 */
const hasBody = (req: { headers?: Record<string, unknown> }) =>
  req.headers !== undefined &&
  (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined)
const DROP_LEGACY_MAX_BOARDS = 10_000

export class MigrationService {
  readonly queue: MigrationQueue
  private readonly opts: MigrationServiceOptions
  private readonly reportDir: string
  private readonly backupsDir: string
  private allRun: Promise<unknown> | null = null
  private dropRun: Promise<unknown> | null = null
  constructor(opts: MigrationServiceOptions) {
    this.opts = opts
    this.queue = opts.queue ?? new MigrationQueue(opts)
    this.reportDir = opts.reportDir ?? join(dirname(opts.roomsDir), 'migration')
    this.backupsDir = opts.backupsDir ?? join(dirname(opts.roomsDir), 'backups')
  }

  /** Whether a job for the board is queued or running (its joiners wait). */
  busy(boardId: string): boolean {
    return this.queue.busy(boardId)
  }

  /** The board's final backup for a maintenance-mode conversion (never for a lazy one), or null. */
  private finalBackup(boardId: string, mode: JobMode): { key: string; recordsSha256: string } | null {
    if (mode !== 'maintenance') return null
    if (this.opts.backupOf) return this.opts.backupOf(boardId)
    try {
      return finalBackupOf(this.backupsDir, boardId, (this.opts.now ?? Date.now)())
    } catch {
      this.opts.log?.(
        '[migrate] the local backup manifest is unreadable; converting without the final-backup check',
        boardId,
      )
      return null
    }
  }

  private job(boardId: string, state: 'tldraw' | 'rollforward-needed', mode: JobMode) {
    const path = boardDbPath(this.opts.roomsDir, boardId)
    if (state === 'rollforward-needed')
      return { kind: 'rollforward' as const, boardId, path, reportDir: this.reportDir }
    const backup = this.finalBackup(boardId, mode)
    return {
      kind: 'convert' as const,
      boardId,
      path,
      reportDir: this.reportDir,
      backupKey: backup?.key ?? null,
      expectedSourceSha256: backup?.recordsSha256 ?? null,
      verifyLocalMode: this.opts.verifyLocalMode === true,
    }
  }

  private async run(boardId: string, mode: JobMode): Promise<PrepareResult> {
    if (!BOARD_ID_RE.test(boardId)) return { ready: false, reason: 'bad-board-id' }
    const state = boardFileState(boardDbPath(this.opts.roomsDir, boardId))
    if (state === 'unknown') return { ready: false, reason: 'unreadable' }
    if (state !== 'tldraw' && state !== 'rollforward-needed') return { ready: true, did: 'none' }
    const outcome: JobOutcome = await this.queue.enqueue(this.job(boardId, state, mode), mode)
    if (!outcome.ok) return { ready: false, reason: outcome.reason }
    return { ready: true, did: state === 'tldraw' ? 'converted' : 'rolled-forward' }
  }

  /** On room open (runtime cap, RSS gate). */
  prepare(boardId: string): Promise<PrepareResult> {
    return this.run(boardId, 'runtime')
  }

  /** Ids of every board file in the rooms folder, sorted. */
  private boardIds(): string[] {
    return readdirSync(this.opts.roomsDir)
      .map((f) => /^board-(.+)\.sqlite$/.exec(f)?.[1])
      .filter((id): id is string => !!id && BOARD_ID_RE.test(id))
      .sort()
  }

  /** The maintenance window's conversion of every tldraw board (and roll-forwards), one at a time. */
  async convertAll(): Promise<Record<string, PrepareResult>> {
    const out: Record<string, PrepareResult> = {}
    for (const id of this.boardIds()) out[id] = await this.run(id, 'maintenance')
    return out
  }

  /** Day 7: the tldraw side of every converted board file removed, one at a time (drop-legacy.ts). */
  async dropLegacyAll(opts: DropLegacyOptions): Promise<Record<string, DropLegacyOutcome>> {
    const log = this.opts.log ?? (() => {})
    const ids = opts.boards ? [...opts.boards].filter((id) => BOARD_ID_RE.test(id)).sort() : this.boardIds()
    log(
      `[drop-legacy] start: ${ids.length} board(s)${opts.force ? ', force' : ''}${opts.dryRun ? ', dry run' : ''}`,
    )
    const out: Record<string, DropLegacyOutcome> = {}
    const tally = { dropped: 0, nothing: 0, refused: 0, failed: 0 }
    for (const boardId of ids) {
      const job: DropLegacyJob = {
        kind: 'drop-legacy',
        boardId,
        path: boardDbPath(this.opts.roomsDir, boardId),
        reportDir: this.reportDir,
        force: opts.force,
        dryRun: opts.dryRun,
      }
      const outcome = await this.queue.enqueue(job, 'maintenance')
      const report = outcome.report as DropLegacyReport | undefined
      if (outcome.ok && report?.kind === 'drop-legacy') {
        out[boardId] = { ok: true, report }
        if (report.reason === 'nothing-to-drop') {
          tally.nothing++
          log(`[drop-legacy] ${boardId}: nothing to drop`)
        } else {
          tally.dropped++
          log(
            `[drop-legacy] ${boardId}: ${opts.dryRun ? 'would drop' : 'dropped'} ${report.plan.length} table(s)` +
              `${report.forced ? ' (forced)' : ''}${opts.dryRun ? '' : `, ${report.bytesBefore} → ${report.bytesAfter} bytes`}`,
          )
        }
      } else {
        const reason = outcome.ok ? 'unexpected-report' : outcome.reason
        out[boardId] = { ok: false, reason, ...(report?.kind === 'drop-legacy' ? { report } : {}) }
        const refused = /^(not-converted|rollforward-pending|window|window-unknown)$/.test(reason)
        if (refused) tally.refused++
        else tally.failed++
        log(`[drop-legacy] ${boardId}: ${refused ? 'refused' : 'failed'} (${reason})`)
      }
    }
    log(
      `[drop-legacy] done: ${tally.dropped} ${opts.dryRun ? 'would be ' : ''}dropped, ${tally.nothing} nothing to drop, ${tally.refused} refused, ${tally.failed} failed`,
    )
    return out
  }

  status() {
    return {
      ...this.queue.status(),
      convertAll: this.allRun ? 'running' : 'idle',
      dropLegacy: this.dropRun ? 'running' : 'idle',
    }
  }

  routes(): InternalRoute[] {
    return [
      {
        method: 'POST',
        path: /^\/internal\/migrate\/convert-all$/,
        handle: async (req, res) => {
          let confirm = false
          if (hasBody(req)) {
            const body = (await readJson(req, CONVERT_ALL_BODY_LIMIT)) as Record<string, unknown> | null
            if (body !== null && (typeof body !== 'object' || Array.isArray(body)))
              throw new HttpError(400, 'BAD_REQUEST', 'The body must be {"confirm": true}, or empty.')
            for (const k of Object.keys(body ?? {}))
              if (k !== 'confirm')
                throw new HttpError(400, 'BAD_REQUEST', 'The body must be {"confirm": true}, or empty.')
            if (body?.confirm !== undefined && typeof body.confirm !== 'boolean')
              throw new HttpError(400, 'BAD_REQUEST', 'confirm must be a boolean.')
            confirm = body?.confirm === true
          }
          // synchronous from here: the checks and the start happen in one turn of the event loop
          const on = this.opts.maintenance ? this.opts.maintenance() : maintenanceState()
          if (on === false && !confirm)
            throw new HttpError(
              409,
              'MAINTENANCE_REQUIRED',
              'convert-all rewrites every tldraw board file. Turn maintenance on first (POST /internal/maintenance {"on": true}: the cut-over runs it inside the window), or send {"confirm": true} to run it while boards are open.',
            )
          if (this.dropRun) throw new HttpError(409, 'BUSY', 'A drop-legacy run is in progress.')
          if (!this.allRun)
            this.allRun = this.convertAll().finally(() => {
              this.allRun = null
            })
          sendJson(res, 202, { started: true })
        },
      },
      {
        method: 'GET',
        path: /^\/internal\/migrate\/status$/,
        handle: (_req, res) => sendJson(res, 200, this.status()),
      },
      // last: the room's test (queue.test.ts) reads the first two routes by position
      {
        method: 'POST',
        path: /^\/internal\/migrate\/drop-legacy$/,
        handle: async (req, res) => {
          const body = (await readJson(req, DROP_LEGACY_BODY_LIMIT)) as Record<string, unknown> | null
          if (body?.confirm !== 'drop-legacy')
            throw new HttpError(
              400,
              'CONFIRM_REQUIRED',
              'The body must carry {"confirm": "drop-legacy"}: this removes the tldraw side of every converted board, after which a rollback to R0 is no longer possible.',
            )
          for (const k of Object.keys(body))
            if (!['confirm', 'force', 'dryRun', 'boards'].includes(k))
              throw new HttpError(400, 'BAD_REQUEST', 'Unknown field in the body.')
          const force = body.force === undefined ? false : body.force
          const dryRun = body.dryRun === undefined ? false : body.dryRun
          if (typeof force !== 'boolean' || typeof dryRun !== 'boolean')
            throw new HttpError(400, 'BAD_REQUEST', 'force and dryRun must be booleans.')
          let boards: string[] | undefined
          if (body.boards !== undefined) {
            if (
              !Array.isArray(body.boards) ||
              body.boards.length === 0 ||
              body.boards.length > DROP_LEGACY_MAX_BOARDS ||
              body.boards.some((b) => typeof b !== 'string' || !BOARD_ID_RE.test(b))
            )
              throw new HttpError(400, 'BAD_REQUEST', 'boards must be a non-empty list of board ids.')
            boards = [...new Set(body.boards as string[])]
          }
          // synchronous from here: the check and the start happen in one turn of the event loop
          if (this.allRun) throw new HttpError(409, 'BUSY', 'A convert-all run is in progress.')
          if (this.dropRun) throw new HttpError(409, 'BUSY', 'A drop-legacy run is in progress.')
          const count = boards ? boards.length : this.boardIds().length
          this.dropRun = this.dropLegacyAll({ force, dryRun, ...(boards ? { boards } : {}) }).finally(() => {
            this.dropRun = null
          })
          this.dropRun.catch(() => {})
          sendJson(res, 202, { started: true, boards: count, force, dryRun })
        },
      },
    ]
  }

  close(): Promise<void> {
    return this.queue.close()
  }
}
