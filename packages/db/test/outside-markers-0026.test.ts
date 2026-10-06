// 0026_outside_markers (wave J, J1): the "Internal only" switches (workspaces.internal_only,
// projects.internal_only, default false) and the notification kind 'outsider_joined' (no thread), with
// its partial index. The database refuses what the api never writes; an upgrade from 0025 (main's 0025_open_signin) keeps every
// row, and the previous build's writes (which know neither the columns nor the kind) still work.

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, newBoardId, newId, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const u1 = newId('usr')
const u2 = newId('usr')
const w1 = newId('wsp')
const p1 = newId('prj')
const b1 = newBoardId()

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )
}

/** The previous build's INSERTs: no internal_only column anywhere. */
async function seedTenant(q: Db) {
  await q.query("INSERT INTO users (id, name, color) VALUES ($1, 'Ann', '#1d4ed8'), ($2, 'Bo', '#1d4ed8')", [
    u1,
    u2,
  ])
  await q.query("INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'A', $2)", [w1, u1])
  await q.query("INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'P')", [p1, w1])
  await q.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
    b1,
    w1,
    u1,
  ])
}

function insertNotification(q: Db, kind: string, threadId: string | null = null) {
  return q.query(
    `INSERT INTO notifications (workspace_id, user_id, kind, board_id, thread_id, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [w1, u1, kind, b1, threadId, u2],
  )
}

describe('0026: internal only', () => {
  it('defaults to false for new and old rows, and is never null', async () => {
    const d = await openTestDb()
    db = d
    await seedTenant(d)
    expect(await d.one('SELECT internal_only FROM workspaces WHERE id = $1', [w1])).toEqual({
      internal_only: false,
    })
    expect(await d.one('SELECT internal_only FROM projects WHERE id = $1', [p1])).toEqual({
      internal_only: false,
    })
    expect(await sqlstate(d.query('UPDATE workspaces SET internal_only = NULL WHERE id = $1', [w1]))).toBe(
      '23502',
    )
    expect(await sqlstate(d.query('UPDATE projects SET internal_only = true WHERE id = $1', [p1]))).toBe(
      'no error',
    )
  })
})

describe('0026: notification kind outsider_joined', () => {
  it('needs no thread; comment kinds still do; unknown kinds are refused; the index exists', async () => {
    const d = await openTestDb()
    db = d
    await seedTenant(d)
    for (const kind of ['outsider_joined', 'access_granted', 'access_request'])
      expect(await sqlstate(insertNotification(d, kind)), kind).toBe('no error')
    for (const kind of ['mention', 'reply', 'resolved', 'new_comment'])
      expect(await sqlstate(insertNotification(d, kind)), kind).toBe('23514')
    expect(await sqlstate(insertNotification(d, 'outsider_left'))).toBe('23514')
    const idx = await d.one<{ def: string }>(
      // this schema's (real Postgres runs every test in a schema of its own, side by side)
      "SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'notifications_outsider_joined_idx' AND schemaname = current_schema()",
    )
    expect(idx.def).toContain('(board_id, actor_id)')
    expect(idx.def).toContain("'outsider_joined'")
  })
})

describe('0026 on a database at 0025_open_signin', () => {
  it("keeps every row, and the previous build's inserts still work", async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    expect(all.find((m) => m.version === 26)?.name).toBe('0026_outside_markers')
    await migrate(d, { migrations: all.filter((m) => m.version <= 25) })
    await seedTenant(d)
    await insertNotification(d, 'access_granted')
    // Before 0026 the new kind is refused and there is no column (what the migration changes).
    expect(await sqlstate(insertNotification(d, 'outsider_joined'))).toBe('23514')
    expect(await sqlstate(d.query('SELECT internal_only FROM workspaces'))).toBe('42703')

    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 26) })).applied).toEqual([
      '0026_outside_markers',
    ])
    expect(await d.one('SELECT internal_only FROM workspaces WHERE id = $1', [w1])).toEqual({
      internal_only: false,
    })
    expect(await d.one('SELECT internal_only FROM projects WHERE id = $1', [p1])).toEqual({
      internal_only: false,
    })
    expect((await d.query('SELECT kind FROM notifications')).rows).toEqual([{ kind: 'access_granted' }])
    const notValid = await d.query(
      "SELECT conname FROM pg_constraint WHERE NOT convalidated AND contype = 'c'",
    )
    expect(notValid.rows).toEqual([])
    // The previous build's writes: INSERTs without the new columns, with its own kinds.
    const w2 = newId('wsp')
    expect(
      await sqlstate(d.query("INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'B', $2)", [w2, u1])),
    ).toBe('no error')
    expect(await d.one('SELECT internal_only FROM workspaces WHERE id = $1', [w2])).toEqual({
      internal_only: false,
    })
    expect(await sqlstate(insertNotification(d, 'access_request'))).toBe('no error')
    expect(await sqlstate(insertNotification(d, 'outsider_joined'))).toBe('no error')
  })
})

// Staging's database (2026-10-06): main's 0025_open_signin is applied (api at eb96ba46), wave J's two are
// not. The renumbered pair applies on top of it, in order, and keeps the open sign-in rows and checks.
describe("wave J on staging's database (at 0025_open_signin)", () => {
  it('applies 0026_outside_markers then 0027_feedback, and keeps the open sign-in rows and constraints', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    expect(all.filter((m) => m.version >= 25).map((m) => m.name)).toEqual([
      '0025_open_signin',
      '0026_outside_markers',
      '0027_feedback',
    ])
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 25) })).applied.at(-1)).toBe(
      '0025_open_signin',
    )
    await seedTenant(d)
    // What open email sign-in and a partner board write at 0025.
    await d.query(
      "INSERT INTO identities (provider, subject, user_id) VALUES ('email', 'ann@example.com', $1)",
      [u1],
    )
    await d.query(
      "INSERT INTO user_emails (user_id, email, source, seen_at) VALUES ($1, 'ann@example.com', 'email', now())",
      [u1],
    )
    await d.query("UPDATE boards SET external_ref = 'theaitre:production:42' WHERE id = $1", [b1])
    await insertNotification(d, 'access_granted')

    expect((await migrate(d)).applied).toEqual(['0026_outside_markers', '0027_feedback'])
    expect(await migrate(d)).toEqual({ applied: [], newer: [] })
    expect((await d.query('SELECT provider, subject FROM identities')).rows).toEqual([
      { provider: 'email', subject: 'ann@example.com' },
    ])
    expect((await d.query('SELECT source FROM user_emails')).rows).toEqual([{ source: 'email' }])
    expect(await d.one('SELECT external_ref FROM boards WHERE id = $1', [b1])).toEqual({
      external_ref: 'theaitre:production:42',
    })
    expect(await d.one('SELECT internal_only FROM workspaces WHERE id = $1', [w1])).toEqual({
      internal_only: false,
    })
    expect((await d.query('SELECT kind FROM notifications')).rows).toEqual([{ kind: 'access_granted' }])
    // 0025's checks are still the ones in force (0026 rewrote only the notification checks).
    expect(
      await sqlstate(
        d.query("INSERT INTO identities (provider, subject, user_id) VALUES ('okta', 'x', $1)", [u1]),
      ),
    ).toBe('23514')
    expect(await sqlstate(insertNotification(d, 'outsider_joined'))).toBe('no error')
    expect(
      await sqlstate(
        d.query(
          `INSERT INTO feedback (id, created_at, user_id, user_name, user_kind, context, text, status)
           VALUES ('fbk_aaaaaaaaaaaaaaaaaaaa', now(), $1, 'Ann', 'account', '{}'::jsonb, 'x', 'open')`,
          [u1],
        ),
      ),
    ).toBe('no error')
  })
})
