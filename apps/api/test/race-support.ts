// Support for the real-Postgres tests that force an interleaving (workspace-offboarding.pg,
// offboarding-races.pg, offboarding-email-grant.pg).
//
// pausingDb: a Db whose next transaction stops midway, so a test can run another request while the first
// one holds exactly the locks it has taken so far. The route under test is the real one: only its
// connection's statements pass through here, and nothing changes about what they do.

import type { Db, Queryable, QueryResult } from '@draftroom/db'

export interface Pause {
  /** Resolves with the paused connection's backend pid once the matching statement is reached. */
  reached: Promise<number>
  /** Lets the paused transaction go on (idempotent; also what a test's cleanup calls). */
  release(): void
}

export interface PausingDb {
  db: Db
  /**
   * Arms a one-shot pause on the FIRST statement (of any transaction) that matches `pattern`:
   * 'before' stops before it is sent, 'after' stops once it has run (its locks are held).
   */
  arm(pattern: RegExp, when: 'before' | 'after'): Pause
}

export function pausingDb(base: Db): PausingDb {
  let armed: { pattern: RegExp; when: 'before' | 'after'; stop: (tx: Queryable) => Promise<void> } | null =
    null

  const wrap = (tx: Queryable): Queryable => {
    const query = async <T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> => {
      const next = armed
      const a = next?.pattern.test(sql) ? next : null
      if (a) armed = null
      if (a?.when === 'before') await a.stop(tx)
      const result = await tx.query<T>(sql, params)
      if (a?.when === 'after') await a.stop(tx)
      return result
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
    db: { ...base, transaction: (fn) => base.transaction((tx) => fn(wrap(tx))) },
    arm(pattern, when) {
      let release = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      let reach: (pid: number) => void = () => {}
      const reached = new Promise<number>((r) => {
        reach = r
      })
      armed = {
        pattern,
        when,
        stop: async (tx) => {
          // the connection is idle while the test runs: ask it which backend it is
          const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          reach(rows[0]?.pid ?? 0)
          await gate
        },
      }
      return { reached, release }
    },
  }
}

/** Resolves once some backend is waiting for a lock that the connection `pid` holds. */
export async function blockedBy(db: Db, pid: number, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [pid],
    )
    if (r.n > 0) return
    if (Date.now() > until) throw new Error(`${what} never waited for the held lock`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * What `request` (just started) did while the transaction `pid` was held: 'waited' once something was
 * blocked by it, 'finished' if the request ran to its end without ever waiting.
 */
export async function waitedOrFinished(
  db: Db,
  pid: number,
  request: Promise<unknown>,
  timeoutMs = 10_000,
): Promise<'waited' | 'finished'> {
  let finished = false
  request.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    },
  )
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [pid],
    )
    if (r.n > 0) return 'waited'
    if (finished) return 'finished'
    if (Date.now() > until) throw new Error('the request neither waited for the held lock nor finished')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Their board grants in a workspace that outlive their membership of it (there must never be one). */
export async function orphanGrants(q: Queryable, workspaceId: string, userId: string): Promise<string[]> {
  const r = await q.query<{ board_id: string }>(
    `SELECT bm.board_id FROM board_members bm JOIN boards b ON b.id = bm.board_id
      WHERE b.workspace_id = $1 AND bm.user_id = $2
        AND NOT EXISTS (SELECT 1 FROM workspace_members wm
                         WHERE wm.workspace_id = b.workspace_id AND wm.user_id = bm.user_id)`,
    [workspaceId, userId],
  )
  return r.rows.map((row) => row.board_id)
}
