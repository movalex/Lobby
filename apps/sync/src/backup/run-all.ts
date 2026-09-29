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
// - `inMaintenance`: maintenance was on from the start of the run to its end (what §7.5 step 4 needs).
// - Every backup it writes is held for RUN_ALL_HOLD_DAYS (90) outside the count-based retention, locally
//   and offsite (backup.ts BackupEntry.holdUntil): the final set before a cut-over is kept 90 days
//   (§5.6, §7.5 step 4), however many backups the board gets after it.
// - Open boards are copied through their room's connection; the others through a read-only connection,
//   so no room is opened and no board file is written (RoomRegistry.backupFresh). A board born on the new
//   canvas is copied whole (backup.ts, format `lobby-elements`).
// - The offsite copy is awaited per board: `offsiteKey` is set only once the store holds the file.
//   `ok` is true when every board has a local backup and, unless offsite backups are off, an offsite one.
//
// Messages carry no credentials; they may name a board id and a file name.

import type { BackupFormat } from '../r0/lb-files.ts'
import type { RoomRegistry } from '../rooms.ts'
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

export interface RunAllDeps {
  registry: Pick<RoomRegistry, 'boardFileIds' | 'backupFresh'>
  backups: Pick<BackupService, 'copyOffsite' | 'status'>
  /** Whether maintenance mode is on (app.ts). Absent: never. */
  maintenance?: () => boolean
  now?: () => Date
  log?: (...a: unknown[]) => void
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
const why = (e: unknown) => clip(`${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`)

export function createRunAll(deps: RunAllDeps): { run(): Promise<RunAllReport>; running(): boolean } {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const maintenance = deps.maintenance ?? (() => false)
  let current: Promise<RunAllReport> | null = null
  /** The run that starts once `current` is done, shared by every call made while `current` runs. */
  let queued: Promise<RunAllReport> | null = null

  async function once(): Promise<RunAllReport> {
    const started = now()
    const startedAt = started.toISOString()
    const maintenanceAtStart = maintenance()
    const holdUntil = new Date(started.getTime() + RUN_ALL_HOLD_DAYS * 86_400_000)
    const offsite = deps.backups.status().store
    const boards: RunAllBoard[] = []
    for (const boardId of deps.registry.boardFileIds()) {
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
      boards.push(row)
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
        continue
      }
      if (offsite === 'off') {
        row.ok = true
        continue
      }
      try {
        row.offsiteKey = await deps.backups.copyOffsite(boardId, row.file as string)
      } catch (e) {
        row.error = `offsite copy failed (${why(e)})`
      }
      if (!row.offsiteKey) {
        row.error ??= 'offsite copy did not complete (see GET /internal/backups/status)'
        log(`[backup] run-all: board ${boardId}: ${row.error}`)
        continue
      }
      row.ok = true
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
      `[backup] run-all: ${boards.filter((b) => b.ok).length} of ${boards.length} boards backed up (offsite ${offsite})`,
    )
    return report
  }

  function start(): Promise<RunAllReport> {
    const run: Promise<RunAllReport> = once().finally(() => {
      if (current === run) current = null
    })
    current = run
    return run
  }

  return {
    run() {
      if (queued) return queued
      if (!current) return start()
      // A run in progress started before this call: its backups can predate the caller's last edits.
      const after = current.then(
        () => undefined,
        () => undefined,
      )
      const next: Promise<RunAllReport> = after.then(() => {
        queued = null
        return start()
      })
      queued = next
      return next
    },
    running: () => current !== null || queued !== null,
  }
}
