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
// Wave M (M7-4, CAP-DISK): the disk can never fill from backups. Each board cost up to about 15 local copies (12
// kept plus run-all's 90-day held sets), nothing stopped backups before ENOSPC, and then commits failed.
//  - `keep` is DRAFTROOM_BACKUP_KEEP (12 by default, 4 in render.yaml); offsite keeps the history;
//  - every pass first drops the local file of each HELD copy the offsite store already holds (its entry moves to
//    the manifest's `offsiteOnly`, backup.ts): the hold is kept offsite, where the restore tools read it;
//  - the backup-pass guard: below DISK_LOW_RATIO (20 %) free, every board's local copies are pruned to the newest
//    one the offsite store holds (copies newer than it, still waiting to go up, stay; so does a held copy offsite
//    does not hold yet; with offsite off, the newest copy), no new local copy is made, and one `[disk] low` line
//    is logged (and one `[disk] ok` once it is back above). Below 10 % the rooms' DISK notice goes out as before
//    (element-room.ts; it was 5 %).
//
// Logs carry board ids and counts only.

import { existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DISK_LOW_RATIO, type DiskProbe, STATFS_PROBE } from '../disk.ts'
import { LB_BACKUP_FORMAT, LB_CONVERTED_FORMAT } from '../r0/lb-files.ts'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'
import {
  BACKUP_DEFAULTS,
  type BackupEntry,
  backedUpBoards,
  backupBoard,
  dropLocalBackups,
  isHeld,
  readManifest,
} from './backup.ts'

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
  /** DRAFTROOM_BACKUP_KEEP: local copies kept per board (default BACKUP_DEFAULTS.keep) */
  keep?: number
  now?: () => Date
  log?: (...a: unknown[]) => void
  /** M7-4: which local backups the offsite store holds (backup/service.ts); absent = offsite off */
  offsite?: { stored(boardId: string, file: string): boolean }
  /** M7-4: the disk's free share (disk.ts; tests pass a fake) */
  disk?: DiskProbe
}

export interface ElementPassResult {
  backedUp: string[]
  failed: string[]
  /** M7-4: local backup files removed by this pass (held copies offsite holds; the low-disk prune) */
  pruned: string[]
  /** M7-4: the disk was below DISK_LOW_RATIO: pruned, and no new local copy made */
  lowDisk: boolean
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
  /** the last pass found the disk low (one `[disk] low` line per episode) */
  private low = false

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

  /** The disk's free share as this pass reads it (null: unreadable, never a reason to act). */
  diskFree(): number | null {
    return (this.opts.disk ?? STATFS_PROBE).freeRatio(this.opts.backupsDir)
  }

  /**
   * M7-4: one board's local copies the pass removes. Always: a held copy the offsite store holds. Low disk: every
   * copy but the newest offsite one (the anchor; the newest copy when offsite holds none), except copies newer
   * than the anchor that offsite does not hold yet and held copies offsite does not hold.
   */
  private async pruneBoard(boardId: string, low: boolean): Promise<string[]> {
    const stored = (e: BackupEntry) => this.opts.offsite?.stored(boardId, e.file) ?? false
    let entries: BackupEntry[]
    try {
      entries = readManifest(this.opts.backupsDir, boardId)?.backups ?? []
    } catch {
      return [] // an unreadable manifest: the next backup writes a fresh one
    }
    if (!entries.length) return []
    const now = (this.opts.now ?? (() => new Date()))()
    const at = now.getTime()
    const newestStored = [...entries].reverse().find(stored)
    const anchor = newestStored ?? entries.at(-1)
    const anchorAt = anchor ? Date.parse(anchor.createdAt) : Number.POSITIVE_INFINITY
    const drop = (e: BackupEntry): boolean => {
      const isStored = stored(e)
      if (isHeld(e, at)) return isStored // the hold stays offsite; never the only copy of a hold
      if (!low || e.file === anchor?.file) return false
      // a copy newer than the anchor that is still waiting to go up stays (it is the newest state)
      if (!isStored && Date.parse(e.createdAt) > anchorAt) return false
      return true
    }
    if (!entries.some(drop)) return []
    return dropLocalBackups(this.opts.backupsDir, boardId, drop, () => now)
  }

  /** One pass: every board whose lb_* state moved, one at a time. Never throws for one board. */
  runPass(): Promise<ElementPassResult> {
    if (this.pass) return this.pass
    const pass = (async () => {
      const result: ElementPassResult = { backedUp: [], failed: [], pruned: [], lowDisk: false }
      const free = this.diskFree()
      const low = free !== null && free < DISK_LOW_RATIO
      result.lowDisk = low
      if (low !== this.low)
        this.opts.log?.(
          low
            ? `[disk] low: ${Math.round((free ?? 0) * 100)}% free (under ${DISK_LOW_RATIO * 100}%): local backups pruned to the newest offsite copy per board, no new local copy until it is above again`
            : `[disk] ok: ${Math.round((free ?? 0) * 100)}% free; local backups resume`,
        )
      this.low = low
      let boards: string[] = []
      try {
        boards = backedUpBoards(this.opts.backupsDir)
      } catch {}
      for (const boardId of boards) {
        if (this.stopped) break
        try {
          result.pruned.push(...(await this.pruneBoard(boardId, low)))
        } catch (e) {
          this.opts.log?.('[backup] local prune failed', boardId, (e as Error)?.name ?? 'Error')
        }
      }
      if (low) return result // the guard: no new local copy while the disk is low
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
