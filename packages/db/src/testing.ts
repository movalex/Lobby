// Test helper: migrate one in-memory PGlite per test worker, then hand out cheap clones of it
// (loading a dumped data directory is several times faster than initdb + migrations).

import { migrate } from './migrate.ts'
import { openPglite, type PgliteDb } from './pglite.ts'

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

/** A fresh, fully migrated, isolated in-memory database. Close it when the test is done. */
export async function openTestDb(): Promise<PgliteDb> {
  template ??= buildTemplate()
  return openPglite({ loadDataDir: await template })
}
