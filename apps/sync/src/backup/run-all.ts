// POST /internal/backups/run-all (bridge release R0, docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 4):
// a fresh local and offsite backup of EVERY board file in the data dir, open or not, changed or not, and
// what the cut-over runbook stores for each: the backup's file, its offsite object key and its
// `recordsSha256` (the digest the new build's conversion checks `lb_source` against, §5.3).
//
// - Run after maintenance is on (every socket closed, none accepted), so no edit lands between this
//   backup and the conversion. It also works outside maintenance (then it is just a backup of everything).
// - One board at a time; one run at a time (a second call while one runs gets the same run's answer).
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
  error?: string
}

export interface RunAllReport {
  ok: boolean
  /** Where offsite copies go ('off': local backups only). */
  offsite: 'off' | 'fs' | 'r2'
  startedAt: string
  finishedAt: string
  boards: RunAllBoard[]
}

export interface RunAllDeps {
  registry: Pick<RoomRegistry, 'boardFileIds' | 'backupFresh'>
  backups: Pick<BackupService, 'copyOffsite' | 'status'>
  now?: () => Date
  log?: (...a: unknown[]) => void
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
const why = (e: unknown) => clip(`${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`)

export function createRunAll(deps: RunAllDeps): { run(): Promise<RunAllReport>; running(): boolean } {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  let current: Promise<RunAllReport> | null = null

  async function once(): Promise<RunAllReport> {
    const startedAt = now().toISOString()
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
      }
      boards.push(row)
      try {
        const made = await deps.registry.backupFresh(boardId)
        Object.assign(row, {
          file: made.file,
          ...(made.format ? { format: made.format } : {}),
          documentClock: made.documentClock,
          recordCount: made.recordCount,
          recordsSha256: made.recordsSha256,
          sha256: made.sha256,
          sizeBytes: made.sizeBytes,
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
      startedAt,
      finishedAt: now().toISOString(),
      boards,
    }
    log(
      `[backup] run-all: ${boards.filter((b) => b.ok).length} of ${boards.length} boards backed up (offsite ${offsite})`,
    )
    return report
  }

  return {
    run() {
      current ??= once().finally(() => {
        current = null
      })
      return current
    },
    running: () => current !== null,
  }
}
