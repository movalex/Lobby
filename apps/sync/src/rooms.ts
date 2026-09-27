import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, type RoomSnapshot, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'

import type { TLRecord, TLSchema } from '@tldraw/tlschema'
import { createTextLease, type TextLease } from './lease.ts'
import type { BoardRole } from './permissions.ts'

/** Per-session data taken from the verified ticket (docs/M1-CONTRACTS.md §6). */
export interface SessionMeta {
  userId: string
  role: BoardRole
  name: string
}

export type Room = TLSocketRoom<TLRecord, SessionMeta>

interface RoomEntry {
  roomId: string
  room: Room
  db: DatabaseSync
  storage: SQLiteSyncStorage<TLRecord>
  lease: TextLease
  evictTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Lowercase only: Windows (NTFS) and macOS (APFS default) are case-insensitive, so 'Board' and
 * 'board' would otherwise be two TLSocketRoom instances on ONE sqlite file (split room).
 */
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/

export function boardDbPath(dataDir: string, boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
  // 'board-' prefix: the file base name can never be a Windows device name (con, nul, com1, ...)
  return join(resolve(dataDir), `board-${boardId}.sqlite`)
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
}

export interface LiveSession {
  sessionId: string
  meta: SessionMeta
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomEntry>()
  private readonly opts: RegistryOpts // no TS parameter properties: Node type stripping rejects them
  constructor(opts: RegistryOpts) {
    this.opts = opts
    mkdirSync(opts.dataDir, { recursive: true })
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
    let entry = this.live(boardId)
    if (!entry) {
      if (!existsSync(boardDbPath(this.opts.dataDir, boardId))) return null
      const opened = this.open(boardId)
      if (opened === 'exists') throw new Error('unreachable: open() without a seed never refuses')
      entry = opened
    }
    return entry.storage.getSnapshot()
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

  private open(boardId: string, seed?: RoomSnapshot): RoomEntry | 'exists' {
    const path = boardDbPath(this.opts.dataDir, boardId)
    // A seed that fails leaves the board as it found it: no data, and no file it created itself.
    let removeOnFailure = seed !== undefined && !existsSync(path)
    const db = new DatabaseSync(path)
    const entry = { roomId: boardId, db, evictTimer: null } as RoomEntry
    try {
      db.exec('PRAGMA journal_mode = WAL') // outside any transaction; persistent in the file
      db.exec(`PRAGMA synchronous = ${this.opts.synchronous ?? 'FULL'}`)
      db.exec('PRAGMA busy_timeout = 5000')
      const sql = new NodeSqliteWrapper(db)
      // First-time DDL + initial records atomic (the storage ctor never calls sql.transaction()).
      // IMMEDIATE takes the write lock before the initialized check, so the check stays true.
      db.exec('BEGIN IMMEDIATE')
      let refuse = false
      try {
        refuse = seed !== undefined && SQLiteSyncStorage.hasBeenInitialized(sql)
        // NEVER pass `snapshot` to an initialized database: the constructor deletes every record first.
        if (!refuse) entry.storage = new SQLiteSyncStorage<TLRecord>({ sql, snapshot: seed })
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
      // One lease map per room; it lives and dies with this entry.
      entry.lease = createTextLease({
        leaseMs: this.opts.textLeaseMs ?? 5_000,
        onDenied: (sessionId, message) => {
          if (entry.room.isClosed()) return
          entry.room.sendCustomMessage(sessionId, message)
        },
      })
      entry.room = new TLSocketRoom<TLRecord, SessionMeta>({
        schema: this.opts.schema,
        storage: entry.storage,
        authorizeRecord: entry.lease.authorizeRecord,
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
    this.closeEntry(entry)
  }

  private closeEntry(entry: RoomEntry) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer)
    entry.evictTimer = null
    if (this.rooms.get(entry.roomId) === entry) this.rooms.delete(entry.roomId)
    entry.room.close()
    // 5.4.2 bug: pruneTombstones is a trailing 1 s throttle; if it fires after db.close() it throws
    // uncaught and kills the process. flush() runs it now (it is @internal: re-check on upgrades).
    ;(entry.storage as unknown as { pruneTombstones?: { flush?: () => void } }).pruneTombstones?.flush?.()
    entry.db.close()
  }

  closeAll() {
    for (const e of [...this.rooms.values()]) this.closeEntry(e)
  }
}
