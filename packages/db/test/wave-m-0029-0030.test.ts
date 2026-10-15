// 0029_usage_daily (owner W5) and 0030_workspace_templates (owner W8), landed by the wave M foundation: two new
// tables, nothing existing changed (an upgrade from 0028 keeps every column and constraint), the CHECKs and
// keys, the cascades of 0030, and every usage event the contracts list fits 0029's event CHECK. Runs on PGlite,
// and on a real Postgres with DRAFTROOM_TEST_DATABASE_URL set (src/testing.ts openTestDb).

import { afterEach, describe, expect, it } from 'vitest'
import { USAGE_EVENT_PATTERN, USAGE_EVENTS, USAGE_ROLE_CLASSES } from '../../contracts/src/usage.ts'
import { WS_TEMPLATE_CATEGORIES } from '../../contracts/src/ws-templates.ts'
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

describe('wave M migrations', () => {
  it('are 0029_usage_daily and 0030_workspace_templates, right after 0028 (contiguous)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 29)?.name).toBe('0029_usage_daily')
    expect(all.find((m) => m.version === 30)?.name).toBe('0030_workspace_templates')
    // wave N's 0031 and 0032 follow (wave-n-0031-0032.test.ts), then wave Q's 0033 (wave-q-0033.test.ts)
    expect(all.filter((m) => m.version > 30).map((m) => m.name)).toEqual([
      '0031_board_visits',
      '0032_board_links',
      '0033_library',
      '0034_library_place',
    ])
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrade a 0028 database additively: every existing column and constraint unchanged, two new tables', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 28) })
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 30) })).applied).toEqual([
      '0029_usage_daily',
      '0030_workspace_templates',
    ])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    const isNew = (k: string) => k.startsWith('usage_daily.') || k.startsWith('workspace_templates.')
    expect(after.columns.filter((k) => !isNew(k))).toEqual(before.columns)
    expect(after.constraints.filter((k) => !isNew(k))).toEqual(before.constraints)
    expect(await columnsOf(d, 'usage_daily')).toEqual([
      'usage_daily.count:integer:NO',
      'usage_daily.day:date:NO',
      'usage_daily.event:text:NO',
      'usage_daily.role_class:text:NO',
    ])
    expect(await columnsOf(d, 'workspace_templates')).toEqual([
      'workspace_templates.added_at:timestamp with time zone:NO',
      'workspace_templates.added_by:text:YES',
      'workspace_templates.board_id:text:NO',
      'workspace_templates.category:text:NO',
      'workspace_templates.name:text:NO',
      'workspace_templates.workspace_id:text:NO',
    ])
  })
})

