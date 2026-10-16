// 0034_library_place (the wave Q review fixes): a new table of the links /place created and the client has not yet
// confirmed, and library_items.source_export_limited. An upgrade from 0033 changes nothing else; a pending row names a
// real board_asset_links row and goes with it. Runs on PGlite, and on a real Postgres with DRAFTROOM_TEST_DATABASE_URL
// set (src/testing.ts openTestDb).

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const columnsOf = async (q: Db, table?: string) =>
  (
    await q.query<{ k: string }>(
      `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS k
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND ($1::text IS NULL OR table_name = $1)
        ORDER BY 1`,
      [table ?? null],
    )
  ).rows.map((r) => r.k)

const constraintsOf = async (q: Db) =>
  (
    await q.query<{ k: string }>(
      `SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS k
         FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY 1`,
    )
  ).rows.map((r) => r.k)

const sqlstate = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )

const U = 'usr_alice00000001'
const W = 'wsp_studio0000001'
const B = 'b-alpha00001'
const AST = 'ast_asst000000001'
const VER = 'ver_vers000000001'

describe('the review fixes’ migration', () => {
  it('is 0034_library_place, right after 0033 (contiguous)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 34)?.name).toBe('0034_library_place')
    // wave R's 0035 and 0036 follow (wave-r-0035-0036.test.ts)
    expect(all.filter((m) => m.version > 34).map((m) => m.name)).toEqual([
      '0035_board_imports',
      '0036_chat_hooks',
    ])
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrades a 0033 database additively: one new table, one new column with a default, nothing else changed', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 33) })
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 34) })).applied).toEqual([
      '0034_library_place',
    ])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    // (a NOT NULL column is a pg_constraint row too on Postgres 18)
    const isNew = (k: string) =>
      k.startsWith('library_place_pending.') ||
      (k.startsWith('library_items.') && k.includes('source_export_limited'))
    expect(after.columns.filter((k) => !isNew(k))).toEqual(before.columns)
    expect(after.constraints.filter((k) => !isNew(k))).toEqual(before.constraints)
    expect(await columnsOf(d, 'library_place_pending')).toEqual([
      'library_place_pending.asset_id:text:NO',
      'library_place_pending.board_id:text:NO',
      'library_place_pending.created_at:timestamp with time zone:NO',
      'library_place_pending.version_id:text:NO',
    ])
    expect(await columnsOf(d, 'library_items')).toContain('library_items.source_export_limited:boolean:NO')
  })

  it('a pending row names a real link and goes with it', async () => {
    db = await openTestDb()
    const q = db
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'alice', 'alice', '#3355ff')`, [U])
    await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [W, U])
    await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'Board', $3)`, [
      B,
      W,
      U,
    ])
    const pending = (ver = VER) =>
      q.query('INSERT INTO library_place_pending (board_id, asset_id, version_id) VALUES ($1, $2, $3)', [
        B,
        AST,
        ver,
      ])
    // no link: refused
    expect(await sqlstate(pending())).toBe('23503')
    await q.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [W, B, AST, VER],
    )
    expect(await sqlstate(pending())).toBe('no error')
    expect(await sqlstate(pending())).toBe('23505')
    await q.query('DELETE FROM board_asset_links WHERE board_id = $1', [B])
    expect((await q.one<{ n: number }>('SELECT count(*)::int AS n FROM library_place_pending')).n).toBe(0)
  })
})
