// 0026_feedback (wave J5): the table behind the "Send feedback" button. The database refuses what the api
// never writes (a bad id, a kind or status it does not know, an empty or over-long text, a context that is
// not a small JSON object); the table has no foreign keys, so a message outlives its sender; and an upgrade
// from 0025 changes no existing table.

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )
}

const CONTEXT = JSON.stringify({ path: '/b/b-abc1234567', boardId: null })

interface Cols {
  id?: string
  user_kind?: string
  context?: string
  text?: string
  expected?: string | null
  status?: string
  user_name?: string
}

function insert(q: Db, c: Cols = {}) {
  return q.query(
    `INSERT INTO feedback (id, created_at, user_id, user_name, user_kind, context, text, expected, status)
     VALUES ($1, now(), 'usr_gone00000000', $2, $3, $4::jsonb, $5, $6, $7)`,
    [
      c.id ?? 'fbk_aaaaaaaaaaaaaaaaaaaa',
      c.user_name ?? 'Sam (guest)',
      c.user_kind ?? 'guest',
      c.context ?? CONTEXT,
      c.text ?? 'It broke',
      c.expected === undefined ? null : c.expected,
      c.status ?? 'open',
    ],
  )
}

describe('0026_feedback', () => {
  it('is a migration of its own, after 0025, and creates only the feedback table', async () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 26)?.name).toBe('0026_feedback')
    const d = await openPglite()
    db = d
    await migrate(d, { migrations: all.filter((m) => m.version <= 25) })
    const tables = async () =>
      (
        await d.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
        )
      ).rows.map((r) => r.table_name)
    const columns = async () =>
      (
        await d.query<{ k: string }>(
          `SELECT table_name || '.' || column_name || ':' || data_type AS k FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name <> 'feedback' ORDER BY 1`,
        )
      ).rows.map((r) => r.k)
    const before = { tables: await tables(), columns: await columns() }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 26) })).applied).toEqual([
      '0026_feedback',
    ])
    expect((await tables()).filter((t) => !before.tables.includes(t))).toEqual(['feedback'])
    expect(await columns()).toEqual(before.columns) // no existing table changed
  })

  it('takes what the api writes, with and without an expectation', async () => {
    db = await openTestDb()
    expect(await sqlstate(insert(db))).toBe('no error')
    expect(
      await sqlstate(
        insert(db, {
          id: 'fbk_bbbbbbbbbbbbbbbbbbbb',
          user_kind: 'account',
          expected: 'It works',
          status: 'done',
        }),
      ),
    ).toBe('no error')
    const row = await db.one<{ status: string; status_at: Date | null; status_by: string | null }>(
      "SELECT status, status_at, status_by FROM feedback WHERE id = 'fbk_aaaaaaaaaaaaaaaaaaaa'",
    )
    expect(row).toEqual({ status: 'open', status_at: null, status_by: null })
  })

  it('refuses what the api never writes', async () => {
    db = await openTestDb()
    const d = db
    const refused = async (c: Cols) =>
      sqlstate(insert(d, { id: `fbk_${Math.random().toString(36).slice(2, 14).padEnd(12, 'z')}`, ...c }))
    expect(await refused({ id: 'fbk_short' })).toBe('23514')
    expect(await refused({ id: 'abc_aaaaaaaaaaaaaaaaaaaa' })).toBe('23514')
    expect(await refused({ user_kind: 'admin' })).toBe('23514')
    expect(await refused({ status: 'closed' })).toBe('23514')
    expect(await refused({ text: '' })).toBe('23514')
    expect(await refused({ text: 'a'.repeat(4001) })).toBe('23514')
    expect(await refused({ expected: '' })).toBe('23514')
    expect(await refused({ expected: 'b'.repeat(4001) })).toBe('23514')
    expect(await refused({ user_name: '' })).toBe('23514')
    expect(await refused({ context: '[]' })).toBe('23514')
    expect(await refused({ context: '"text"' })).toBe('23514')
    expect(await refused({ context: JSON.stringify({ junk: 'x'.repeat(5000) }) })).toBe('23514')
    // the limits themselves are fine
    expect(await refused({ text: 'a'.repeat(4000), expected: 'b'.repeat(4000) })).toBe('no error')
    expect(await sqlstate(insert(d))).toBe('no error')
    expect(await sqlstate(insert(d))).toBe('23505') // the same id twice
  })

  it('has no foreign keys: a message outlives its sender (and a guest the sweep removed)', async () => {
    db = await openTestDb()
    await insert(db)
    const keys = await db.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid = 'feedback'::regclass AND contype = 'f'",
    )
    expect(keys.rows).toEqual([])
    expect((await db.query('SELECT id FROM users WHERE id = $1', ['usr_gone00000000'])).rows).toEqual([])
  })

  it('has the indexes the inbox pages by', async () => {
    db = await openTestDb()
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'feedback' ORDER BY 1",
    )
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      'feedback_created_idx',
      'feedback_pkey',
      'feedback_status_created_idx',
    ])
  })
})
