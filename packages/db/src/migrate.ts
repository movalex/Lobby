// Forward-only SQL migrations (docs/M1-CONTRACTS.md §2): packages/db/migrations/NNNN_name.sql, applied
// in ascending order, each in its own transaction, recorded in schema_migrations with a checksum.
// A recorded migration whose file changed (or disappeared) stops the runner: shipped migrations are
// never edited, so a mismatch means the database and the code disagree about the schema.
//
// Rolling back (docs/DEPLOY.md "Rollback"): a build older than the database's newest migrations
// refuses to start, unless `allowNewerSchema` (the api's DRAFTROOM_ALLOW_NEWER_SCHEMA=1) says the
// operator checked that those newer migrations are additive. Even then it only tolerates recorded
// migrations numbered above every one it knows; it applies nothing, and a recorded migration it should
// know but does not (an unknown OLDER one) or a checksum mismatch still stops it.

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

/**
 * Checks the recorded migrations against this build's files. Returns the recorded ones that are newer
 * than every file (tolerated only with `allowNewerSchema`; otherwise they throw like any unknown one).
 */
function checkRecorded(applied: AppliedRow[], files: Migration[], allowNewerSchema: boolean): AppliedRow[] {
  const newestKnown = files.reduce((n, f) => Math.max(n, f.version), 0)
  const newer: AppliedRow[] = []
  for (const row of applied) {
    const file = files.find((f) => f.version === row.version)
    if (!file) {
      // Only a newer migration can come from a later build; a gap below the newest known file is a
      // database that took another branch's migration, and no flag makes that safe.
      // A build that knows no migration at all (its files were not shipped) has no "older" to check
      // against: every recorded migration would pass as newer. Never start it on the flag.
      if (allowNewerSchema && files.length === 0)
        throw new Error(
          `database has migration ${row.name}, and this build has no migration files to check it against`,
        )
      if (allowNewerSchema && row.version > newestKnown) {
        newer.push(row)
        continue
      }
      throw new Error(`database has migration ${row.name}, which this build does not know`)
    }
    if (file.name !== row.name || file.checksum !== row.checksum)
      throw new Error(`migration ${row.name} changed after it was applied (checksum mismatch)`)
  }
  return newer
}

async function lock(tx: Queryable) {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY])
}

export interface MigrateResult {
  /** Names of the migrations applied by this call, in order (empty when already up to date). */
  applied: string[]
  /**
   * Recorded migrations newer than this build, tolerated because of `allowNewerSchema` (empty
   * otherwise). The caller should warn: this build runs on a schema it was not written for.
   */
  newer: string[]
}

export interface MigrateOptions {
  migrations?: Migration[]
  dir?: string
  /**
   * Start on a database that recorded migrations newer than every file of this build (a rollback).
   * Opt-in only: it is safe only when those migrations are additive for this build's queries.
   */
  allowNewerSchema?: boolean
}

export async function migrate(db: Db, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const files = opts.migrations ?? loadMigrations(opts.dir)
  const allowNewerSchema = opts.allowNewerSchema === true
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
      const newer = checkRecorded(rows, files, allowNewerSchema)
      const done = new Set(rows.map((r) => r.version))
      const pending = files.find((f) => !done.has(f.version))
      if (!pending) return { pending: null, newer }
      // A file of this build that the database never got cannot be applied under a schema that has
      // already moved past it (the newer migrations may depend on it not existing).
      if (newer.length)
        throw new Error(
          `migration ${pending.name} was never applied to this database, which already has newer migrations (${newer.map((r) => r.name).join(', ')}); this build cannot run on it`,
        )
      const latest = rows.at(-1)
      if (latest && pending.version < latest.version)
        throw new Error(`migration ${pending.name} is older than the applied ${latest.name}; renumber it`)
      await tx.exec(pending.sql)
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        pending.version,
        pending.name,
        pending.checksum,
      ])
      return { pending, newer }
    })
    if (!next.pending) return { applied, newer: next.newer.map((r) => r.name) }
    applied.push(next.pending.name)
  }
}