describe('0029_usage_daily', () => {
  const add = (q: Db, event: string, roleClass: string, count = 1, day = '2026-10-10') =>
    q.query(
      `INSERT INTO usage_daily (day, event, role_class, count) VALUES ($1::date, $2, $3, $4)
       ON CONFLICT (day, event, role_class) DO UPDATE SET count = usage_daily.count + EXCLUDED.count`,
      [day, event, roleClass, count],
    )

  it('accepts every usage event of the contracts for every role class, and adds up per day', async () => {
    db = await openTestDb()
    const d = db
    for (const e of USAGE_EVENTS) expect(USAGE_EVENT_PATTERN.test(e), e).toBe(true)
    for (const e of USAGE_EVENTS) expect(await sqlstate(add(d, e, 'member')), e).toBe('no error')
    for (const r of USAGE_ROLE_CLASSES)
      expect(await sqlstate(add(d, 'coach.shown', r, 3)), r).toBe('no error')
    await add(d, 'coach.shown', 'member', 4)
    await add(d, 'coach.shown', 'member', 2, '2026-10-11')
    const rows = await d.query<{ day: string; n: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, count AS n FROM usage_daily
        WHERE event = 'coach.shown' AND role_class = 'member' ORDER BY day`,
    )
    expect(rows.rows).toEqual([
      { day: '2026-10-10', n: 1 + 3 + 4 },
      { day: '2026-10-11', n: 2 },
    ])
  })

  it('refuses what the CHECKs refuse: a malformed event, another role class, a negative count', async () => {
    db = await openTestDb()
    const d = db
    for (const bad of ['', 'Coach.shown', '1x', 'board b-abc', 'x'.repeat(121), 'coach shown'])
      expect(await sqlstate(add(d, bad, 'member')), JSON.stringify(bad)).toBe('23514')
    for (const bad of ['owner', 'account', ''])
      expect(await sqlstate(add(d, 'coach.shown', bad)), bad).toBe('23514')
    expect(await sqlstate(add(d, 'coach.shown', 'member', -1))).toBe('23514')
    expect(
      await sqlstate(
        d.query(
          `INSERT INTO usage_daily (day, event, role_class, count) VALUES (NULL, 'coach.shown', 'member', 1)`,
        ),
      ),
    ).toBe('23502')
  })
})

describe('0030_workspace_templates', () => {
  const U = 'usr_alice00000001'
  const W = { a: 'wsp_studio0000001', b: 'wsp_other00000001' }
  async function seed(q: Db) {
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'Alice', 'alice', '#3355ff')`, [U])
    for (const w of [W.a, W.b])
      await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [w, U])
    for (const [id, w] of [
      ['b-retro0001', W.a],
      ['b-kick00001', W.a],
      ['b-other0001', W.b],
    ] as const)
      await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'Board', $3)`, [
        id,
        w,
        U,
      ])
  }
  const addTemplate = (q: Db, w: string, b: string, name = 'Our retro', category = 'review') =>
    q.query(
      `INSERT INTO workspace_templates (workspace_id, board_id, name, category, added_by, added_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [w, b, name, category, U],
    )
  const count = async (q: Db) =>
    (await q.one<{ n: number }>('SELECT count(*)::int AS n FROM workspace_templates')).n

  it('one row per workspace and board, of a board of that workspace only', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    expect(await sqlstate(addTemplate(d, W.a, 'b-retro0001'))).toBe('no error')
    expect(await sqlstate(addTemplate(d, W.a, 'b-retro0001'))).toBe('23505')
    // another workspace's board, and a board that does not exist
    expect(await sqlstate(addTemplate(d, W.a, 'b-other0001'))).toBe('23503')
    expect(await sqlstate(addTemplate(d, W.a, 'b-nothing01'))).toBe('23503')
    // every category of the contracts (each tried on its own, then removed)
    for (const c of WS_TEMPLATE_CATEGORIES) {
      expect(await sqlstate(addTemplate(d, W.a, 'b-kick00001', `Kickoff ${c}`, c)), c).toBe('no error')
      await d.query(`DELETE FROM workspace_templates WHERE board_id = 'b-kick00001'`)
    }
    expect(await count(d)).toBe(1)
  })

  it('refuses what the CHECKs refuse: an empty or long name, a category outside the list', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    for (const [name, category] of [
      ['', 'review'],
      ['x'.repeat(81), 'review'],
      ['Retro', 'sample'],
      ['Retro', ''],
    ] as const)
      expect(await sqlstate(addTemplate(d, W.a, 'b-retro0001', name, category)), `${name} ${category}`).toBe(
        '23514',
      )
    expect(await count(d)).toBe(0)
  })

  it('goes with its board and with its workspace; a deleted account leaves the template', async () => {
    db = await openTestDb()
    const d = db
    await seed(d)
    await addTemplate(d, W.a, 'b-retro0001')
    await addTemplate(d, W.a, 'b-kick00001', 'Kickoff', 'plan')
    await addTemplate(d, W.b, 'b-other0001', 'Theirs', 'ideate')
    await d.query(`DELETE FROM boards WHERE id = 'b-retro0001'`)
    expect(await count(d)).toBe(2)
    await d.query('DELETE FROM workspaces WHERE id = $1', [W.a])
    expect(await count(d)).toBe(1)
    // added_by: ON DELETE SET NULL (the boards' created_by still holds the user here, so only check the rule)
    const rule = await d.one<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'workspace_templates'::regclass AND contype = 'f' AND conkey = ARRAY[
          (SELECT attnum FROM pg_attribute WHERE attrelid = 'workspace_templates'::regclass AND attname = 'added_by')
        ]::int2[]`,
    )
    expect(rule.def).toContain('ON DELETE SET NULL')
  })
})
