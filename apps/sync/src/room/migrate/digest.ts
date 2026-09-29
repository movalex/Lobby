// Digests the conversion and the drill compare (docs/EXCALIDRAW-MIGRATION.md §5.3, §5.9, §8.3 B8).
//
// - `recordsSha256`: sha256 over `id` and `state` of a tldraw `documents`-shaped table, ordered by id,
//   exactly as the backup manifest's `recordsSha256` is computed (backup/backup.ts readBoardDb). The
//   conversion writes it as `converted_from.sourceSha256` for `lb_source`, and the roll-forward refuses
//   a board whose `lb_source` no longer matches it.
// - `tableDigest`: a table's schema SQL and the sha256 of its rows in primary-key order (every column,
//   typed), for the R0 stand-in's "never writes lb_*" check and `dr_deleted_*` byte identity.
//
// Read-only; every function takes an open handle and never writes.

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** sha256 over `id\nstate\n` per row, by id (the backup manifest's `recordsSha256`). */
export function recordsSha256(db: DatabaseSync, table: 'documents' | 'lb_source'): string {
  const hash = createHash('sha256')
  for (const row of db.prepare(`SELECT id, state FROM ${table} ORDER BY id`).iterate() as Iterable<{
    id: string
    state: Uint8Array | string
  }>) {
    hash.update(row.id)
    hash.update('\n')
    hash.update(typeof row.state === 'string' ? Buffer.from(row.state, 'utf8') : row.state)
    hash.update('\n')
  }
  return hash.digest('hex')
}

export interface TableDigest {
  readonly table: string
  /** `sqlite_master.sql` of the table (null when the table does not exist) */
  readonly sql: string | null
  readonly rows: number
  /** sha256 over the rows in primary-key order, each column typed and length-prefixed */
  readonly sha256: string | null
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** A table's schema SQL and row digest (rows in rowid / primary-key order). */
export function tableDigest(db: DatabaseSync, table: string): TableDigest {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
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
  return { table, sql: master.sql, rows, sha256: hash.digest('hex') }
}

/** Every table whose name starts with `prefix` (sorted). */
export function tablesWithPrefix(db: DatabaseSync, prefix: string): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\' ORDER BY name",
      )
      .all(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as Array<{ name: string }>
  ).map((r) => r.name)
}

/** The digests of every `lb_*` table (lb_prev_* included), by name. */
export function lbDigests(db: DatabaseSync): Record<string, TableDigest> {
  return Object.fromEntries(tablesWithPrefix(db, 'lb_').map((t) => [t, tableDigest(db, t)]))
}

/** The digests of `dr_deleted_records` and `dr_deleted_schemas`. */
export function drDeletedDigests(db: DatabaseSync): Record<string, TableDigest> {
  return Object.fromEntries(['dr_deleted_records', 'dr_deleted_schemas'].map((t) => [t, tableDigest(db, t)]))
}

/** Every table name in the file, sorted. */
export function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
}
