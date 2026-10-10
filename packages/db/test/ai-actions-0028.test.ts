// 0028_ai_actions (wave L, L1-1; owner W1): the ai_usage action CHECK becomes a pattern. An upgrade from
// 0027 keeps every ledger row and changes nothing but that constraint; the four old actions and every wave L
// action are accepted, a name the pattern refuses is refused (Bad Name, 33 characters). Runs on PGlite, and
// on a real Postgres with DRAFTROOM_TEST_DATABASE_URL set (src/testing.ts openTestDb).

import { afterEach, describe, expect, it } from 'vitest'
import { AI_ACTIONS, AI_LEDGER_ACTION_PATTERN } from '../../contracts/src/ai.ts'
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

function insertUsage(q: Db, action: string) {
  return q.query(
    `INSERT INTO ai_usage (workspace_id, board_id, user_id, action, day, status, reserved_tokens, charged_tokens, created_at)
     VALUES ('wsp_gone00000000', 'b-gone000000', 'usr_gone00000000', $1, current_date, 'reserved', 10, 10, now())`,
    [action],
  )
}

const checkDef = async (q: Db) =>
  (
    await q.one<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'ai_usage'::regclass AND conname = 'ai_usage_action_check'`,
    )
  ).def

describe('0028_ai_actions', () => {
  it('is the migration after 0027_feedback (contiguous: the runner never applies an older number later)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 28)?.name).toBe('0028_ai_actions')
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrades a 0027 database: the old rows stay, only the action CHECK changes', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 27) })
    for (const a of ['summarize', 'themes', 'actions', 'ideas']) await insertUsage(d, a)
    expect(await sqlstate(insertUsage(d, 'recap'))).toBe('23514') // 0016's IN list
    const columns = async () =>
      (
        await d.query<{ k: string }>(
          `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS k
             FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`,
        )
      ).rows.map((r) => r.k)
    const constraints = async () =>
      (
        await d.query<{ k: string }>(
          `SELECT conrelid::regclass::text || '.' || conname AS k FROM pg_constraint
            WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
        )
      ).rows.map((r) => r.k)
    const before = { columns: await columns(), constraints: await constraints(), def: await checkDef(d) }
    expect(before.def).toContain('summarize')

    // up to 0028 only: the later migrations (0029, 0030) add tables of their own
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 28) })).applied).toEqual([
      '0028_ai_actions',
    ])
    expect(await columns()).toEqual(before.columns)
    expect(await constraints()).toEqual(before.constraints)
    expect(await checkDef(d)).not.toEqual(before.def)
    expect(await checkDef(d)).toContain('[a-z][a-z_-]{0,31}')
    const rows = await d.query<{ action: string }>('SELECT action FROM ai_usage ORDER BY id')
    expect(rows.rows.map((r) => r.action)).toEqual(['summarize', 'themes', 'actions', 'ideas'])
  })

  it('accepts every action name the contracts know, and refuses what the pattern refuses', async () => {
    db = await openTestDb()
    const d = db
    for (const a of AI_ACTIONS) {
      expect(AI_LEDGER_ACTION_PATTERN.test(a), a).toBe(true)
      expect(await sqlstate(insertUsage(d, a)), a).toBe('no error')
    }
    expect(await sqlstate(insertUsage(d, 'some_later-action'))).toBe('no error')
    expect(await sqlstate(insertUsage(d, 'a'.repeat(32)))).toBe('no error')
    for (const bad of ['Bad Name', 'a'.repeat(33), '', 'Recap', '1recap', 'recap!', '-recap', 'récap'])
      expect(await sqlstate(insertUsage(d, bad)), JSON.stringify(bad)).toBe('23514')
  })
})
