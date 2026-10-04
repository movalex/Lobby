// A Db that remembers the statements of every transaction it runs, in order, so a test can check which
// locks a route takes and in what order (the row-lock order of apps/api/src/access.ts) on PGlite, where two
// transactions never wait for each other: the interleavings themselves are the .pg tests (race-support.ts).
//
// Only `transaction` is wrapped: what the callback runs goes to the real transaction unchanged, and
// statements made outside a transaction (a route's pre-checks) are not recorded.

import type { Db, Queryable, QueryResult } from '@draftroom/db'

export interface LoggedTransaction {
  /** The statements in the order they were sent, whitespace collapsed to single spaces. */
  statements: string[]
}

export interface StatementLog {
  db: Db
  /** Every transaction run through `db` since the last `reset()`, oldest first. */
  transactions: LoggedTransaction[]
  reset(): void
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim()

export function statementLog(base: Db): StatementLog {
  const transactions: LoggedTransaction[] = []

  const wrap = (tx: Queryable, into: LoggedTransaction): Queryable => {
    const query = async <T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> => {
      into.statements.push(squash(sql))
      return tx.query<T>(sql, params)
    }
    return {
      query,
      one: async <T>(sql: string, params?: readonly unknown[]) => {
        const { rows } = await query<T>(sql, params)
        if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`)
        return rows[0] as T
      },
      maybeOne: async <T>(sql: string, params?: readonly unknown[]) => {
        const { rows } = await query<T>(sql, params)
        if (rows.length > 1) throw new Error(`expected at most one row, got ${rows.length}`)
        return (rows[0] ?? null) as T | null
      },
      exec: (sql) => tx.exec(sql),
    }
  }

  return {
    db: {
      ...base,
      transaction: (fn) =>
        base.transaction((tx) => {
          const entry: LoggedTransaction = { statements: [] }
          transactions.push(entry)
          return fn(wrap(tx, entry))
        }),
    },
    transactions,
    reset: () => {
      transactions.length = 0
    },
  }
}

/** The index of the first statement matching `pattern` (-1 when none does). */
export const indexOfStatement = (t: LoggedTransaction, pattern: RegExp, from = 0): number =>
  t.statements.findIndex((s, i) => i >= from && pattern.test(s))
