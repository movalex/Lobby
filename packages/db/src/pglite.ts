import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type Db, makeQueryable, type Queryable, type QueryResult } from './types.ts'

type Runner = Pick<PGlite | Transaction, 'query' | 'exec'>

function queryable(runner: Runner): Queryable {
  const query = async <T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> => {
    const r = await runner.query<T>(sql, [...params])
    // rowCount is per statement; affectedRows is the older cumulative field.
    return { rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length }
  }
  return makeQueryable(query, async (sql) => {
    await runner.exec(sql)
  })
}

export interface PgliteDb extends Db {
  readonly kind: 'pglite'
  /** Uncompressed tarball of the data directory; `openPglite({ loadDataDir })` clones it. */
  dump(): Promise<Blob>
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, owned by someone else
  }
}

/**
 * PGlite takes no lock on its data directory (verified with 0.5.8: a second instance opens and writes
 * the same directory), and two writers corrupt it. `<dataDir>.lock` holds the owner's pid; a lock
 * left by a crashed process is taken over.
 */
function lockDataDir(dataDir: string): () => void {
  const path = `${resolve(dataDir)}.lock`
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' })
      let held = true
      // Idempotent: a second close() must not delete a lock another opener has taken since.
      return () => {
        if (held) rmSync(path, { force: true })
        held = false
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let owner = Number.NaN
    try {
      owner = Number(readFileSync(path, 'utf8').trim())
    } catch {}
    if (Number.isInteger(owner) && owner > 0 && processAlive(owner))
      throw new Error(`database directory ${dataDir} is already open in process ${owner}`)
    rmSync(path, { force: true }) // stale: its owner is gone
  }
  throw new Error(`could not lock database directory ${dataDir}`)
}

/**
 * PGlite is single-connection and single-process: one instance per data directory (enforced with a
 * lock file). Statements from concurrent requests are serialized by PGlite.
 */
export async function openPglite(opts: { dataDir?: string; loadDataDir?: Blob } = {}): Promise<PgliteDb> {
  const unlock = opts.dataDir ? lockDataDir(opts.dataDir) : () => {}
  let pg: PGlite
  try {
    pg = new PGlite({ dataDir: opts.dataDir, loadDataDir: opts.loadDataDir })
    await pg.waitReady
  } catch (e) {
    unlock()
    throw e
  }
  return {
    kind: 'pglite',
    ...queryable(pg),
    transaction: (fn) => pg.transaction((tx) => fn(queryable(tx))),
    dump: () => pg.dumpDataDir('none'),
    close: async () => {
      try {
        if (!pg.closed) await pg.close()
      } finally {
        unlock()
      }
    },
  }
}
