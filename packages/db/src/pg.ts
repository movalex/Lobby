import type { Pool, PoolClient } from 'pg'
import { type Db, makeQueryable, type Queryable, type QueryResult } from './types.ts'

type Runner = Pick<Pool | PoolClient, 'query'>

function queryable(runner: Runner): Queryable {
  const query = async <T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> => {
    const r = await runner.query(sql, [...params])
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length }
  }
  // No parameters → node-postgres uses the simple protocol, which accepts several statements.
  return makeQueryable(query, async (sql) => {
    await runner.query(sql)
  })
}

/** node-postgres pool for deployments (DATABASE_URL). Loaded lazily so PGlite-only runs never load pg. */
export async function openPgPool(opts: { connectionString: string; maxConnections?: number }): Promise<Db> {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.maxConnections ?? 10 })
  // An idle client losing its connection emits 'error' on the pool; unhandled it would crash the process.
  pool.on('error', (err) => console.error(`db: idle connection error: ${err.message}`))
  return {
    kind: 'pg',
    ...queryable(pool),
    async transaction(fn) {
      const client = await pool.connect()
      let broken = false
      try {
        await client.query('BEGIN')
        const result = await fn(queryable(client))
        await client.query('COMMIT')
        return result
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          broken = true // do not return a connection in an unknown transaction state to the pool
        }
        throw err
      } finally {
        client.release(broken)
      }
    },
    close: () => pool.end(),
  }
}
