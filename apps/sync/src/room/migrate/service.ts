// The migration service of the Excalidraw engine's sync (docs/EXCALIDRAW-MIGRATION.md §5.3 "Two entry
// points", §5.9 step 3). O4. What the room (O1) and the router call:
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
//    tldraw board, one at a time, with the 256 MB cap. Progress at `GET /internal/migrate/status`.
//  - `routes()`: `POST /internal/migrate/convert-all` (202, runs in the background) and
//    `GET /internal/migrate/status`, mounted behind the internal secret like every internal route.
//
// No code here writes a board file: only the worker does, one job at a time.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { InternalRoute } from '../../engine-switch.ts'
import { sendJson } from '../../http/respond.ts'
import { BOARD_ID_RE, boardDbPath } from '../../rooms.ts'
import type { ConvertedFrom } from '../schema.ts'
import { type JobMode, type JobOutcome, MigrationQueue, type MigrationQueueOptions } from './queue.ts'

export type BoardFileState =
  | 'missing'
  /** tldraw tables, no lb_meta: needs the lazy conversion */
  | 'tldraw'
  /** converted and nothing changed on the tldraw side since */
  | 'converted'
  /** converted, and R0 wrote the tldraw side since (a rollback happened): needs the roll-forward */
  | 'rollforward-needed'
  /** lb_* only, no converted_from: made on the new canvas */
  | 'element'
  /** unreadable as a board */
  | 'unknown'

/** Classifies a board file with one read-only connection. Never writes. */
export function boardFileState(path: string): BoardFileState {
  if (!existsSync(path)) return 'missing'
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name),
    )
    const tldraw = tables.has('documents') && tables.has('metadata')
    if (!tables.has('lb_meta')) return tldraw ? 'tldraw' : tables.size === 0 ? 'missing' : 'unknown'
    const row = db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get() as
      | { value: string }
      | undefined
    if (!row) return 'element'
    if (!tldraw) return 'converted'
    const cf = JSON.parse(row.value) as ConvertedFrom
    const meta = db.prepare('SELECT documentClock FROM metadata LIMIT 1').get() as
      | { documentClock: number | bigint }
      | undefined
    if (Number(meta?.documentClock ?? 0) > cf.documentClock) return 'rollforward-needed'
    if (tables.has('dr_deleted_records')) {
      const r = db.prepare('SELECT max(seq) AS m FROM dr_deleted_records').get() as { m: number | null }
      if (Number(r.m ?? 0) > cf.deletedSeq) return 'rollforward-needed'
    }
    return 'converted'
  } finally {
    db.close()
  }
}

export type PrepareResult =
  | { readonly ready: true; readonly did: 'none' | 'converted' | 'rolled-forward' }
  | { readonly ready: false; readonly reason: string }

export interface MigrationServiceOptions extends MigrationQueueOptions {
  /** the rooms folder (board files are `boardDbPath(roomsDir, id)`) */
  readonly roomsDir: string
  /** where reports go; default `<data>/migration` (the rooms folder's sibling) */
  readonly reportDir?: string
  /** the final pre-cut-over backup object of a board and its recordsSha256 (§5.6), when known */
  readonly backupOf?: (boardId: string) => { key: string; recordsSha256: string } | null
  /** run the local-mode diff in every conversion (slower; B8 runs it) */
  readonly verifyLocalMode?: boolean
  /** a queue to share (default: a new one with these options) */
  readonly queue?: MigrationQueue
}

export class MigrationService {
  readonly queue: MigrationQueue
  private readonly opts: MigrationServiceOptions
  private readonly reportDir: string
  private allRun: Promise<unknown> | null = null
  constructor(opts: MigrationServiceOptions) {
    this.opts = opts
    this.queue = opts.queue ?? new MigrationQueue(opts)
    this.reportDir = opts.reportDir ?? join(dirname(opts.roomsDir), 'migration')
  }

  /** Whether a job for the board is queued or running (its joiners wait). */
  busy(boardId: string): boolean {
    return this.queue.busy(boardId)
  }

  private job(boardId: string, state: 'tldraw' | 'rollforward-needed') {
    const path = boardDbPath(this.opts.roomsDir, boardId)
    if (state === 'rollforward-needed')
      return { kind: 'rollforward' as const, boardId, path, reportDir: this.reportDir }
    const backup = this.opts.backupOf?.(boardId) ?? null
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
    const outcome: JobOutcome = await this.queue.enqueue(this.job(boardId, state), mode)
    if (!outcome.ok) return { ready: false, reason: outcome.reason }
    return { ready: true, did: state === 'tldraw' ? 'converted' : 'rolled-forward' }
  }

  /** On room open (runtime cap, RSS gate). */
  prepare(boardId: string): Promise<PrepareResult> {
    return this.run(boardId, 'runtime')
  }

  /** The maintenance window's conversion of every tldraw board (and roll-forwards), one at a time. */
  async convertAll(): Promise<Record<string, PrepareResult>> {
    const ids = readdirSync(this.opts.roomsDir)
      .map((f) => /^board-(.+)\.sqlite$/.exec(f)?.[1])
      .filter((id): id is string => !!id && BOARD_ID_RE.test(id))
      .sort()
    const out: Record<string, PrepareResult> = {}
    for (const id of ids) out[id] = await this.run(id, 'maintenance')
    return out
  }

  status() {
    return { ...this.queue.status(), convertAll: this.allRun ? 'running' : 'idle' }
  }

  routes(): InternalRoute[] {
    return [
      {
        method: 'POST',
        path: /^\/internal\/migrate\/convert-all$/,
        handle: (_req, res) => {
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
    ]
  }

  close(): Promise<void> {
    return this.queue.close()
  }
}
