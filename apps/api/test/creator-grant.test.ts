// Wave I, I2: the creator's OWN owner grant against a member removal (wave F's follow-up). Board creation
// (POST /api/workspaces/:wid/boards) and createBoardFrom (restore as new, duplicate, import) read the
// creator's workspace role with an unlocked read and only then locked the workspace row (assertBoardRoom,
// FOR NO KEY UPDATE), so a removal of the creator that ran in full between the two (it takes the workspace
// row first, deletes the membership and sweeps the grants) left a new board with an owner grant for a
// person who is no member any more: an orphan grant, alive again if they ever join the workspace again.
//
// The fix is the order: the workspace row first, the role read after it (access.ts, the lock order), so a
// removal either waits for the creation and sweeps its grant, or goes first and the creation finds nobody.
//
// PGlite has one connection, so two transactions never wait for each other here. These tests check what can
// be seen on it: the order of a transaction's statements (statement-log.ts), and, with a removal injected
// into the creating transaction itself at the moment it asks for the workspace row (what a removal that
// commits while the creator waits for that lock looks like from the creator's side), the outcome. The
// interleavings against a real removal are in creator-grant.pg.test.ts (set DRAFTROOM_TEST_DATABASE_URL).

import type { Db, Queryable, QueryResult } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'
import { orphanGrants } from './race-support.ts'
import { indexOfStatement, type StatementLog, statementLog } from './statement-log.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

// the first statement that takes the workspace row: the new lock, or (before the fix) assertBoardRoom's
const WORKSPACE_LOCK = /FROM workspaces .*FOR NO KEY UPDATE/
const ROLE_READ = /FROM workspace_members WHERE workspace_id = \$1 AND user_id = \$2/

/**
 * A Db that, once, runs `act` on a transaction's own connection right before the first statement of any
 * transaction that matches `pattern`: a stand-in for a member removal that commits at that very moment.
 */
function injectingDb(base: Db) {
  let armed: { pattern: RegExp; act: (tx: Queryable) => Promise<unknown> } | null = null
  const wrap = (tx: Queryable): Queryable => {
    const query = async <T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> => {
      const a = armed?.pattern.test(sql.replace(/\s+/g, ' ')) ? armed : null
      if (a) {
        armed = null
        await a.act(tx)
      }
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
      transaction: <T>(fn: (tx: Queryable) => Promise<T>) => base.transaction((tx) => fn(wrap(tx))),
    },
    arm(pattern: RegExp, act: (tx: Queryable) => Promise<unknown>) {
      armed = { pattern, act }
    },
  } as { db: Db; arm(pattern: RegExp, act: (tx: Queryable) => Promise<unknown>): void }
}

/** What a member removal does (routes/workspaces.ts): the membership, then every grant of theirs in the workspace. */
const removeMember = (userId: string) => async (tx: Queryable) => {
  await tx.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    DEV_STUDIO,
    userId,
  ])
  await tx.query(
    `DELETE FROM board_members bm USING boards b
      WHERE bm.board_id = b.id AND b.workspace_id = $1 AND bm.user_id = $2`,
    [DEV_STUDIO, userId],
  )
}

interface World {
  api: TestApi
  base: Db
  log: StatementLog
  inject: ReturnType<typeof injectingDb>
  sync: FakeSync
  alice: Client // owns Dev Studio
  bob: Client // a member (and a creator): the person who creates boards
  erin: Client // not a member of Dev Studio
  /** A private board of Dev Studio that bob owns. */
  board: string
}

async function world(): Promise<World> {
  const base = await openTestDb()
  const inject = injectingDb(base)
  const log = statementLog(inject.db)
  const sync = createFakeSync()
  const api = await createTestApi({ db: log.db, deps: { syncInternal: sync } })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const board = await createBoard(bob, DEV_STUDIO, 'Campaign review')
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'live content')])
  log.reset()
  return { api, base, log, inject, sync, alice, bob, erin, board }
}

const create = (c: Client, title = 'New board', wid = DEV_STUDIO) =>
  c.req('POST', `/api/workspaces/${wid}/boards`, { title })
const duplicate = (c: Client, board: string) => c.req('POST', `/api/boards/${board}/duplicate`, {})

const boardsMadeBy = async (api: TestApi, c: Client) =>
  (
    await api.db.query<{ id: string }>('SELECT id FROM boards WHERE created_by = $1 ORDER BY id', [c.userId])
  ).rows.map((r) => r.id)
const orphans = (api: TestApi, c: Client) => orphanGrants(api.db, DEV_STUDIO, c.userId)

