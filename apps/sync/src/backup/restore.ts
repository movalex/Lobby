// Putting a backup back as a board database (the drill uses this into a clean data dir; an operator
// uses it for disaster recovery with the sync server STOPPED, directly or through a staged restore
// that the next server start applies: staged-restore.ts).
//
// Clients that saw a newer state than the backup would otherwise keep "ghost" records: on reconnect
// they send a lastServerClock above the restored clock and are served no changes (SYNTHESIS §7).
// `bumpClockBy` raises the document clock and the tombstone-history start together, so every client
// whose clock is below the new start is sent a full reset (wipe_all) on its next connect.
//
// The copy is prepared next to the target and renamed over it only once it is complete, so a failure
// part-way leaves the existing database as it was. The backup file is copied with the `-wal` and `-shm`
// next to it, when there are any, folded into the copy (checkpoint.ts): a `--from=file` restore of an
// operator's raw copy of a live board, or of a board whose sync was killed before a checkpoint, would
// otherwise put back an older board, or an empty file (V3's R0 runbook note).

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isLbTable, tableNames } from '../r0/born-after.ts'
import { carryLbTables } from '../r0/lb-carry.ts'
import { lbFileFacts } from '../r0/lb-files.ts'
import { boardDbPath } from '../rooms.ts'
import { copyBoardFileSelfContained } from './checkpoint.ts'
import { backupEngine } from './engine.ts'

export interface RestoreBackupOptions {
  /** The backup file (backups/<boardId>/<file>.sqlite). */
  file: string
  /** The rooms folder of the target data dir (${DATA}/rooms). */
  roomsDir: string
  boardId: string
  /** Replace an existing board database there (default: refuse). */
  overwrite?: boolean
  /** Raise the clock by this much (0 = keep it; the drill keeps it to compare exactly). */
  bumpClockBy?: number
  /**
   * Bridge release R0: a consistent copy of the live board (a CONVERTED board, with lb_* tables) whose
   * new-canvas tables replace the restored copy's before it is put in place (r0/lb-carry.ts), so a
   * tldraw restore during a rollback keeps the Excalidraw-era edits. Absent: the backup as it is.
   */
  carryLbFrom?: string
}

/**
 * Whether a backup file holds only the new engine's lb_* tables (a board born on the new canvas), read
 * with one read-only connection. Its clock is `lb_meta.clock`. null for anything else, an unreadable
 * file included (the tldraw path below then fails on it exactly as before).
 */
export function newCanvasBackup(file: string): { documentClock: number } | null {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
  try {
    const tables = tableNames(db)
    if (tables.has('metadata') || tables.has('documents') || ![...tables].some(isLbTable)) return null
    return { documentClock: lbFileFacts(db).documentClock }
  } catch {
    return null
  } finally {
    db.close()
  }
}

/**
 * The Excalidraw build's converted backup (lb_* with `converted_from`, plus tldraw's tables): its clock is
 * `lb_meta.clock`, as the entry says (backup.ts). null for anything else.
 */
export function convertedBackup(file: string): { documentClock: number } | null {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
  try {
    const tables = tableNames(db)
    if (!tables.has('lb_meta')) return null
    const cf = db.prepare("SELECT 1 AS x FROM lb_meta WHERE key = 'converted_from'").get()
    return cf ? { documentClock: lbFileFacts(db).documentClock } : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

export function restoreBackupFile(opts: RestoreBackupOptions): { path: string; documentClock: number } {
  const path = boardDbPath(opts.roomsDir, opts.boardId)
  if (existsSync(path) && !opts.overwrite)
    throw new Error(`board ${opts.boardId} already has a database there`)
  // Bridge release R0 (open item 9): a board born on the new canvas is copied whole and never opened for
  // writing (R0 never writes an lb_* table), so its clock cannot be raised here: the new build restores
  // it (with a new epoch) after the switch. The drill restores it with bumpClockBy 0 to check it.
  const bump = Math.max(0, Math.floor(opts.bumpClockBy ?? 0))
  const lb =
    newCanvasBackup(opts.file) ?? (backupEngine() === 'excalidraw' ? convertedBackup(opts.file) : null)
  if (lb && bump > 0 && backupEngine() !== 'excalidraw')
    throw new Error('this backup is of a board made on the new canvas; restore it after the switch')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.restore-tmp`
  let documentClock: number
  if (lb && bump > 0) {
    // The Excalidraw build (2B): the backup's lb_* state goes back with a NEW epoch, so every client that
    // saw the board resets to it (the element room's reset rule, §2.6), and a clock raised past what
    // any client saw. Offline operator action on the restored copy, as the tldraw path below.
    try {
      copyBoardFileSelfContained(opts.file, tmp)
      const db = new DatabaseSync(tmp)
      try {
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('BEGIN IMMEDIATE')
        try {
          const set = db.prepare(
            'INSERT INTO lb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          )
          documentClock = lb.documentClock + bump
          set.run('clock', String(documentClock))
          set.run('epoch', `r${Date.now().toString(36)}${randomBytes(6).toString('base64url')}`)
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      } finally {
        db.close()
      }
      for (const f of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true })
      renameSync(tmp, path)
    } finally {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true })
    }
    return { path, documentClock }
  }
  if (lb) {
    try {
      copyBoardFileSelfContained(opts.file, tmp)
      for (const f of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true })
      renameSync(tmp, path)
    } finally {
      rmSync(tmp, { force: true })
    }
    return { path, documentClock: lb.documentClock }
  }
  try {
    copyBoardFileSelfContained(opts.file, tmp)
    const db = new DatabaseSync(tmp)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      const bump = Math.max(0, Math.floor(opts.bumpClockBy ?? 0))
      if (bump > 0) {
        // Offline operator action on the restored copy (never done by the running server).
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('UPDATE metadata SET documentClock = documentClock + ?').run(bump)
          db.exec('UPDATE metadata SET tombstoneHistoryStartsAtClock = documentClock')
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      }
      const row = db.prepare('SELECT documentClock FROM metadata LIMIT 1').get() as { documentClock: number }
      documentClock = Number(row.documentClock)
      if (opts.carryLbFrom) carryLbTables(db, opts.carryLbFrom)
    } finally {
      db.close() // the last connection: checkpoints and removes the copy's own -wal/-shm
    }
    // A stale WAL next to the replaced file would be replayed into the restored one.
    for (const f of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true })
    renameSync(tmp, path)
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true })
  }
  return { path, documentClock }
}
