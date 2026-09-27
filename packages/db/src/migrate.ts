// Forward-only SQL migrations (docs/M1-CONTRACTS.md §2): packages/db/migrations/NNNN_name.sql, applied
// in ascending order, each in its own transaction, recorded in schema_migrations with a checksum.
// A recorded migration whose file changed (or disappeared) stops the runner: shipped migrations are
// never edited, so a mismatch means the database and the code disagree about the schema.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db, Queryable } from './types.ts'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

export interface Migration {
  version: number
  name: string // file name without .sql, e.g. "0001_core"
  sql: string
  checksum: string
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/
// Serializes runners across processes sharing one Postgres (several api instances starting at once).
const LOCK_KEY = 7_401_266_019

/** sha256 of the file with line endings normalized, so a CRLF checkout does not look like an edit. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue
    const m = FILE_RE.exec(file)
    // A misnamed file would otherwise be skipped silently and its schema never applied.
    if (!m) throw new Error(`migration file name must match NNNN_name.sql: ${file}`)
    const version = Number(m[1])
    if (out.some((x) => x.version === version)) throw new Error(`duplicate migration number ${m[1]}`)
    const sql = readFileSync(join(dir, file), 'utf8')
    out.push({ version, name: file.slice(0, -4), sql, checksum: checksumOf(sql) })
  }
  return out.sort((a, b) => a.version - b.version)
}

interface AppliedRow {
  version: number
  name: string
  checksum: string
}

function checkRecorded(applied: AppliedRow[], files: Migration[]): void {
  for (const row of applied) {
    const file = files.find((f) => f.version === row.version)
    if (!file) throw new Error(`database has migration ${row.name}, which this build does not know`)
    if (file.name !== row.name || file.checksum !== row.checksum)
      throw new Error(`migration ${row.name} changed after it was applied (checksum mismatch)`)
  }
}

async function lock(tx: Queryable) {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY])
}

export interface MigrateResult {
  /** Names of the migrations applied by this call, in order (empty when already up to date). */
  applied: string[]
}

export async function migrate(
  db: Db,
  opts: { migrations?: Migration[]; dir?: string } = {},
): Promise<MigrateResult> {
  const files = opts.migrations ?? loadMigrations(opts.dir)
  await db.transaction(async (tx) => {
    await lock(tx)
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
  })

  const applied: string[] = []
  for (;;) {
    const next = await db.transaction(async (tx) => {
      await lock(tx)
      // Re-read under the lock: another process may have applied migrations meanwhile.
      const rows = (
        await tx.query<AppliedRow>('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      ).rows
      checkRecorded(rows, files)
      const done = new Set(rows.map((r) => r.version))
      const pending = files.find((f) => !done.has(f.version))
      if (!pending) return null
      const latest = rows.at(-1)
      if (latest && pending.version < latest.version)
        throw new Error(`migration ${pending.name} is older than the applied ${latest.name}; renumber it`)
      await tx.exec(pending.sql)
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        pending.version,
        pending.name,
        pending.checksum,
      ])
      return pending
    })
    if (!next) return { applied }
    applied.push(next.name)
  }
}