describe('board creation: the workspace row is locked before the creator role is read', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('takes the workspace row FOR NO KEY UPDATE, then reads the role, then writes the owner grant', async () => {
    const res = await create(w.bob)
    expect(res.statusCode, res.body).toBe(201)
    const tx = w.log.transactions.find((t) => indexOfStatement(t, /INSERT INTO boards/) >= 0)
    expect(tx, 'the creation ran in one transaction').toBeDefined()
    if (!tx) return
    const lock = indexOfStatement(tx, WORKSPACE_LOCK)
    const role = indexOfStatement(tx, ROLE_READ)
    const grant = indexOfStatement(tx, /INSERT INTO board_members/)
    expect(lock, tx.statements.join('\n')).toBeGreaterThanOrEqual(0)
    expect(role, tx.statements.join('\n')).toBeGreaterThanOrEqual(0)
    // Before the fix the role was read first (unlocked): the lock came with assertBoardRoom, after it.
    expect(lock).toBeLessThan(role)
    expect(role).toBeLessThan(grant)
  })

  it('a creator whose membership is gone when the lock is granted gets a 404: no board, no owner grant', async () => {
    // a removal commits while bob waits for the workspace row (here: right before his transaction asks)
    w.inject.arm(WORKSPACE_LOCK, removeMember(w.bob.userId))
    const res = await create(w.bob, 'Too late')
    // Before the fix bob's role was read before the lock, so the board and its owner grant were written
    // after the removal (201) and the grant outlived the membership.
    expect(res.statusCode, res.body).toBe(404)
    expect(await boardsMadeBy(w.api, w.bob)).toEqual([w.board])
    expect(await orphans(w.api, w.bob)).toEqual([])
  })

  it('a stranger and an unknown workspace are still a plain 404 and create nothing', async () => {
    expect((await create(w.erin)).statusCode).toBe(404)
    expect((await create(w.bob, 'Nowhere', 'wsp_DoesNotExist0000000000')).statusCode).toBe(404)
    expect((await create(w.bob, 'Nowhere', 'not-a-workspace-id')).statusCode).toBe(404)
    expect(await boardsMadeBy(w.api, w.erin)).toEqual([])
    expect(await boardsMadeBy(w.api, w.bob)).toEqual([w.board])
  })

  it('locks the workspace row for a member and for nobody else (a stranger gets a 404 without the lock)', async () => {
    const lockedBy = async () =>
      (
        await w.api.db.one<{ x: string }>('SELECT xmax::text AS x FROM workspaces WHERE id = $1', [
          DEV_STUDIO,
        ])
      ).x
    const before = await lockedBy()
    expect((await create(w.erin)).statusCode).toBe(404)
    expect(await lockedBy(), 'a stranger must not be able to take the workspace row').toBe(before)
    expect((await create(w.bob)).statusCode).toBe(201)
    expect(await lockedBy()).not.toBe(before)
  })

  it('a plain member still creates a board and owns it', async () => {
    const res = await create(w.bob, 'Mine')
    expect(res.statusCode, res.body).toBe(201)
    const id = (res.json() as { id: string }).id
    const grant = await w.api.db.one<{ role: string }>(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [id, w.bob.userId],
    )
    expect(grant.role).toBe('owner')
    expect(await orphans(w.api, w.bob)).toEqual([])
  })
})

describe('createBoardFrom (duplicate, restore as new, import): same order for the creator', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('takes the workspace row FOR NO KEY UPDATE before it reads the role and writes the owner grant', async () => {
    const res = await duplicate(w.bob, w.board)
    expect(res.statusCode, res.body).toBe(201)
    const tx = w.log.transactions.find((t) => indexOfStatement(t, /INSERT INTO boards/) >= 0)
    expect(tx, 'the copy ran in one transaction').toBeDefined()
    if (!tx) return
    const lock = indexOfStatement(tx, WORKSPACE_LOCK)
    const role = indexOfStatement(tx, ROLE_READ)
    const grant = indexOfStatement(tx, /INSERT INTO board_members/)
    expect(lock, tx.statements.join('\n')).toBeGreaterThanOrEqual(0)
    expect(role, tx.statements.join('\n')).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(role)
    expect(role).toBeLessThan(grant)
  })

  it('a creator whose membership is gone when the lock is granted gets a 404: no copy, no owner grant', async () => {
    w.inject.arm(WORKSPACE_LOCK, removeMember(w.bob.userId))
    const res = await duplicate(w.bob, w.board)
    expect(res.statusCode, res.body).toBe(404)
    expect(await boardsMadeBy(w.api, w.bob)).toEqual([w.board])
    expect(await orphans(w.api, w.bob)).toEqual([])
  })

  it('a member still duplicates a board and owns the copy', async () => {
    const res = await duplicate(w.bob, w.board)
    expect(res.statusCode, res.body).toBe(201)
    const copy = (res.json() as { board: { id: string } }).board.id
    const grants = await w.api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1',
      [copy],
    )
    expect(grants.rows).toEqual([{ user_id: w.bob.userId, role: 'owner' }])
    expect(await orphans(w.api, w.bob)).toEqual([])
  })
})
