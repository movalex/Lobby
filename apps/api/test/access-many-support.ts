// Shared by access-many.test.ts (PGlite) and access-many.pg.test.ts (real Postgres): a Db that counts the
// statements it is sent (outside and inside transactions), so a test can hold POST /internal/access-many to its
// two queries.

import type { Db, Queryable } from '@draftroom/db'

export interface CountingDb {
  db: Db
  /** every statement sent through `db` since the last reset (`statements.length = 0`), in order */
  statements: string[]
}

export function counting(base: Db): CountingDb {
  const statements: string[] = []
  const wrap = (q: Queryable): Queryable => ({
    query: (sql, params) => {
      statements.push(sql)
      return q.query(sql, params)
    },
    one: (sql, params) => {
      statements.push(sql)
      return q.one(sql, params)
    },
    maybeOne: (sql, params) => {
      statements.push(sql)
      return q.maybeOne(sql, params)
    },
    exec: (sql) => {
      statements.push(sql)
      return q.exec(sql)
    },
  })
  const db: Db = {
    kind: base.kind,
    ...wrap(base),
    transaction: (fn) => base.transaction((tx) => fn(wrap(tx))),
    close: () => base.close(),
  }
  return { db, statements }
}
