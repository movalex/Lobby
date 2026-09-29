import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, type RoomSnapshot, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'

import type { TLRecord, TLSchema } from '@tldraw/tlschema'
import { AttributionLedger, withNoteAttribution } from './attribution.ts'
import { BACKUP_DEFAULTS, type BackupEntry, backupBoard, readManifest } from './backup/backup.ts'
import { withDeleteCapture } from './deleted/capture.ts'
import { type RestoreSummary, restoreDeleted } from './deleted/restore.ts'
import { hookedSqlWrapper } from './deleted/sql.ts'
import { type DeletedEntry, type DeletedLimits, DeletedStore, ensureDeletedTables } from './deleted/store.ts'
import { createTextLease, type TextLease } from './lease.ts'
import type { BoardRole } from './permissions.ts'
import { runPreOpenChecks } from './r0/pre-open.ts'
import { authorizeUserRecord } from './user-records.ts'

/** Per-session data taken from the verified ticket (docs/M1-CONTRACTS.md §6). */
export interface SessionMeta {
  userId: string
  role: BoardRole
  /** The ticket's name: the only one the session's tldraw user record may carry (user-records.ts). */
  name: string
  /** The ticket's color as everyone is shown it (presenceIdentity: a plain hex color or the fallback). */
  color: string
}

export type Room = TLSocketRoom<TLRecord, SessionMeta>

interface RoomEntry {
  roomId: string
  room: Room
  db: DatabaseSync
  storage: SQLiteSyncStorage<TLRecord>
  lease: TextLease
  /** Note text and attribution pairs replaced by each user's own writes (attribution.ts, SEAM-01). */
  attribution: AttributionLedger
  /** "Recently deleted" side table of this board's database (REV-07). */
  deleted: DeletedStore
  evictTimer: ReturnType<typeof setTimeout> | null
  openedAt: number
  /** The backup in progress for this board, if any (one at a time). */
  backingUp: Promise<BackupEntry | null> | null
}

/**
 * Lowercase only: Windows (NTFS) and macOS (APFS default) are case-insensitive, so 'Board' and
 * 'board' would otherwise be two TLSocketRoom instances on ONE sqlite file (split room).
 */
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/

/** A board database file name in the data dir (boardDbPath); the capture is the board id. */
const BOARD_FILE_RE = /^board-([a-z0-9][a-z0-9_-]{2,63})\.sqlite$/

export function boardDbPath(dataDir: string, boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
  // 'board-' prefix: the file base name can never be a Windows device name (con, nul, com1, ...)
  return join(resolve(dataDir), `board-${boardId}.sqlite`)
}

export interface BackupOptions {
  /** Where backups go. Default: ${DATA}/backups when dataDir is the data layout's rooms/ folder. */
  dir?: string
  intervalMs?: number
  keep?: number
  evictBackupMinOpenMs?: number
}

export interface RegistryOpts {
  dataDir: string
  schema: TLSchema
  idleEvictMs?: number
  /** Text-edit lease duration (docs/M0-CONTRACTS.md §4). Default 5000. */
  textLeaseMs?: number
  synchronous?: 'FULL' | 'NORMAL'
  log?: (...a: unknown[]) => void
  /** After a session has left a room (any reason). */
  onSessionRemoved?: (boardId: string, sessionId: string, meta: SessionMeta) => void
  /**
   * After an accepted document write: a client push that committed a document change, or a restore
   * from "Recently deleted". Presence never counts. Must be cheap and must not throw (touch.ts).
   */
  onDocumentChange?: (boardId: string) => void
  /** Bounds of the "Recently deleted" capture (defaults: deleted/store.ts DELETED_LIMITS). */
  deleted?: Partial<DeletedLimits>
  /**
   * Periodic consistent backups (backup/backup.ts). On by default when dataDir is `<DATA>/rooms`
   * (the data layout the server uses), off otherwise; `false` turns them off.
   */
  backup?: BackupOptions | false
  now?: () => number
}

export interface LiveSession {
  sessionId: string
  meta: SessionMeta
}

interface ResolvedBackup {
  dir: string
  intervalMs: number
  keep: number
  evictBackupMinOpenMs: number
}

