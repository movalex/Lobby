// Board files of the tldraw era, written with node:sqlite alone (no @tldraw/sync-core on this branch):
// the tables SQLiteSyncStorage 5.4.2 wrote (`documents`, `tombstones`, `metadata`, `objects`; migration
// version 3) and Lobby's "Recently deleted" side tables (`dr_deleted_*`, apps/sync/src/deleted/store.ts of
// the tldraw era). Every test that needs a board "from before the cut-over" (the conversion, the
// roll-forward, the backups and restores of such files) starts from these; the converter's reader
// (packages/tldraw-import/src/board-file.ts) reads exactly these tables.
import { existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { currentSchema } from '@draftroom/tldraw-import'
import { type BackupEntry, backupBoard } from '../../src/backup/backup.ts'
import { backupsDirFor, boardDbPath } from '../../src/rooms.ts'

/** Any tldraw record (tlschema's branded types fit; no index signature, so interfaces do too). */
export type TlRecordLike = { readonly id: string; readonly typeName: string }

/** SQLiteSyncStorage 5.4.2's tables (its migrations 1 to 3), as `CREATE TABLE` in dist-esm/lib/SQLiteSyncStorage.mjs. */
const TLDRAW_DDL = `
CREATE TABLE documents (id TEXT PRIMARY KEY, state BLOB NOT NULL, lastChangedClock INTEGER NOT NULL);
CREATE INDEX idx_documents_lastChangedClock ON documents(lastChangedClock);
CREATE TABLE tombstones (id TEXT PRIMARY KEY, clock INTEGER NOT NULL);
CREATE INDEX idx_tombstones_clock ON tombstones(clock);
CREATE TABLE metadata (migrationVersion INTEGER NOT NULL, documentClock INTEGER NOT NULL, tombstoneHistoryStartsAtClock INTEGER NOT NULL, schema TEXT NOT NULL);
CREATE TABLE objects (id TEXT PRIMARY KEY, state BLOB NOT NULL, lastChangedClock INTEGER NOT NULL);
CREATE INDEX idx_objects_lastChangedClock ON objects(lastChangedClock);
`

/** Lobby's "Recently deleted" side tables of the tldraw era (deleted/store.ts DDL, verbatim). */
const DELETED_DDL = `
CREATE TABLE IF NOT EXISTS dr_deleted_schemas (
  id INTEGER PRIMARY KEY,
  schema TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS dr_deleted_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  batch INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shape', 'binding')),
  record_id TEXT NOT NULL,
  shape_type TEXT,
  parent_id TEXT,
  from_id TEXT,
  to_id TEXT,
  state TEXT NOT NULL,
  schema_id INTEGER NOT NULL REFERENCES dr_deleted_schemas (id),
  deleted_by TEXT NOT NULL,
  deleted_by_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  epoch TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dr_deleted_records_record_idx ON dr_deleted_records (record_id, seq);
CREATE INDEX IF NOT EXISTS dr_deleted_records_batch_idx ON dr_deleted_records (batch);
`

export const DOCUMENT_RECORD = {
  id: 'document:document',
  typeName: 'document',
  gridSize: 10,
  name: '',
  meta: {},
}
export const PAGE_RECORD = { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} }

const encode = (r: unknown) => Buffer.from(JSON.stringify(r), 'utf8')

/**
 * Writes a tldraw board file at `path` holding `records` (every one at `documentClock`), WAL mode like
 * the server's files, checkpointed and closed (no `-wal` frames left: a read-only reader adds none).
 */
export function writeTldrawBoardFile(
  path: string,
  records: readonly TlRecordLike[],
  opts: { documentClock?: number; schema?: unknown } = {},
): void {
  const clock = opts.documentClock ?? 0
  const schemaText = JSON.stringify(opts.schema ?? currentSchema())
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('BEGIN IMMEDIATE')
    db.exec(TLDRAW_DDL)
    db.prepare(
      'INSERT INTO metadata (migrationVersion, documentClock, tombstoneHistoryStartsAtClock, schema) VALUES (3, ?, 0, ?)',
    ).run(clock, schemaText)
    const insert = db.prepare('INSERT INTO documents (id, state, lastChangedClock) VALUES (?, ?, ?)')
    for (const r of records) insert.run(r.id, encode(r), clock)
    db.exec(DELETED_DDL)
    db.prepare('INSERT OR IGNORE INTO dr_deleted_schemas (schema) VALUES (?)').run(schemaText)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** A tldraw board of the document, one page and `records` (what a board the tldraw page made holds). */
export function seedTldrawBoard(
  dataDir: string,
  boardId: string,
  records: readonly TlRecordLike[] = [],
): string {
  mkdirSync(dataDir, { recursive: true })
  const path = boardDbPath(dataDir, boardId)
  writeTldrawBoardFile(path, [DOCUMENT_RECORD, PAGE_RECORD, ...records])
  return path
}

/** A tldraw board of exactly `records` (document and pages included, as the converter fixtures are). */
export function seedBoardRecords(dataDir: string, boardId: string, records: readonly TlRecordLike[]): string {
  mkdirSync(dataDir, { recursive: true })
  const path = boardDbPath(dataDir, boardId)
  writeTldrawBoardFile(path, records)
  return path
}

/** Writes (or replaces) `records` as one more tldraw-side change: the document clock moves by one. */
export function appendTldrawRecords(path: string, records: readonly TlRecordLike[]): number {
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN IMMEDIATE')
    const row = db.prepare('SELECT documentClock FROM metadata LIMIT 1').get() as { documentClock: number }
    const clock = Number(row.documentClock) + 1
    const upsert = db.prepare(
      'INSERT INTO documents (id, state, lastChangedClock) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, lastChangedClock = excluded.lastChangedClock',
    )
    for (const r of records) {
      upsert.run(r.id, encode(r), clock)
      db.prepare('DELETE FROM tombstones WHERE id = ?').run(r.id)
    }
    db.prepare('UPDATE metadata SET documentClock = ?').run(clock)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return clock
  } finally {
    db.close()
  }
}

/** A local backup of the board file at `path` (what the tldraw registry's backupNow made of an open board). */
export async function backupTldrawBoard(
  path: string,
  boardId: string,
  root: string,
  opts: { keep?: number; holdUntil?: Date } = {},
): Promise<BackupEntry> {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return await backupBoard({ db, boardId, root, ...opts })
  } finally {
    db.close()
  }
}

/**
 * A tldraw board a test edits and backs up: what the backup tests did through a room and a protocol
 * client before wave 4 part 2 (`put` records, `backupNow`).
 */
export function tldrawBoard(roomsDir: string, boardId: string, backupsRoot?: string) {
  // an existing file is opened as it is (what the registry's getOrCreate did); a new board is seeded
  const existing = boardDbPath(roomsDir, boardId)
  const path = existsSync(existing) ? existing : seedTldrawBoard(roomsDir, boardId)
  const root = backupsRoot ?? backupsDirFor(roomsDir)
  return {
    path,
    put(...records: readonly TlRecordLike[]): number {
      return appendTldrawRecords(path, records)
    },
    backupNow(opts: { keep?: number; holdUntil?: Date } = {}): Promise<BackupEntry> {
      if (!root) throw new Error('no backups root for this rooms folder')
      return backupTldrawBoard(path, boardId, root, opts)
    },
  }
}
