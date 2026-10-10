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

// ---- the pool's size (wave M, M5-2) ----------------------------------------------------------------------
//
// Staging's database has 0.1 CPU: past a few connections, more parallel queries only queue there (the board-open
// burst measured p95 0.4-1.1 s against about 5 ms for the same read alone), and the pool sat at its maximum of 10
// during bursts. DRAFTROOM_DB_POOL_MAX caps it (render.yaml sets 5 on the api); without it the pool keeps today's
// 10, so a deploy without the variable behaves as before, and the value rolls back without a code change.
//
// Audit (wave M, M5-2): a capped pool starves requests if a client is held while waiting on something else.
// - Only `transaction()` below takes a client (`pool.connect()`), and it releases it in `finally`
//   (packages/db/test/pool-max.test.ts holds every pool `.connect()` in the source trees to that).
// - No transaction body in apps/api/src awaits network I/O: no sync-internal call, blob-store call, fetch or
//   identity-provider call runs inside one (the code's own rule: auth/identity.ts "no provider call inside a
//   database transaction", worker/jobs.ts "no I/O inside a transaction"; checked by scanning every
//   `.transaction(` body for those calls).
// - The board event streams (SSE) and the event hub hold no client: a stream's re-check is one pooled query per
//   round (events/routes.ts loadBoardAccessMany), and publishing touches no database.
// - The api's /healthz/deep probe (`ping`) uses a one-connection pool of its own, never this one (the M5-6 review).

/** The pool size without DRAFTROOM_DB_POOL_MAX (today's). */
export const DB_POOL_MAX_DEFAULT = 10
/** The bounds DRAFTROOM_DB_POOL_MAX must be within. */
export const DB_POOL_MAX_MIN = 2
export const DB_POOL_MAX_MAX = 20
export const DB_POOL_MAX_ENV = 'DRAFTROOM_DB_POOL_MAX'

/**
 * The pool size from the environment: DRAFTROOM_DB_POOL_MAX, an integer from DB_POOL_MAX_MIN to DB_POOL_MAX_MAX;
 * unset or empty is DB_POOL_MAX_DEFAULT. Anything else throws (the process refuses to start, like a bad setting in
 * apps/api config.ts), never a silent guess.
 */
export function dbPoolMaxFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[DB_POOL_MAX_ENV]?.trim()
  if (raw === undefined || raw === '') return DB_POOL_MAX_DEFAULT
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(n) || n < DB_POOL_MAX_MIN || n > DB_POOL_MAX_MAX)
    throw new Error(
      `${DB_POOL_MAX_ENV} must be a whole number from ${DB_POOL_MAX_MIN} to ${DB_POOL_MAX_MAX} (got "${raw.slice(0, 20)}")`,
    )
  return n
}

/**
 * node-postgres pool for deployments (DATABASE_URL). Loaded lazily so PGlite-only runs never load pg.
 * `maxConnections` wins; without it the size comes from DRAFTROOM_DB_POOL_MAX (dbPoolMaxFromEnv).
 */
export async function openPgPool(opts: { connectionString: string; maxConnections?: number }): Promise<Db> {
  const max = opts.maxConnections ?? dbPoolMaxFromEnv()
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: opts.connectionString, max })
  // An idle client losing its connection emits 'error' on the pool; unhandled it would crash the process.
  pool.on('error', (err) => console.error(`db: idle connection error: ${err.message}`))
  // M5-6 review: the health probe's own connection (one, opened on the first ping, closed after a minute idle), so
  // a board-open burst queueing on the capped pool never reads as 'db', and a hung probe never holds a pool client.
  // Every bound is the client's own: connecting, the server's statement_timeout and the client's query_timeout;
  // a failed or timed-out query drops its connection (pg-pool's release(err)), so the next ping starts afresh.
  let probe: { pool: InstanceType<typeof pg.Pool>; timeoutMs: number } | null = null
  const probePool = (timeoutMs: number) => {
    if (probe && probe.timeoutMs === timeoutMs) return probe.pool
    void probe?.pool.end().catch(() => {})
    const p = new pg.Pool({
      connectionString: opts.connectionString,
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      idleTimeoutMillis: 60_000,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs,
      allowExitOnIdle: true,
      application_name: 'lobby-health-probe',
    })
    p.on('error', () => {}) // an idle probe connection that drops: the next ping reports it
    probe = { pool: p, timeoutMs }
    return p
  }
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
    async ping(timeoutMs) {
      await probePool(timeoutMs).query('SELECT 1 AS ok')
    },
    async close() {
      const p = probe?.pool
      probe = null
      await Promise.all([pool.end(), p?.end().catch(() => {})])
    },
  }
}
