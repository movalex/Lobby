// Board files for the tests that still meet boards of the tldraw era (docs/EXCALIDRAW-MIGRATION.md §5.10):
// tldraw boards written as the tldraw sync wrote them (../harness/tldraw-file.ts), the lb_* tables as the
// Excalidraw build writes them (the frozen §2.6 DDL), and read-only helpers that compare files.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'
import { lbDigests, type TableDigest, tableDigest } from '../../src/r0/lb-files.ts'
import { seedTldrawBoard } from '../harness/tldraw-file.ts'

export { seedTldrawBoard }

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** A temp dir removed after the test. */
export function tempDir(prefix = 'dr-r0-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

export const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Size of the file's WAL (0 when absent): a read-only reader must never add frames. */
export const walBytes = (path: string) => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)

/** The Excalidraw build's board file DDL (§2.6, frozen at the spike B contracts step). */
export const LB_DDL: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS lb_elements (id TEXT PRIMARY KEY, clock INTEGER NOT NULL, idx TEXT NOT NULL,
  deleted INTEGER NOT NULL, deleted_clock INTEGER, deleted_at INTEGER, type TEXT NOT NULL,
  version INTEGER NOT NULL, gclock TEXT NOT NULL,
  data TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS lb_elements_clock ON lb_elements(clock)',
  'CREATE INDEX IF NOT EXISTS lb_elements_order ON lb_elements(idx, id)',
  'CREATE TABLE IF NOT EXISTS lb_doc (key TEXT PRIMARY KEY, clock INTEGER NOT NULL, value TEXT)',
  `CREATE TABLE IF NOT EXISTS lb_deleted (seq INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL,
  element_id TEXT NOT NULL, type TEXT NOT NULL, container_id TEXT, frame_id TEXT,
  data TEXT NOT NULL, deleted_by TEXT NOT NULL, deleted_by_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, epoch TEXT NOT NULL, origin TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS lb_deleted_element ON lb_deleted(element_id, seq)',
  'CREATE INDEX IF NOT EXISTS lb_deleted_batch ON lb_deleted(batch)',
  'CREATE TABLE IF NOT EXISTS lb_source (id TEXT PRIMARY KEY, state BLOB NOT NULL)',
]

/** Every lb_* table a converted board can hold after one roll-forward (lb_prev_1_* copies included). */
export const ALL_LB_TABLES = [
  'lb_deleted',
  'lb_doc',
  'lb_elements',
  'lb_meta',
  'lb_prev_1_deleted',
  'lb_prev_1_doc',
  'lb_prev_1_elements',
  'lb_prev_1_meta',
  'lb_prev_1_source',
  'lb_source',
] as const

export const CONVERTED_FROM = {
  documentClock: 1,
  schemaHash: 'x',
  sourceSha256: 'y',
  converterVersion: '1',
  backupKey: null,
  deletedSeq: 0,
  lbClock: 1,
  cycle: 1,
}

/**
 * Writes the lb_* tables with rows in every one of them (text, integers, NULLs and a BLOB), as the
 * Excalidraw build leaves a board: `convertedFrom` false = born on the new canvas (no converted_from).
 */
function writeLbTables(db: DatabaseSync, opts: { convertedFrom: boolean; prev: boolean }) {
  db.exec('BEGIN IMMEDIATE')
  for (const stmt of LB_DDL) db.exec(stmt)
  const meta = db.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)')
  meta.run('clock', '7')
  meta.run('horizon', '0')
  meta.run('epoch', 'e-test-0001')
  meta.run('schemaVersion', '1')
  if (opts.convertedFrom) meta.run('converted_from', JSON.stringify(CONVERTED_FROM))
  const el = db.prepare(
    'INSERT INTO lb_elements (id, clock, idx, deleted, deleted_clock, deleted_at, type, version, gclock, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  el.run(
    'r1',
    3,
    'a0',
    0,
    null,
    null,
    'rectangle',
    2,
    '{"pos":3}',
    JSON.stringify({ id: 'r1', type: 'rectangle', x: 1.5 }),
  )
  el.run(
    'r2',
    7,
    'a1',
    1,
    7,
    1_700_000_000_000,
    'ellipse',
    4,
    '{}',
    JSON.stringify({ id: 'r2', type: 'ellipse' }),
  )
  db.prepare('INSERT INTO lb_doc (key, clock, value) VALUES (?, ?, ?)').run(
    'workshop',
    2,
    '{"hideCursors":true}',
  )
  db.prepare('INSERT INTO lb_doc (key, clock, value) VALUES (?, ?, ?)').run('tagDef:t1', 3, null)
  db.prepare(
    `INSERT INTO lb_deleted (batch, element_id, type, container_id, frame_id, data, deleted_by, deleted_by_name,
       deleted_at, epoch, origin) VALUES (1, 'r3', 'text', 'r1', NULL, '{"id":"r3"}', 'usr_a', 'Ann', 1700000000000, 'e-test-0001', 'converted')`,
  ).run()
  db.prepare('INSERT INTO lb_source (id, state) VALUES (?, ?)').run(
    'shape:s1',
    Buffer.from(JSON.stringify({ id: 'shape:s1', typeName: 'shape' }), 'utf8'),
  )
  if (opts.prev) {
    for (const t of ['meta', 'elements', 'doc', 'deleted', 'source'])
      db.exec(`CREATE TABLE lb_prev_1_${t} AS SELECT * FROM lb_${t}`)
  }
  db.exec('COMMIT')
}

/** A board born on the new canvas, as the Excalidraw build writes one: WAL, checkpointed and closed. */
export function makeBornAfterFile(path: string, opts: { withMeta?: boolean } = {}): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    if (opts.withMeta === false) {
      db.exec(LB_DDL[1] as string)
      db.prepare(
        "INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES ('r1', 1, 'a0', 0, 'rectangle', 1, '{}', '{}')",
      ).run()
    } else writeLbTables(db, { convertedFrom: false, prev: false })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** Adds every lb_* table (with `converted_from` and one roll-forward's lb_prev_1_*) to a tldraw board file. */
export function markConverted(path: string): void {
  const db = new DatabaseSync(path)
  try {
    writeLbTables(db, { convertedFrom: true, prev: true })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/** Every table name of a board file (read-only). */
export function tablesOf(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

export interface LbState {
  /** schema SQL + row digest of every lb_* table */
  lb: Record<string, TableDigest>
  /** every lb_* index's SQL (indexes are schema too) */
  lbIndexes: Array<{ name: string; sql: string | null }>
  /** lb_deleted's AUTOINCREMENT counter (sqlite_sequence is shared with dr_deleted_records) */
  lbSequences: Array<{ name: string; seq: number }>
}

/** What R0 must never change in a file: every lb_* table and index, and lb_* AUTOINCREMENT counters. */
export function lbState(path: string): LbState {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasSequence = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()
    return {
      lb: lbDigests(db),
      lbIndexes: db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND substr(name, 1, 3) = 'lb_' ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string | null }>,
      lbSequences: hasSequence
        ? (db
            .prepare("SELECT name, seq FROM sqlite_sequence WHERE substr(name, 1, 3) = 'lb_' ORDER BY name")
            .all() as Array<{ name: string; seq: number }>)
        : [],
    }
  } finally {
    db.close()
  }
}

/** Digest of one table (read-only), e.g. dr_deleted_records. */
export function tableState(path: string, table: string): TableDigest {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return tableDigest(db, table)
  } finally {
    db.close()
  }
}
