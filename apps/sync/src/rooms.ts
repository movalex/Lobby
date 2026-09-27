import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'

import type { TLRecord, TLSchema } from '@tldraw/tlschema'
import { createTextLease, type TextLease } from './lease.ts'

export interface SessionMeta {
  userId: string
}

interface RoomEntry {
  roomId: string
  room: TLSocketRoom<TLRecord, SessionMeta>
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
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomEntry>()
  private readonly opts: RegistryOpts // no TS parameter properties: Node type stripping rejects them
  constructor(opts: RegistryOpts) {
    this.opts = opts
    mkdirSync(opts.dataDir, { recursive: true })
  }

  /** Synchronous on purpose: no await between lookup and insert, so creation is race-free. */
  getOrCreate(boardId: string): TLSocketRoom<TLRecord, SessionMeta> {
    const existing = this.rooms.get(boardId)
    if (existing && !existing.room.isClosed()) {
      if (existing.evictTimer) {
        clearTimeout(existing.evictTimer)
        existing.evictTimer = null
      }
      return existing.room
    }
    const db = new DatabaseSync(boardDbPath(this.opts.dataDir, boardId))
    const entry = { roomId: boardId, db, evictTimer: null } as RoomEntry
    try {
      db.exec('PRAGMA journal_mode = WAL') // outside any transaction; persistent in the file
      db.exec(`PRAGMA synchronous = ${this.opts.synchronous ?? 'FULL'}`)
      db.exec('PRAGMA busy_timeout = 5000')
      const sql = new NodeSqliteWrapper(db)
      db.exec('BEGIN IMMEDIATE') // first-time DDL + seed atomic; the ctor never calls sql.transaction()
      try {
        entry.storage = new SQLiteSyncStorage<TLRecord>({ sql }) // NEVER pass `snapshot` here: it wipes the DB
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
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
        onSessionRemoved: (room, { meta, numSessionsRemaining }) => {
          // The removed session is already gone from getSessions(); the user's other tabs keep the lease.
          if (!room.getSessions().some((s) => s.meta.userId === meta.userId))
            entry.lease.releaseUser(meta.userId)
          // fires again ~5 s after room.close() for leftover sessions: ignore those
          if (room.isClosed() || this.rooms.get(boardId) !== entry) return
          if (numSessionsRemaining > 0) return
          if (entry.evictTimer) clearTimeout(entry.evictTimer)
          entry.evictTimer = setTimeout(() => this.evict(boardId, entry), this.opts.idleEvictMs ?? 30_000)
        },
      })
    } catch (e) {
      db.close() // e.g. 'Incompatible schema?' after a server rollback
      throw e
    }
    this.rooms.set(boardId, entry)
    return entry.room
  }

  has(boardId: string): boolean {
    return this.rooms.has(boardId)
  }

  private evict(boardId: string, entry: RoomEntry) {
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
