// 0025_open_signin (docs/OPEN-SIGNIN.md): the identity provider and address source 'email', and
// boards.external_ref (a partner app's key, unique per workspace). The database refuses what the api never
// writes; an upgrade from 0024 keeps every row, and the previous build's writes still work.

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, newBoardId, newId, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const u1 = newId('usr')
const w1 = newId('wsp')
const w2 = newId('wsp')

const sqlstate = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )

async function seed(q: Db) {
  await q.query("INSERT INTO users (id, name, color) VALUES ($1, 'Ann', '#1d4ed8')", [u1])
  await q.query("INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'A', $3), ($2, 'B', $3)", [
    w1,
    w2,
    u1,
  ])
}

const identity = (q: Db, provider: string, subject: string) =>
  q.query('INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3)', [provider, subject, u1])
const address = (q: Db, email: string, source: string) =>
  q.query('INSERT INTO user_emails (user_id, email, source, seen_at) VALUES ($1, $2, $3, now())', [
    u1,
    email,
    source,
  ])
/** The previous build's board INSERT (no external_ref), or one with a key. */
const board = (q: Db, workspaceId: string, ref?: string | null) =>
  ref === undefined
    ? q.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
        newBoardId(),
        workspaceId,
        u1,
      ])
    : q.query(
        "INSERT INTO boards (id, workspace_id, title, created_by, external_ref) VALUES ($1, $2, 'T', $3, $4)",
        [newBoardId(), workspaceId, u1, ref],
      )

describe('0025: open email sign-in', () => {
  it("accepts the 'email' provider and source, and still refuses anything else", async () => {
    db = await openTestDb()
    await seed(db)
    expect(await sqlstate(identity(db, 'email', 'dana@example.com'))).toBe('no error')
    expect(await sqlstate(address(db, 'dana@example.com', 'email'))).toBe('no error')
    expect(await sqlstate(identity(db, 'okta', 'x'))).toBe('23514')
    expect(await sqlstate(address(db, 'x@example.com', 'okta'))).toBe('23514')
  })

  it('keys a board per workspace: unique within one, free across workspaces, lowercase pattern only', async () => {
    db = await openTestDb()
    await seed(db)
    expect(await sqlstate(board(db, w1, 'theaitre:production:42'))).toBe('no error')
    expect(await sqlstate(board(db, w1, 'theaitre:production:42'))).toBe('23505')
    expect(await sqlstate(board(db, w2, 'theaitre:production:42'))).toBe('no error')
    expect(await sqlstate(board(db, w1, null))).toBe('no error')
    expect(await sqlstate(board(db, w1, null))).toBe('no error')
    for (const bad of ['Theaitre:1', ':x', '', 'a b', 'x'.repeat(121)])
      expect(await sqlstate(board(db, w1, bad)), bad).toBe('23514')
  })
})

describe('0025 on a database at 0024', () => {
  it("keeps every row, and the previous build's inserts still work", async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 24) })
    await seed(d)
    await identity(d, 'dev', 'ann')
    await board(d, w1)
    expect(await sqlstate(identity(d, 'email', 'ann@example.com'))).toBe('23514')

    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 25) })).applied).toEqual([
      '0025_open_signin',
    ])
    expect((await d.query('SELECT provider FROM identities')).rows).toEqual([{ provider: 'dev' }])
    expect((await d.query('SELECT external_ref FROM boards')).rows).toEqual([{ external_ref: null }])
    const notValid = await d.query(
      "SELECT conname FROM pg_constraint WHERE NOT convalidated AND contype = 'c'",
    )
    expect(notValid.rows).toEqual([])
    expect(await sqlstate(board(d, w1))).toBe('no error')
    expect(await sqlstate(identity(d, 'email', 'ann@example.com'))).toBe('no error')
  })
})
