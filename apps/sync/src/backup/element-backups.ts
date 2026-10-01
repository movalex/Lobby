// Local backups of the Excalidraw build's boards (2B; docs/EXCALIDRAW-MIGRATION.md §2.6, §5.6, the bridge
// release R0's contracts 3 and 4). The tldraw build's RoomRegistry backs up the boards ITS rooms have open;
// with DRAFTROOM_ENGINE=excalidraw that registry stays idle and the element rooms (room/**, the room
// owner's) keep no backup of their own. This pass gives the new build's boards the same local backups,
// from outside the room:
//
//  - every interval (the backup interval, 15 minutes), every board file in the rooms folder whose lb_*
//    state moved since its newest local backup (its `lb_meta.clock` differs from that entry's
//    documentClock, or the newest entry is not one of the lb formats) is backed up, one board at a time:
//    a board born on the new canvas as `lobby-elements`, a converted one as `lobby-elements-converted`
//    (backup.ts, backup/engine.ts). A board with tldraw tables only (not converted yet) is left to the
//    backups made before the cut-over: it has not changed since;
//  - each copy is made through a READ-ONLY connection in one step of node:sqlite's backup (one read
//    transaction, so the copy is one consistent state while the room writes; in WAL mode a reader never
//    blocks the writer). No room is opened and the board file is never written;
//  - the count-based retention keeps the newest `keep` (12) backups and, outside that count, every backup
//    still held (`holdUntil`: run-all's final set and every run-all backup, 90 days): backup.ts, the same
//    code as the tldraw build's. Each new backup is announced to the offsite copy (offsite.ts), which
//    signs its entry, format and holdUntil included, and keeps held entries outside its own retention;
//  - `backupFresh` is run-all's per-board backup on this build (app.ts passes this object as run-all's
//    registry), so POST /internal/backups/run-all writes its held set the same way.
//
// Logs carry board ids and counts only.

import { existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { LB_BACKUP_FORMAT, LB_CONVERTED_FORMAT } from '../r0/lb-files.ts'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'
import { BACKUP_DEFAULTS, type BackupEntry, backupBoard, readManifest } from './backup.ts'

const BOARD_FILE_RE = /^board-([a-z0-9][a-z0-9_-]{2,63})\.sqlite$/
/** The whole file in one backup step (int32 max): one read transaction, never restarted by a writer. */
const ONE_STEP = 2_147_483_647
const LB_FORMATS = new Set<string>([LB_BACKUP_FORMAT, LB_CONVERTED_FORMAT])

export interface ElementBackupsOptions {
  /** The rooms folder (board files are `board-<id>.sqlite` there). */
  roomsDir: string
  /** The local backups root (${DATA}/backups). */
  backupsDir: string
  intervalMs?: number
  keep?: number
  now?: () => Date
  log?: (...a: unknown[]) => void
}

export interface ElementPassResult {
  backedUp: string[]
  failed: string[]
}

/** `lb_meta.clock` of a board file with lb_* tables, read-only; null for a file without them. */
function lbClockOf(path: string): number | null {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'lb_meta'").get()
    if (!has) return null
    const row = db.prepare("SELECT value FROM lb_meta WHERE key = 'clock'").get() as
      | { value: string }
      | undefined
    const n = Number(row?.value ?? 0)
    return Number.isSafeInteger(n) && n >= 0 ? n : 0
  } finally {
    db.close()
  }
}

export class ElementBackups {
  private readonly opts: ElementBackupsOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private pass: Promise<ElementPassResult> | null = null
  private stopped = false

  constructor(opts: ElementBackupsOptions) {
    this.opts = opts
  }

  private get keep(): number {
    return this.opts.keep ?? BACKUP_DEFAULTS.keep
  }

  /** Runs a pass every interval (the first one interval after start). */
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(
      () => void this.runPass().catch(() => {}),
      this.opts.intervalMs ?? BACKUP_DEFAULTS.intervalMs,
    )
    this.timer.unref?.()
  }

  /** No new pass; resolves once the one in progress (if any) is done. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.pass?.catch(() => {})
  }

  /** Ids of every board that has a database file in the rooms folder, sorted (run-all's list). */
  boardFileIds(): string[] {
    let names: string[]
    try {
      names = readdirSync(this.opts.roomsDir)
    } catch {
      return []
    }
    return names
      .map((n) => BOARD_FILE_RE.exec(n)?.[1])
      .filter((id): id is string => id !== undefined && BOARD_ID_RE.test(id))
      .sort()
  }

  /** Whether a board's lb_* state moved since its newest local backup (false for tldraw-only files). */
  due(boardId: string): boolean {
    const clock = lbClockOf(boardDbPath(this.opts.roomsDir, boardId))
    if (clock === null) return false
    let newest: BackupEntry | undefined
    try {
      newest = readManifest(this.opts.backupsDir, boardId)?.backups.at(-1)
    } catch {
      newest = undefined // an unreadable manifest: back up (backupBoard writes a fresh one)
    }
    return !newest || !LB_FORMATS.has(String(newest.format)) || newest.documentClock !== clock
  }

  /**
   * A fresh backup of one board whether or not it changed (run-all on this build), through a read-only
   * connection in one step; `holdUntil` keeps it outside the count until then. Throws when it fails.
   */
  async backupFresh(boardId: string, opts: { holdUntil?: Date } = {}): Promise<BackupEntry> {
    if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
    const path = boardDbPath(this.opts.roomsDir, boardId)
    if (!existsSync(path)) throw new Error('the board has no database file')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      return await backupBoard({
        db,
        boardId,
        root: this.opts.backupsDir,
        keep: this.keep,
        rate: ONE_STEP,
        ...(this.opts.now ? { now: this.opts.now } : {}),
        ...(opts.holdUntil ? { holdUntil: opts.holdUntil } : {}),
      })
    } finally {
      db.close()
    }
  }

  /** One pass: every board whose lb_* state moved, one at a time. Never throws for one board. */
  runPass(): Promise<ElementPassResult> {
    if (this.pass) return this.pass
    const pass = (async () => {
      const result: ElementPassResult = { backedUp: [], failed: [] }
      for (const boardId of this.boardFileIds()) {
        if (this.stopped) break
        try {
          if (!this.due(boardId)) continue
          await this.backupFresh(boardId)
          result.backedUp.push(boardId)
        } catch (e) {
          result.failed.push(boardId)
          this.opts.log?.('[backup] element board backup failed', boardId, (e as Error)?.name ?? 'Error')
        }
      }
      return result
    })().finally(() => {
      if (this.pass === pass) this.pass = null
    })
    this.pass = pass
    return pass
  }
}
