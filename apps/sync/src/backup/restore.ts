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
// part-way leaves the existing database as it was.

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isLbTable, tableNames } from '../r0/born-after.ts'
import { lbFileFacts } from '../r0/lb-files.ts'
import { boardDbPath } from '../rooms.ts'

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

export function restoreBackupFile(opts: RestoreBackupOptions): { path: string; documentClock: number } {
  const path = boardDbPath(opts.roomsDir, opts.boardId)
  if (existsSync(path) && !opts.overwrite)
    throw new Error(`board ${opts.boardId} already has a database there`)
  // Bridge release R0 (open item 9): a board born on the new canvas is copied whole and never opened for
  // writing (R0 never writes an lb_* table), so its clock cannot be raised here: the new build restores
  // it (with a new epoch) after the switch. The drill restores it with bumpClockBy 0 to check it.
  const lb = newCanvasBackup(opts.file)
  if (lb && Math.max(0, Math.floor(opts.bumpClockBy ?? 0)) > 0)
    throw new Error('this backup is of a board made on the new canvas; restore it after the switch')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.restore-tmp`
  let documentClock: number
  if (lb) {
    try {
      copyFileSync(opts.file, tmp)
      for (const f of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true })
      renameSync(tmp, path)
    } finally {
      rmSync(tmp, { force: true })
    }
    return { path, documentClock: lb.documentClock }
  }
  try {
    copyFileSync(opts.file, tmp)
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
