// Read-only facts about the new engine's tables in a board file (bridge release R0,
// docs/EXCALIDRAW-MIGRATION.md §5.10, open item 9). R0's backups copy a board file whole, `lb_*`
// included; a file born on the new canvas has ONLY `lb_*` tables, so the backup, the restore drill and
// readBoardDb (backup/backup.ts) describe it from these instead of tldraw's `documents` and `metadata`.
//
// Nothing here writes: every function takes an open handle (read-only in R0) and only SELECTs.
//
// The digests (also what the gate tests compare before and after R0 served a file):
//   tableDigest   one table: its `sqlite_master.sql` and the sha256 of its rows in primary-key order
//                 (rowid when it has none), every column typed and length-prefixed
//                 (the spike's apps/sync/src/room/migrate/digest.ts);
//   lbRecordsSha256  the backup manifest's `recordsSha256` for format `lobby-elements`: sha256 over
//                 `<name>\n<sql>\n<rows>\n<table sha256>\n` of every lb_* table, by name. A restore must
//                 reproduce it, as it must reproduce a tldraw board's records digest.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isLbTable } from './born-after.ts'

/** `format` of a backup manifest entry whose file holds only the new engine's tables (absent = tldraw). */
export const LB_BACKUP_FORMAT = 'lobby-elements'
export type BackupFormat = typeof LB_BACKUP_FORMAT

export interface TableDigest {
  readonly table: string
  /** `sqlite_master.sql` of the table (null when the table does not exist) */
  readonly sql: string | null
  readonly rows: number
  /** sha256 over the rows in primary-key order, each column typed and length-prefixed (null: no table) */
  readonly sha256: string | null
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** A table's schema SQL and row digest. */
export function tableDigest(db: DatabaseSync, table: string): TableDigest {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string | null }
    | undefined
  if (!master) return { table, sql: null, rows: 0, sha256: null }
  const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
    name: string
    pk: number
  }>
  const pk = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => quoteIdent(c.name))
  const order = pk.length ? pk.join(', ') : 'rowid'
  const cols = info.map((c) => quoteIdent(c.name)).join(', ')
  const hash = createHash('sha256')
  let rows = 0
  for (const row of db
    .prepare(`SELECT ${cols} FROM ${quoteIdent(table)} ORDER BY ${order}`)
    .iterate() as Iterable<Record<string, unknown>>) {
    rows++
    for (const c of info) {
      const v = row[c.name]
      const tag =
        v === null
          ? 'n'
          : typeof v === 'number'
            ? 'f'
            : typeof v === 'bigint'
              ? 'i'
              : typeof v === 'string'
                ? 's'
                : 'b'
      const bytes =
        v === null
          ? Buffer.alloc(0)
          : typeof v === 'string'
            ? Buffer.from(v, 'utf8')
            : typeof v === 'number' || typeof v === 'bigint'
              ? Buffer.from(String(v), 'utf8')
              : Buffer.from(v as Uint8Array)
      hash.update(`${tag}${bytes.length}:`)
      hash.update(bytes)
    }
    hash.update('\n')
  }
  return { table, sql: master.sql ?? '', rows, sha256: hash.digest('hex') }
}

/** Every lb_* table of the file, sorted by name. */
export function lbTableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string
    }>
  )
    .map((r) => r.name)
    .filter(isLbTable)
}

/** The digest of every lb_* table (lb_prev_* included), by name. */
export function lbDigests(db: DatabaseSync): Record<string, TableDigest> {
  return Object.fromEntries(lbTableNames(db).map((t) => [t, tableDigest(db, t)]))
}

export interface LbFileFacts {
  /** `lb_meta.clock` (0 when absent or not a count): the manifest's documentClock for this format. */
  documentClock: number
  /** What the manifest's `schema` holds for this format. */
  schema: { format: BackupFormat; schemaVersion: number | null }
  /** Rows of `lb_elements` (live elements and tombstones). */
  recordCount: number
  recordsSha256: string
}

const count = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === 'number' ? v : Number.NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/** Facts of a file described by its lb_* tables (read-only). */
export function lbFileFacts(db: DatabaseSync): LbFileFacts {
  const digests = Object.values(lbDigests(db))
  const hash = createHash('sha256')
  for (const d of digests) hash.update(`${d.table}\n${d.sql ?? ''}\n${d.rows}\n${d.sha256 ?? ''}\n`)
  const has = (t: string) => digests.some((d) => d.table === t)
  const meta = (key: string): unknown =>
    has('lb_meta')
      ? (db.prepare('SELECT value FROM lb_meta WHERE key = ?').get(key) as { value: unknown } | undefined)
          ?.value
      : undefined
  const elements = has('lb_elements')
    ? Number((db.prepare('SELECT count(*) AS n FROM lb_elements').get() as { n: number }).n)
    : 0
  return {
    documentClock: count(meta('clock')) ?? 0,
    schema: { format: LB_BACKUP_FORMAT, schemaVersion: count(meta('schemaVersion')) },
    recordCount: elements,
    recordsSha256: hash.digest('hex'),
  }
}
