// Wave M (M5-1, M5-3): a Db that records every statement it runs, pooled or inside a transaction, in order, so a
// test can count what one request costs the database (statement-log.ts records transactions only).

import type { Db, Queryable, QueryResult } from '@draftroom/db'

export interface CountedStatement {
  /** whitespace collapsed to single spaces */
  sql: string
  /** run inside db.transaction (else on the pool) */
  inTransaction: boolean
}

export interface QueryCounter {
  db: Db
  /** Every statement since the last reset(), oldest first. */
  statements: CountedStatement[]
  /** Transactions begun since the last reset(). */
  transactions: number
  reset(): void
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim()

export function countQueries(base: Db): QueryCounter {
  const counter: QueryCounter = {
    db: base,
    statements: [],
    transactions: 0,
    reset() {
      counter.statements.length = 0
      counter.transactions = 0
    },
  }
  const wrap = (q: Queryable, inTransaction: boolean): Queryable => {
    const query = <T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> => {
      counter.statements.push({ sql: squash(sql), inTransaction })
      return q.query<T>(sql, params)
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
      exec: (sql) => q.exec(sql),
    }
  }
  counter.db = {
    ...base,
    ...wrap(base, false),
    transaction: (fn) =>
      base.transaction((tx) => {
        counter.transactions++
        return fn(wrap(tx, true))
      }),
  }
  return counter
}

/** The session lookup every signed-in request makes first (auth/session.ts lookup). */
export const isSessionLookup = (s: CountedStatement) =>
  /FROM sessions s JOIN users u ON u\.id = s\.user_id/.test(s.sql)
