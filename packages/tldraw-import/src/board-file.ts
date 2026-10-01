/**
 * Reading a tldraw board file with `node:sqlite` directly (docs/EXCALIDRAW-MIGRATION.md §5.3 "Code"): the
 * `documents(id, state, lastChangedClock)` and `metadata(documentClock, schema)` tables written by
 * `@tldraw/sync-core`'s SQLiteSyncStorage, and Lobby's own "Recently deleted" side tables
 * `dr_deleted_records` / `dr_deleted_schemas` (apps/sync/src/deleted/store.ts). Node only (the api's
 * checkpoint path imports the package root, which never imports this file).
 *
 * Read-only: every function takes an open handle and only SELECTs. The digest is the backup manifest's
 * `recordsSha256` (apps/sync/src/backup/backup.ts): sha256 over `id\nstate\n` per row, by id.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface DocumentRow {
  readonly id: string
  /** the stored bytes of `state` (UTF-8 JSON), exactly as stored */
  readonly state: Uint8Array
}

export interface TldrawTables {
  readonly documentClock: number
  /** `metadata.schema` (a serialized tldraw schema), parsed */
  readonly schema: unknown
  /** the raw `metadata.schema` text (its hash is `converted_from.schemaHash`) */
  readonly schemaText: string
  /** every `documents` row, by id */
  readonly rows: readonly DocumentRow[]
  /** sha256 over the rows as the backup manifest's recordsSha256 is computed */
  readonly recordsSha256: string
}

const toBytes = (v: unknown): Uint8Array =>
  typeof v === 'string'
    ? Buffer.from(v, 'utf8')
    : v instanceof Uint8Array
      ? v
      : Buffer.from(String(v), 'utf8')

/** Whether the file has tldraw's tables (`documents` and `metadata`). */
export function hasTldrawTables(db: DatabaseSync): boolean {
  const names = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  )
  return names.has('documents') && names.has('metadata')
}

/** Reads `metadata` and every `documents` row (throws when the file is not an initialized tldraw board). */
export function readTldrawTables(db: DatabaseSync): TldrawTables {
  const meta = db.prepare('SELECT documentClock, schema FROM metadata LIMIT 1').get() as
    | { documentClock: number | bigint; schema: string }
    | undefined
  if (!meta?.schema) throw new Error('not an initialized tldraw board (no metadata row)')
  const hash = createHash('sha256')
  const rows: DocumentRow[] = []
  for (const r of db.prepare('SELECT id, state FROM documents ORDER BY id').iterate() as Iterable<{
    id: string
    state: unknown
  }>) {
    const state = toBytes(r.state)
    hash.update(r.id)
    hash.update('\n')
    hash.update(state)
    hash.update('\n')
    rows.push({ id: r.id, state })
  }
  return {
    documentClock: Number(meta.documentClock),
    schema: JSON.parse(meta.schema) as unknown,
    schemaText: meta.schema,
    rows,
    recordsSha256: hash.digest('hex'),
  }
}

/** Parses every row's state (JSON). */
export const parseRows = (rows: readonly DocumentRow[]): unknown[] =>
  rows.map((r) => JSON.parse(Buffer.from(r.state).toString('utf8')) as unknown)

/** sha256 of a text (the schema hash of `converted_from`). */
export const sha256Hex = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex')

/** The same digest over rows given in any order (sorted by id first). */
export function rowsSha256(rows: readonly DocumentRow[]): string {
  const hash = createHash('sha256')
  for (const r of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    hash.update(r.id)
    hash.update('\n')
    hash.update(r.state)
    hash.update('\n')
  }
  return hash.digest('hex')
}

// ---- "Recently deleted" (dr_deleted_*) ----------------------------------------------------------------------

export interface DrDeletedRow {
  readonly seq: number
  readonly batch: number
  readonly kind: 'shape' | 'binding'
  readonly recordId: string
  readonly fromId: string | null
  readonly toId: string | null
  /** the tldraw record as captured (JSON text) */
  readonly state: string
  /** the serialized schema it was captured under (dr_deleted_schemas.schema) */
  readonly schema: string
  readonly deletedBy: string
  readonly deletedByName: string
  readonly deletedAt: number
  readonly epoch: string
}

/** Whether the file has Lobby's "Recently deleted" tables. */
export function hasDeletedTables(db: DatabaseSync): boolean {
  const n = db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('dr_deleted_records', 'dr_deleted_schemas')",
    )
    .get() as { n: number }
  return Number(n.n) === 2
}

/** The `dr_deleted_records` rows with `seq > afterSeq`, by seq, each with its schema text. */
export function readDeletedRows(db: DatabaseSync, afterSeq = 0): DrDeletedRow[] {
  if (!hasDeletedTables(db)) return []
  const rows = db
    .prepare(
      `SELECT r.seq, r.batch, r.kind, r.record_id, r.from_id, r.to_id, r.state, s.schema, r.deleted_by,
              r.deleted_by_name, r.deleted_at, r.epoch
         FROM dr_deleted_records r JOIN dr_deleted_schemas s ON s.id = r.schema_id
        WHERE r.seq > ? ORDER BY r.seq`,
    )
    .all(afterSeq) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    seq: Number(r.seq),
    batch: Number(r.batch),
    kind: r.kind === 'binding' ? 'binding' : 'shape',
    recordId: String(r.record_id),
    fromId: r.from_id === null ? null : String(r.from_id),
    toId: r.to_id === null ? null : String(r.to_id),
    state: String(r.state),
    schema: String(r.schema),
    deletedBy: String(r.deleted_by),
    deletedByName: String(r.deleted_by_name),
    deletedAt: Number(r.deleted_at),
    epoch: String(r.epoch),
  }))
}

/** The highest `dr_deleted_records.seq` (0 when none). */
export function maxDeletedSeq(db: DatabaseSync): number {
  if (!hasDeletedTables(db)) return 0
  const r = db.prepare('SELECT max(seq) AS m FROM dr_deleted_records').get() as { m: number | null }
  return Number(r.m ?? 0)
}
