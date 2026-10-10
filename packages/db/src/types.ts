// One interface over two drivers: PGlite (Postgres compiled to WASM, in-process; dev + tests) and
// node-postgres (`pg.Pool` against DATABASE_URL; deployments). Same SQL dialect, same migrations.

export type Row = Record<string, unknown>

export interface QueryResult<T> {
  rows: T[]
  /** Rows returned (SELECT/RETURNING) or affected (UPDATE/DELETE/INSERT without RETURNING). */
  rowCount: number
}

/**
 * Value mapping differs slightly between drivers, so queries must not depend on it:
 * - timestamptz → Date in both.
 * - int8 / count(*) → number in PGlite but string in pg: cast to `::int` in SQL when you read one.
 * - jsonb params: pass `JSON.stringify(value)` with an explicit `$n::jsonb` cast.
 */
export interface Queryable {
  /** One statement, positional `$1..$n` parameters (extended protocol). */
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>
  /** Exactly one row, else throws (use for INSERT … RETURNING and lookups that must exist). */
  one<T = Row>(sql: string, params?: readonly unknown[]): Promise<T>
  /** Zero or one row; more than one throws (a missing unique constraint is a bug, not a choice). */
  maybeOne<T = Row>(sql: string, params?: readonly unknown[]): Promise<T | null>
  /** Several statements without parameters (simple protocol): migrations only. */
  exec(sql: string): Promise<void>
}

export interface Db extends Queryable {
  readonly kind: 'pglite' | 'pg'
  /**
   * Runs `fn` in BEGIN … COMMIT on one connection; any throw rolls back and re-throws.
   * Use only `tx` inside `fn`: PGlite has a single connection, so calling the outer Db from inside a
   * transaction would wait for the transaction to finish, which never happens (deadlock).
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
  /**
   * Wave M (M5-6 review): a liveness check for the api's /healthz/deep on a connection of its own, outside the pool
   * (a busy pool is not a database that is down, and a hung probe never holds one of its few connections). Resolves
   * once SELECT 1 answered within `timeoutMs`; rejects otherwise, by then at the latest (its connection is dropped).
   * Postgres only: PGlite has one in-process connection and no network to hang on.
   */
  ping?(timeoutMs: number): Promise<void>
}

export type DbConfig =
  /** In-memory when `dataDir` is omitted. `loadDataDir` clones a dumped data directory (tests). */
  | { kind: 'pglite'; dataDir?: string; loadDataDir?: Blob }
  | { kind: 'pg'; connectionString: string; maxConnections?: number }

export function expectOne<T>(rows: T[], sql: string): T {
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}: ${firstLine(sql)}`)
  return rows[0] as T
}

export function expectAtMostOne<T>(rows: T[], sql: string): T | null {
  if (rows.length > 1) throw new Error(`expected at most one row, got ${rows.length}: ${firstLine(sql)}`)
  return rows[0] ?? null
}

// Error messages carry the statement (never parameters, which may hold user data or token hashes).
const firstLine = (sql: string) => sql.trim().split('\n')[0]?.slice(0, 120) ?? ''

/** Postgres SQLSTATE of a driver error (both drivers expose `.code`). */
export function pgErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export const isUniqueViolation = (err: unknown) => pgErrorCode(err) === '23505'

type QueryFn = <T>(sql: string, params?: readonly unknown[]) => Promise<QueryResult<T>>

/** Builds the full Queryable from a driver's `query` and multi-statement `exec`. */
export function makeQueryable(query: QueryFn, exec: (sql: string) => Promise<void>): Queryable {
  return {
    query,
    one: async <T>(sql: string, params?: readonly unknown[]) =>
      expectOne((await query<T>(sql, params)).rows, sql),
    maybeOne: async <T>(sql: string, params?: readonly unknown[]) =>
      expectAtMostOne((await query<T>(sql, params)).rows, sql),
    exec,
  }
}