function resolveBackup(dataDir: string, opt: RegistryOpts['backup']): ResolvedBackup | null {
  if (opt === false) return null
  const rooms = resolve(dataDir)
  const dir = opt?.dir ?? (basename(rooms) === 'rooms' ? join(dirname(rooms), 'backups') : null)
  if (!dir) return null
  return {
    dir: resolve(dir),
    intervalMs: opt?.intervalMs ?? BACKUP_DEFAULTS.intervalMs,
    keep: opt?.keep ?? BACKUP_DEFAULTS.keep,
    evictBackupMinOpenMs: opt?.evictBackupMinOpenMs ?? BACKUP_DEFAULTS.evictBackupMinOpenMs,
  }
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomEntry>()
  private readonly opts: RegistryOpts // no TS parameter properties: Node type stripping rejects them
  private readonly backup: ResolvedBackup | null
  private readonly backupTimer: ReturnType<typeof setInterval> | null
  /** Document clock of each board's newest backup (undefined: not looked up yet; null: none). */
  private readonly lastBackupClock = new Map<string, number | null>()
  private backupPass: Promise<void> | null = null
  private readonly now: () => number
  constructor(opts: RegistryOpts) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    mkdirSync(opts.dataDir, { recursive: true })
    this.backup = resolveBackup(opts.dataDir, opts.backup)
    this.backupTimer = this.backup
      ? setInterval(() => void this.runBackupPass(), this.backup.intervalMs)
      : null
    this.backupTimer?.unref?.()
  }

  /**
   * The room a socket is about to join. Synchronous on purpose: no await between lookup and insert,
   * so creation is race-free. Cancels a pending idle eviction, so the caller must attach a session
   * right away (in the same tick).
   */
  getOrCreate(boardId: string): Room {
    const existing = this.live(boardId)
    if (existing) {
      if (existing.evictTimer) {
        clearTimeout(existing.evictTimer)
        existing.evictTimer = null
      }
      return existing.room
    }
    const opened = this.open(boardId)
    if (opened === 'exists') throw new Error('unreachable: open() without a seed never refuses')
    return opened.room
  }

  /**
   * Initializes a board that has never been opened from `snapshot` (already validated and migrated
   * by the caller). Refuses ('exists') when the room is open or the database is initialized:
   * SQLiteSyncStorage({ snapshot }) on an initialized database would WIPE it. The check and the
   * write are one synchronous step inside BEGIN IMMEDIATE, and every other opener of board
   * databases in this process goes through this registry, so a concurrent connect either
   * initialized the board first (-> 'exists') or opens the seeded room afterwards.
   */
  seed(boardId: string, snapshot: RoomSnapshot): 'created' | 'exists' {
    if (this.live(boardId)) return 'exists'
    return this.open(boardId, snapshot) === 'exists' ? 'exists' : 'created'
  }

  /**
   * The board's current stored snapshot, opening its room if the board has storage but is not open.
   * null when the board has no database yet (nothing is created just to answer a read).
   */
  snapshot(boardId: string): RoomSnapshot | null {
    return this.existing(boardId)?.storage.getSnapshot() ?? null
  }

  /**
   * "Recently deleted" of a board, newest first (shapes back on the board are left out). Opens the
   * room like snapshot(); a board without storage has none.
   */
  listDeleted(boardId: string, limit?: number): { entries: DeletedEntry[]; total: number } {
    const entry = this.existing(boardId)
    if (!entry) return { entries: [], total: 0 }
    // Ids only (no record parsing): what is on the board right now.
    const { result: onBoard } = entry.storage.transaction((txn) => new Set(txn.keys()))
    return entry.deleted.list((id) => onBoard.has(id), limit)
  }

  /**
   * The asset collector's reference scan (http/asset-refs.ts): calls `onRecord` with every record on
   * the board, then `onDeletedShape` with the stored JSON of every shape "Recently deleted" holds.
   * Read-only. Opens the room like snapshot(); false when the board has no storage.
   */
  scanRecords(
    boardId: string,
    onRecord: (record: TLRecord) => void,
    onDeletedShape: (state: string) => void,
  ): boolean {
    const entry = this.existing(boardId)
    if (!entry) return false
    entry.storage.transaction((txn) => {
      for (const record of txn.values()) onRecord(record)
    })
    for (const state of entry.deleted.shapeStates()) onDeletedShape(state)
    return true
  }

  /**
   * Whether the OPEN board's file also holds the new canvas's lb_* tables (a board converted at the
   * cut-over, served here from its tldraw tables during a rollback): what this build reads of such a
   * board is not all of it (http/asset-refs.ts). One read of the file's schema through the room's own
   * connection; no lb_* table is read. false when the board is not open.
   */
  hasNewCanvasTables(boardId: string): boolean {
    const entry = this.live(boardId)
    if (!entry) return false
    return (
      entry.db
        .prepare(
          "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 3) = 'lb_' LIMIT 1",
        )
        .get() !== undefined
    )
  }

  /** Puts captured shapes back (validated; see deleted/restore.ts). */
  restoreDeleted(boardId: string, ids: readonly string[]): RestoreSummary {
    const entry = this.existing(boardId)
    if (!entry)
      return {
        restored: [],
        skipped: ids.map((id) => ({ id, reason: 'not-found' })),
        bindings: 0,
        reparented: 0,
      }
    const summary = restoreDeleted({
      storage: entry.storage,
      store: entry.deleted,
      schema: this.opts.schema,
      ids,
    })
    if (summary.restored.length) this.documentChanged(boardId)
    return summary
  }

  private documentChanged(boardId: string) {
    try {
      this.opts.onDocumentChange?.(boardId)
    } catch (e) {
      this.opts.log?.('[room] onDocumentChange failed', boardId, (e as Error)?.message)
    }
  }

  /** Where this registry writes backups (null when backups are off). */
  backupsDir(): string | null {
    return this.backup?.dir ?? null
  }

  /** Backs up an OPEN board now, whether or not it changed (null when backups are off or it failed). */
  backupNow(boardId: string): Promise<BackupEntry | null> {
    const entry = this.live(boardId)
    return entry ? this.backupEntry(entry) : Promise.resolve(null)
  }

  /** Ids of every board that has a database file in this registry's data dir, sorted. */
  boardFileIds(): string[] {
    let names: string[]
    try {
      names = readdirSync(this.opts.dataDir)
    } catch {
      return []
    }
    return names
      .map((n) => BOARD_FILE_RE.exec(n)?.[1])
      .filter((id): id is string => id !== undefined && BOARD_ID_RE.test(id))
      .sort()
  }

  /**
   * A fresh backup of one board, whether or not it changed (POST /internal/backups/run-all, bridge
   * release R0): an open board through its room's own connection, after any backup in progress; any
   * other board file through a READ-ONLY connection, so no room is opened and nothing is written to the
   * file (a board born on the new canvas is copied whole: backup.ts). `holdUntil`: kept outside the
   * count-based retention until then (backup.ts BackupEntry.holdUntil). Throws when backups are off or
   * the copy fails. The backup is always one started after this call (never one already in progress).
   */
  async backupFresh(boardId: string, opts: { holdUntil?: Date } = {}): Promise<BackupEntry> {
    const b = this.backup
    if (!b) throw new Error('backups are off')
    let entry = this.live(boardId)
    while (entry?.backingUp) {
      await entry.backingUp
      entry = this.live(boardId)
    }
    if (entry) {
      const made = await this.backupEntry(entry, opts.holdUntil)
      if (!made) throw new Error('the backup failed (see the log)')
      return made
    }
    const path = boardDbPath(this.opts.dataDir, boardId)
    if (!existsSync(path)) throw new Error('the board has no database file')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      const made = await backupBoard({ db, boardId, root: b.dir, keep: b.keep, holdUntil: opts.holdUntil })
      if (!made.format) this.lastBackupClock.set(boardId, made.documentClock)
      return made
    } finally {
      db.close()
    }
  }

  /** One pass of the periodic backup: every open board that changed since its last backup, one at a time. */
  runBackupPass(): Promise<void> {
    if (!this.backup) return Promise.resolve()
    if (this.backupPass) return this.backupPass
    const pass = (async () => {
      for (const boardId of this.openBoards()) {
        const entry = this.live(boardId)
        if (entry && this.backupDue(entry)) await this.backupEntry(entry)
      }
    })().finally(() => {
      if (this.backupPass === pass) this.backupPass = null
    })
    this.backupPass = pass
    return pass
  }

  /** The open room of a board, if any (never opens one). */
  roomIfOpen(boardId: string): Room | null {
    return this.live(boardId)?.room ?? null
  }

  /** Board ids with an open room. */
  openBoards(): string[] {
    return [...this.rooms.keys()].filter((id) => this.live(id))
  }

  /** Sessions currently in a board's room (none when the room is not open). */
  sessionsOf(boardId: string): LiveSession[] {
    const room = this.live(boardId)?.room
    if (!room) return []
    return room.getSessions().map((s) => ({ sessionId: s.sessionId, meta: s.meta }))
  }

  has(boardId: string): boolean {
    return this.rooms.has(boardId)
  }

  private live(boardId: string): RoomEntry | null {
    const e = this.rooms.get(boardId)
    return e && !e.room.isClosed() ? e : null
  }

  /** The open entry, or the board's room opened from its existing database; null without storage. */
  private existing(boardId: string): RoomEntry | null {
    const entry = this.live(boardId)
    if (entry) return entry
    if (!existsSync(boardDbPath(this.opts.dataDir, boardId))) return null
    const opened = this.open(boardId)
    if (opened === 'exists') throw new Error('unreachable: open() without a seed never refuses')
    return opened
  }

  private open(boardId: string, seed?: RoomSnapshot): RoomEntry | 'exists' {
    const path = boardDbPath(this.opts.dataDir, boardId)
    // Bridge release R0 (r0/pre-open.ts): before any writable handle exists, a board born on the new
    // canvas is refused (BoardOpenRefused), so no TLSocketRoom or tldraw table is ever created in it.
    runPreOpenChecks({ boardId, path, exists: existsSync(path) })
    // A seed that fails leaves the board as it found it: no data, and no file it created itself.
    let removeOnFailure = seed !== undefined && !existsSync(path)
    const db = new DatabaseSync(path)
    const entry = {
      roomId: boardId,
      db,
      evictTimer: null,
      openedAt: this.now(),
      backingUp: null,
    } as RoomEntry
    try {
      db.exec('PRAGMA journal_mode = WAL') // outside any transaction; persistent in the file
      db.exec(`PRAGMA synchronous = ${this.opts.synchronous ?? 'FULL'}`)
      db.exec('PRAGMA busy_timeout = 5000')
      // Every storage transaction (a client push is one) ends with the "Recently deleted" flush, on
      // this same connection and before COMMIT: the captured rows share the push's fate.
      const sql = hookedSqlWrapper(new NodeSqliteWrapper(db), {
        beforeCommit: () => entry.deleted?.flush(),
        afterTransaction: () => entry.deleted?.discardPending(),
      })
      // First-time DDL + initial records atomic (the storage ctor never calls sql.transaction()).
      // IMMEDIATE takes the write lock before the initialized check, so the check stays true.
      db.exec('BEGIN IMMEDIATE')
      let refuse = false
      let schemaId = 0
      try {
        refuse = seed !== undefined && SQLiteSyncStorage.hasBeenInitialized(sql)
        // NEVER pass `snapshot` to an initialized database: the constructor deletes every record first.
        if (!refuse) {
          entry.storage = new SQLiteSyncStorage<TLRecord>({ sql, snapshot: seed })
          // Our own side tables (never tldraw's), created with the board.
          schemaId = ensureDeletedTables(db, JSON.stringify(this.opts.schema.serialize()))
        }
        db.exec(refuse ? 'ROLLBACK' : 'COMMIT')
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw e
      }
      if (refuse) {
        db.close()
        return 'exists'
      }
      // Committed: from here a failure must also remove the seeded data (the board had none before).
      removeOnFailure ||= seed !== undefined
      entry.deleted = new DeletedStore({
        db,
        schemaId,
        limits: this.opts.deleted,
        now: this.now,
        log: (...a: unknown[]) => this.opts.log?.(...a, boardId),
      })
      // One lease map per room; it lives and dies with this entry.
      entry.lease = createTextLease({
        leaseMs: this.opts.textLeaseMs ?? 5_000,
        onDenied: (sessionId, message) => {
          if (entry.room.isClosed()) return
          entry.room.sendCustomMessage(sessionId, message)
        },
      })
      entry.attribution = new AttributionLedger()
      entry.room = new TLSocketRoom<TLRecord, SessionMeta>({
        schema: this.opts.schema,
        storage: entry.storage,
        authorizeRecord: {
          // Note attribution first (SEAM-01), then the lease veto; a delete both allowed is captured
          // for "Recently deleted".
          ...withDeleteCapture(
            withNoteAttribution(entry.lease.authorizeRecord, {
              ledger: entry.attribution,
              deletedRow: (id) => entry.deleted.latestShapeRow(id),
              onForged: (kind, shapeId, sessionId) =>
                this.opts.log?.(
                  '[attribution] forged note attribution',
                  kind === 'create' ? 'stored anonymous' : 'skipped',
                  boardId,
                  shapeId,
                  'session:',
                  sessionId,
                ),
            }),
            entry.deleted,
          ),
          // Only the session's own tldraw user record, as its ticket says (G-R8).
          user: authorizeUserRecord,
        },
        // A client push committed a document change (read-only discards and presence never do).
        onCommittedChanges: () => this.documentChanged(boardId),
        log: {
          warn: (...a: unknown[]) => this.opts.log?.('[room warn]', boardId, ...a),
          error: (...a: unknown[]) => this.opts.log?.('[room error]', boardId, ...a),
        },
        onSessionRemoved: (room, { meta, numSessionsRemaining, sessionId }) => {
          // The removed session is already gone from getSessions(); the user's other tabs keep the lease.
          if (!room.getSessions().some((s) => s.meta.userId === meta.userId))
            entry.lease.releaseUser(meta.userId)
          // fires again ~5 s after room.close() for leftover sessions: ignore those
          if (room.isClosed() || this.rooms.get(boardId) !== entry) return
          this.opts.onSessionRemoved?.(boardId, sessionId, meta)
          if (numSessionsRemaining === 0) this.scheduleEvict(entry)
        },
      })
    } catch (e) {
      db.close() // e.g. 'Incompatible schema?' after a server rollback
      if (removeOnFailure) for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true })
      throw e
    }
    this.rooms.set(boardId, entry)
    // Nobody may ever join (an internal read, a seed): close it again unless a session arrives.
    this.scheduleEvict(entry)
    return entry
  }

  private scheduleEvict(entry: RoomEntry) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer)
    entry.evictTimer = setTimeout(() => this.evict(entry.roomId, entry), this.opts.idleEvictMs ?? 30_000)
  }

  private evict(boardId: string, entry: RoomEntry) {
    entry.evictTimer = null
    if (this.rooms.get(boardId) !== entry || entry.room.getNumActiveSessions() > 0) return
    // A board that was worked on gets its backup before it goes idle (the periodic pass only sees
    // open rooms). The room stays open meanwhile; a session arriving during the copy keeps it open.
    const b = this.backup
    if (b && this.now() - entry.openedAt >= b.evictBackupMinOpenMs && this.backupDue(entry)) {
      void this.backupEntry(entry).then(() => {
        if (this.rooms.get(boardId) !== entry || entry.room.isClosed() || entry.evictTimer) return
        if (entry.room.getNumActiveSessions() > 0) return
        this.closeEntry(entry)
      })
      return
    }
    this.closeEntry(entry)
  }

  private backupDue(entry: RoomEntry): boolean {
    if (!this.backup) return false
    if (!this.lastBackupClock.has(entry.roomId)) {
      let last: number | null = null
      try {
        last = readManifest(this.backup.dir, entry.roomId)?.backups.at(-1)?.documentClock ?? null
      } catch (e) {
        this.opts.log?.('[backup] unreadable manifest', entry.roomId, (e as Error)?.message)
      }
      this.lastBackupClock.set(entry.roomId, last)
    }
    const last = this.lastBackupClock.get(entry.roomId)
    return last === null || last === undefined || last !== entry.storage.getClock()
  }

  /** One backup of an open board at a time; `holdUntil` (backupFresh) is only asked for when none runs. */
  private backupEntry(entry: RoomEntry, holdUntil?: Date): Promise<BackupEntry | null> {
    const b = this.backup
    if (!b) return Promise.resolve(null)
    if (entry.backingUp) return entry.backingUp
    const run = (async () => {
      try {
        const made = await backupBoard({
          db: entry.db,
          boardId: entry.roomId,
          root: b.dir,
          keep: b.keep,
          holdUntil,
        })
        this.lastBackupClock.set(entry.roomId, made.documentClock)
        return made
      } catch (e) {
        this.opts.log?.('[backup] failed', entry.roomId, (e as Error)?.message ?? e)
        return null
      } finally {
        entry.backingUp = null
      }
    })()
    entry.backingUp = run
    return run
  }

  private closeEntry(entry: RoomEntry) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer)
    entry.evictTimer = null
    if (this.rooms.get(entry.roomId) === entry) this.rooms.delete(entry.roomId)
    entry.room.close()
    entry.deleted.close()
    // 5.4.2 bug: pruneTombstones is a trailing 1 s throttle; if it fires after db.close() it throws
    // uncaught and kills the process. flush() runs it now (it is @internal: re-check on upgrades).
    ;(entry.storage as unknown as { pruneTombstones?: { flush?: () => void } }).pruneTombstones?.flush?.()
    entry.db.close()
  }

  closeAll() {
    if (this.backupTimer) clearInterval(this.backupTimer)
    for (const e of [...this.rooms.values()]) this.closeEntry(e)
  }
}
