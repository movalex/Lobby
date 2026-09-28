// Test helper: a fresh, fully migrated, isolated database per call.
//
// Default (PGlite): migrate one in-memory PGlite per test worker, then hand out cheap clones of it
// (loading a dumped data directory is several times faster than initdb + migrations).
//
// Opt-in (real Postgres): with DRAFTROOM_TEST_DATABASE_URL set to a database the tests may create and
// drop schemas in, each call gets its own new schema there instead (search_path pinned per connection),
// migrated from scratch and dropped on close. Same Db interface, but a real multi-connection pool, so
// row locks, SKIP LOCKED and concurrent transactions behave as in production.

import { randomBytes } from 'node:crypto'
import { migrate } from './migrate.ts'
import { openPgPool } from './pg.ts'
import { openPglite } from './pglite.ts'
import type { Db } from './types.ts'

export const TEST_DATABASE_URL_ENV = 'DRAFTROOM_TEST_DATABASE_URL'

let template: Promise<Blob> | null = null

async function buildTemplate(): Promise<Blob> {
  const db = await openPglite()
  try {
    await migrate(db)
    return await db.dump()
  } finally {
    await db.close()
  }
}

async function adminExec(url: string, sql: string): Promise<void> {
  const admin = await openPgPool({ connectionString: url, maxConnections: 1 })
  try {
    await admin.exec(sql)
  } finally {
    await admin.close()
  }
}

async function openPgTestDb(url: string): Promise<Db> {
  const schema = `dr_test_${process.pid}_${randomBytes(6).toString('hex')}`
  await adminExec(url, `CREATE SCHEMA ${schema}`)
  const drop = () => adminExec(url, `DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  const scoped = new URL(url)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  let db: Db
  try {
    db = await openPgPool({ connectionString: scoped.toString() })
  } catch (e) {
    await drop()
    throw e
  }
  try {
    await migrate(db)
  } catch (e) {
    await db.close()
    await drop()
    throw e
  }
  let closing: Promise<void> | null = null
  return {
    ...db,
    close() {
      closing ??= db.close().then(drop)
      return closing
    },
  }
}

/** A fresh, fully migrated, isolated database. Close it when the test is done. */
export async function openTestDb(): Promise<Db> {
  const url = process.env[TEST_DATABASE_URL_ENV]
  if (url) return openPgTestDb(url)
  template ??= buildTemplate()
  return openPglite({ loadDataDir: await template })
}
