// 0031_board_visits (owner WS4) and 0032_board_links (owner WS7), landed by the wave N foundation: three new tables,
// nothing existing changed (an upgrade from 0030 keeps every column and constraint), their keys, CHECKs and
// cascades. Runs on PGlite, and on a real Postgres with DRAFTROOM_TEST_DATABASE_URL set (src/testing.ts openTestDb).
// Wave N left 0033 and 0034 unused; wave Q took 0033 (0033_library, wave-q-0033.test.ts). Migrations stay contiguous.

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

const U = { alice: 'usr_alice00000001', bob: 'usr_bobby00000001' }
const W = 'wsp_studio0000001'
const B = { a: 'b-alpha00001', b: 'b-bravo00001', c: 'b-charl00001' }

async function seed(q: Db) {
  for (const [id, name] of [
    [U.alice, 'alice'],
    [U.bob, 'bob'],
  ] as const)
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, $2, $2, '#3355ff')`, [id, name])
  await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [W, U.alice])
  for (const id of Object.values(B))
    await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'Board', $3)`, [
      id,
      W,
      U.alice,
    ])
}
const count = async (q: Db, table: string) =>
  (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n

describe('wave N migrations', () => {
  it('are 0031_board_visits and 0032_board_links, right after 0030 (contiguous; wave Q’s 0033 follows)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 31)?.name).toBe('0031_board_visits')
    expect(all.find((m) => m.version === 32)?.name).toBe('0032_board_links')
    expect(all.find((m) => m.version === 33)?.name).toBe('0033_library')
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrade a 0030 database additively: every existing column and constraint unchanged, three new tables', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 30) })
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 32) })).applied).toEqual([
      '0031_board_visits',
      '0032_board_links',
    ])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    const isNew = (k: string) =>
      k.startsWith('board_visits.') || k.startsWith('board_links.') || k.startsWith('board_link_scans.')
    expect(after.columns.filter((k) => !isNew(k))).toEqual(before.columns)
    expect(after.constraints.filter((k) => !isNew(k))).toEqual(before.constraints)
    expect(await columnsOf(d, 'board_visits')).toEqual([
      'board_visits.board_id:text:NO',
      'board_visits.seen_at:timestamp with time zone:NO',
      'board_visits.user_id:text:NO',
    ])
    expect(await columnsOf(d, 'board_links')).toEqual([
      'board_links.from_board:text:NO',
      'board_links.from_element:text:NO',
      'board_links.indexed_at:timestamp with time zone:NO',
      'board_links.to_board:text:NO',
      'board_links.to_element:text:YES',
    ])
    expect(await columnsOf(d, 'board_link_scans')).toEqual([
      'board_link_scans.board_id:text:NO',
      'board_link_scans.links_clock:bigint:NO',
      'board_link_scans.scanned_at:timestamp with time zone:NO',
    ])
  })
})

describe('0031_board_visits', () => {
  const visit = (q: Db, b: string, u: string) =>
    q.one<{ previous: Date | null; seen: Date }>(
      `WITH old AS (SELECT seen_at FROM board_visits WHERE board_id = $1 AND user_id = $2)
       INSERT INTO board_visits (board_id, user_id, seen_at) VALUES ($1, $2, now())
       ON CONFLICT (board_id, user_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
       RETURNING (SELECT seen_at FROM old) AS previous, seen_at AS seen`,
      [b, u],
    )

  it('one row per (board, person): the UPSERT answers the previous time, null on a first visit', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    const first = await visit(d, B.a, U.alice)
    expect(first.previous).toBeNull()
    const second = await visit(d, B.a, U.alice)
    expect(second.previous?.getTime()).toBe(first.seen.getTime())
    await visit(d, B.a, U.bob)
    await visit(d, B.b, U.alice)
    expect(await count(d, 'board_visits')).toBe(3)
    expect(
      await sqlstate(d.query(`INSERT INTO board_visits (board_id, user_id) VALUES ($1, $2)`, [B.a, U.alice])),
    ).toBe('23505')
    // a board or a person that does not exist
    expect(
      await sqlstate(
        d.query(`INSERT INTO board_visits (board_id, user_id) VALUES ('b-nothing01', $1)`, [U.alice]),
      ),
    ).toBe('23503')
    expect(
      await sqlstate(
        d.query(`INSERT INTO board_visits (board_id, user_id) VALUES ($1, 'usr_nobody0000001')`, [B.a]),
      ),
    ).toBe('23503')
  })

  it('goes with its board and with its person', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await visit(d, B.a, U.alice)
    await visit(d, B.a, U.bob)
    await visit(d, B.b, U.bob)
    await d.query('DELETE FROM boards WHERE id = $1', [B.a])
    expect(await count(d, 'board_visits')).toBe(1)
    const rules = await d.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'board_visits'::regclass AND contype = 'f' ORDER BY 1`,
    )
    expect(rules.rows.map((r) => r.def)).toEqual([
      'FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ])
  })
})

describe('0032_board_links', () => {
  const link = (q: Db, from: string, el: string, to: string, toEl: string | null = null) =>
    q.query(
      `INSERT INTO board_links (from_board, from_element, to_board, to_element, indexed_at)
       VALUES ($1, $2, $3, $4, now())`,
      [from, el, to, toEl],
    )

  it('one row per (from board, element, to board); "linked from" reads by to_board', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    expect(await sqlstate(link(d, B.a, 'card-1', B.b))).toBe('no error')
    expect(await sqlstate(link(d, B.a, 'card-1', B.b, 'frame-1'))).toBe('23505')
    expect(await sqlstate(link(d, B.a, 'card-1', B.c, 'frame-1'))).toBe('no error')
    expect(await sqlstate(link(d, B.c, 'r1', B.b))).toBe('no error')
    // a target that does not exist is never indexed
    expect(await sqlstate(link(d, B.a, 'card-2', 'b-nothing01'))).toBe('23503')
    for (const [el, toEl] of [
      ['', null],
      ['x'.repeat(121), null],
      ['card-3', ''],
      ['card-3', 'y'.repeat(121)],
    ] as const)
      expect(await sqlstate(link(d, B.a, el, B.b, toEl)), `${el.length} ${toEl?.length}`).toBe('23514')
    const into = await d.query<{ from_board: string }>(
      'SELECT from_board FROM board_links WHERE to_board = $1 ORDER BY from_board',
      [B.b],
    )
    expect(into.rows.map((r) => r.from_board)).toEqual([B.a, B.c])
    const idx = await d.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'board_links' AND indexname = 'board_links_to_idx'`,
    )
    expect(idx.rows[0]?.def).toContain('(to_board, from_board)')
  })

  it('goes with either board, and a board’s scan mark goes with it', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await link(d, B.a, 'card-1', B.b)
    await link(d, B.b, 'card-1', B.c)
    await link(d, B.c, 'card-1', B.a)
    for (const b of Object.values(B))
      await d.query('INSERT INTO board_link_scans (board_id, links_clock) VALUES ($1, 7)', [b])
    expect(
      await sqlstate(
        d.query(`INSERT INTO board_link_scans (board_id, links_clock) VALUES ($1, -1)`, ['b-x']),
      ),
    ).not.toBe('no error')
    await d.query('DELETE FROM boards WHERE id = $1', [B.b])
    // a→b (to) and b→c (from) go; c→a stays
    expect(await count(d, 'board_links')).toBe(1)
    expect(await count(d, 'board_link_scans')).toBe(2)
  })
})
