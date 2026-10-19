// 0038_live_sessions (the wave V foundation; docs/WAVE-V-CONTRACTS.md §8): live activities and their answers, breakout
// sessions and their members, and a workshop link's join code. An upgrade from 0037 adds four tables and two columns
// and changes nothing existing; keys, CHECKs, the one-open / one-running indexes and the cascades hold. Runs on PGlite,
// and on a real Postgres with DRAFTROOM_TEST_DATABASE_URL set.

import { afterEach, describe, expect, it } from 'vitest'
import { type Db, loadMigrations, migrate, openPglite, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const columnsOf = async (q: Db) =>
  (
    await q.query<{ k: string }>(
      `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS k
         FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY 1`,
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

const count = async (q: Db, table: string) =>
  (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n

const U = 'usr_alice00000001'
const G = 'usr_guest00000001'
const W = 'wsp_studio0000001'
const W2 = 'wsp_other00000001'
const B = 'b-alpha00001'
const B2 = 'b-beta000001'
const BX = 'b-other00001'
const ACT = 'act_activity00001'
const ACT2 = 'act_activity00002'
const BRK = 'brk_session000001'
const BRK2 = 'brk_session000002'

async function seed(q: Db) {
  await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'alice', 'alice', '#3355ff')`, [U])
  await q.query(
    `INSERT INTO users (id, name, handle, color, kind, guest_name) VALUES ($1, 'Ana (guest)', NULL, '#3355ff', 'guest', 'Ana')`,
    [G],
  )
  for (const w of [W, W2]) await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [w, U])
  for (const [b, w] of [
    [B, W],
    [B2, W],
    [BX, W2],
  ])
    await q.query(`INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'B', $3)`, [b, w, U])
}

interface ActivityRow {
  id: string
  board_id: string
  workspace_id: string
  kind: string
  prompt: string
  config: unknown
  status: string
  hidden: string[]
  results: unknown
  closed_at: string | null
  revealed_at: string | null
  placed_at: string | null
  ends_at: string | null
}
const activity = (q: Db, over: Partial<ActivityRow> = {}) => {
  const r: ActivityRow = {
    id: ACT,
    board_id: B,
    workspace_id: W,
    kind: 'poll',
    prompt: 'Which one?',
    config: { options: ['A', 'B'], maxChoices: 1 },
    status: 'open',
    hidden: [],
    results: null,
    closed_at: null,
    revealed_at: null,
    placed_at: null,
    ends_at: null,
    ...over,
  }
  return q.query(
    `INSERT INTO live_activities (id, workspace_id, board_id, kind, prompt, config, status, hidden, results, created_by,
                                  closed_at, revealed_at, placed_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
    [
      r.id,
      r.workspace_id,
      r.board_id,
      r.kind,
      r.prompt,
      JSON.stringify(r.config),
      r.status,
      r.hidden,
      r.results === null ? null : JSON.stringify(r.results),
      U,
      r.closed_at,
      r.revealed_at,
      r.placed_at,
      r.ends_at,
    ],
  )
}
const answer = (q: Db, user: string, value: unknown = { kind: 'poll', choices: [0] }, act = ACT, ws = W) =>
  q.query(
    `INSERT INTO live_answers (workspace_id, activity_id, user_id, answer) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (activity_id, user_id) DO UPDATE SET answer = EXCLUDED.answer, updated_at = now()`,
    [ws, act, user, JSON.stringify(value)],
  )
const GROUPS = [
  { id: 'g1', name: 'Group 1', frameId: 'shape:f1' },
  { id: 'g2', name: 'Group 2', frameId: 'shape:f2' },
]
const session = (q: Db, over: Record<string, unknown> = {}) => {
  const r = {
    id: BRK,
    board_id: B,
    mode: 'auto',
    groups: GROUPS as unknown,
    group_cap: null,
    status: 'running',
    ended_at: null,
    ...over,
  }
  return q.query(
    `INSERT INTO breakout_sessions (id, workspace_id, board_id, mode, groups, group_cap, status, created_by, ended_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [r.id, W, r.board_id, r.mode, JSON.stringify(r.groups), r.group_cap, r.status, U, r.ended_at],
  )
}
const member = (q: Db, user: string, group = 'g1', by = 'auto', sid = BRK) =>
  q.query(
    `INSERT INTO breakout_members (workspace_id, session_id, user_id, group_id, assigned_by) VALUES ($1, $2, $3, $4, $5)`,
    [W, sid, user, group, by],
  )

const NEW_TABLES = ['live_activities', 'live_answers', 'breakout_sessions', 'breakout_members']
const NEW_COLUMNS = ['invitations.join_code_hash:text:YES', 'invitations.join_code_n:smallint:NO']

describe('wave V migration', () => {
  it('is 0038_live_sessions, right after 0037 (contiguous, the last)', () => {
    const all = loadMigrations()
    expect(all.find((m) => m.version === 38)?.name).toBe('0038_live_sessions')
    expect(all.at(-1)?.version).toBe(38)
    expect(all.map((m) => m.version)).toEqual(all.map((_, i) => i + 1))
  })

  it('upgrades a 0037 database additively: four new tables, two new columns, no constraint changed', async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    await migrate(d, { migrations: all.filter((m) => m.version <= 37) })
    await seed(d)
    await d.query(
      `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at, multi_use, allow_guests)
       VALUES ('inv_link00000001', repeat('b', 64), $1, $2, 'editor', $3, now() + interval '3 hours', true, true)`,
      [W, B, U],
    )
    const before = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    expect((await migrate(d)).applied).toEqual(['0038_live_sessions'])
    const after = { columns: await columnsOf(d), constraints: await constraintsOf(d) }
    const isNew = (k: string) => NEW_TABLES.some((t) => k.startsWith(`${t}.`))
    expect(after.columns.filter((k) => !isNew(k) && !NEW_COLUMNS.includes(k))).toEqual(before.columns)
    for (const c of NEW_COLUMNS) expect(after.columns, c).toContain(c)
    // every constraint that was there is still there, unchanged
    expect(before.constraints.filter((k) => !after.constraints.includes(k))).toEqual([])
    // the new ones: the four tables' and the join code's on invitations
    const added = after.constraints.filter((k) => !before.constraints.includes(k))
    expect(added.filter((k) => !isNew(k) && !k.startsWith('invitations.')).sort()).toEqual([])
    expect(added.filter((k) => k.startsWith('invitations.')).map((k) => k.split(':')[0]).sort()).toEqual([
      'invitations.invitations_join_code_hash_check',
      'invitations.invitations_join_code_n_check',
      // Postgres 18 lists NOT NULL as a constraint too
      'invitations.invitations_join_code_n_not_null',
      'invitations.invitations_join_code_scope_check',
    ])
    // the existing link is untouched: no code, n 0
    expect(await d.one('SELECT join_code_hash, join_code_n FROM invitations')).toEqual({
      join_code_hash: null,
      join_code_n: 0,
    })
    for (const t of NEW_TABLES) expect(await count(d, t), t).toBe(0)
  })
})

describe('0038: live activities', () => {
  it('ids, kinds, prompts and configs are checked', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(await sqlstate(activity(q, { id: 'act_bad' }))).toBe('23514')
    expect(await sqlstate(activity(q, { kind: 'quiz' }))).toBe('23514')
    expect(await sqlstate(activity(q, { prompt: '' }))).toBe('23514')
    expect(await sqlstate(activity(q, { prompt: '漢'.repeat(201) }))).toBe('23514')
    expect(await sqlstate(activity(q, { config: ['A', 'B'] }))).toBe('23514')
    expect(await sqlstate(activity(q, { config: { options: ['x'.repeat(5000)] } }))).toBe('23514')
    expect(await sqlstate(activity(q, { prompt: '漢'.repeat(200) }))).toBe('no error')
    // a board of another workspace is refused by the composite key
    expect(await sqlstate(activity(q, { id: ACT2, board_id: BX }))).toBe('23503')
  })

  it('the status decides closed_at, revealed_at and results; placed only once revealed; hidden words only on a cloud', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const t = '2099-01-01T00:00:00Z'
    const res = { kind: 'poll', answered: 0, counts: [0, 0] }
    let n = 0
    const id = () => `act_status${String(++n).padStart(7, '0')}`
    for (const [over, want] of [
      [{ status: 'open', closed_at: t }, '23514'],
      [{ status: 'closed' }, '23514'],
      [{ status: 'closed', closed_at: t, results: res }, '23514'],
      [{ status: 'revealed', closed_at: t, results: res }, '23514'],
      [{ status: 'revealed', closed_at: t, revealed_at: t }, '23514'],
      [{ status: 'closed', closed_at: t, placed_at: t }, '23514'],
      [{ status: 'cancelled', closed_at: t, hidden: ['x'] }, '23514'],
      [{ status: 'closed', closed_at: t }, 'no error'],
      [{ status: 'cancelled', closed_at: t }, 'no error'],
      [{ status: 'revealed', closed_at: t, revealed_at: t, results: res, placed_at: t }, 'no error'],
      [{ status: 'closed', closed_at: t, kind: 'words', config: { maxWords: 3 }, hidden: ['agile'] }, 'no error'],
      [
        {
          status: 'closed',
          closed_at: t,
          kind: 'words',
          config: { maxWords: 3 },
          hidden: Array.from({ length: 201 }, (_, i) => `w${i}`),
        },
        '23514',
      ],
    ] as [Partial<ActivityRow>, string][])
      expect(await sqlstate(activity(q, { id: id(), ...over })), JSON.stringify(over)).toBe(want)
  })

  it('one open activity per board (closed ones and other boards do not count)', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(await sqlstate(activity(q))).toBe('no error')
    expect(await sqlstate(activity(q, { id: ACT2 }))).toBe('23505')
    expect(await sqlstate(activity(q, { id: ACT2, board_id: B2 }))).toBe('no error')
    expect(
      await sqlstate(activity(q, { id: 'act_closed0000001', status: 'closed', closed_at: '2099-01-01T00:00:00Z' })),
    ).toBe('no error')
    await q.query(`UPDATE live_activities SET status = 'closed', closed_at = now() WHERE id = $1`, [ACT])
    expect(await sqlstate(activity(q, { id: 'act_reopen0000001' }))).toBe('no error')
  })

  it('one answer per person (an upsert replaces it), bounded, inside its workspace; cascades with the activity, the board and the person', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await activity(q)
    expect(await sqlstate(answer(q, U))).toBe('no error')
    expect(await sqlstate(answer(q, U, { kind: 'poll', choices: [1] }))).toBe('no error')
    expect(await sqlstate(answer(q, G))).toBe('no error')
    expect(await count(q, 'live_answers')).toBe(2)
    expect(await q.one(`SELECT answer FROM live_answers WHERE user_id = $1`, [U])).toEqual({
      answer: { kind: 'poll', choices: [1] },
    })
    // a plain insert of a second answer is refused
    expect(
      await sqlstate(
        q.query(`INSERT INTO live_answers (workspace_id, activity_id, user_id, answer) VALUES ($1, $2, $3, '{}')`, [
          W,
          ACT,
          U,
        ]),
      ),
    ).toBe('23505')
    expect(await sqlstate(answer(q, U, { kind: 'words', words: ['x'.repeat(3000)] }))).toBe('23514')
    expect(await sqlstate(answer(q, U, [1, 2]))).toBe('23514')
    // inside its activity's workspace only (the composite key)
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ('usr_carol00000001', 'carol', 'carol', '#000000')`)
    expect(await sqlstate(answer(q, 'usr_carol00000001', { kind: 'poll', choices: [0] }, ACT, W2))).toBe('23503')
    // a guest who goes takes their answer along; deleting the activity (or its board) deletes the rest
    await q.query('DELETE FROM users WHERE id = $1', [G])
    expect(await count(q, 'live_answers')).toBe(1)
    await q.query('DELETE FROM boards WHERE id = $1', [B])
    expect(await count(q, 'live_activities')).toBe(0)
    expect(await count(q, 'live_answers')).toBe(0)
  })

  it('the starter leaving keeps the activity (created_by is set null)', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    await q.query(`INSERT INTO users (id, name, handle, color) VALUES ('usr_bob0000000001', 'bob', 'bob', '#000000')`)
    await q.query(
      `INSERT INTO live_activities (id, workspace_id, board_id, kind, prompt, config, created_by)
       VALUES ($1, $2, $3, 'words', 'One word', '{"maxWords":3}', 'usr_bob0000000001')`,
      [ACT, W, B],
    )
    await q.query(`DELETE FROM users WHERE id = 'usr_bob0000000001'`)
    expect(await q.one('SELECT created_by, anonymous, results_live FROM live_activities')).toEqual({
      created_by: null,
      anonymous: true,
      results_live: false,
    })
  })
})

describe('0038: breakouts', () => {
  it('2 to 20 groups, a cap only in choose mode, ended needs ended_at', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const g = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i + 1}`, name: 'G', frameId: `shape:f${i}` }))
    let n = 0
    const id = () => `brk_session${String(++n).padStart(6, '0')}`
    const ended = '2099-01-01T00:00:00Z'
    for (const [over, want] of [
      [{ groups: g(1), status: 'ended', ended_at: ended }, '23514'],
      [{ groups: g(21), status: 'ended', ended_at: ended }, '23514'],
      [{ groups: { g1: 1 }, status: 'ended', ended_at: ended }, '23514'],
      [{ mode: 'auto', group_cap: 5, status: 'ended', ended_at: ended }, '23514'],
      [{ mode: 'choose', group_cap: 201, status: 'ended', ended_at: ended }, '23514'],
      [{ mode: 'swap', status: 'ended', ended_at: ended }, '23514'],
      [{ status: 'ended' }, '23514'],
      [{ status: 'running', ended_at: ended }, '23514'],
      [{ groups: g(20), mode: 'choose', group_cap: 10, status: 'ended', ended_at: ended }, 'no error'],
      [{ id: 'brk_bad' }, '23514'],
    ] as [Record<string, unknown>, string][])
      expect(await sqlstate(session(q, { id: id(), ...over })), JSON.stringify(over).slice(0, 80)).toBe(want)
  })

  it('one running session per board; members once each, in g1..g20; cascades with the session, the board and the person', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    expect(await sqlstate(session(q))).toBe('no error')
    expect(await sqlstate(session(q, { id: BRK2 }))).toBe('23505')
    expect(await sqlstate(session(q, { id: BRK2, board_id: B2 }))).toBe('no error')
    expect(await sqlstate(member(q, U))).toBe('no error')
    expect(await sqlstate(member(q, U, 'g2'))).toBe('23505')
    expect(await sqlstate(member(q, G, 'g21'))).toBe('23514')
    expect(await sqlstate(member(q, G, 'g0'))).toBe('23514')
    expect(await sqlstate(member(q, G, 'g2', 'guess'))).toBe('23514')
    expect(await sqlstate(member(q, G, 'g2', 'self'))).toBe('no error')
    expect(await sqlstate(member(q, G, 'g1', 'auto', 'brk_missing000001'))).toBe('23503')
    await q.query('DELETE FROM users WHERE id = $1', [G])
    expect(await count(q, 'breakout_members')).toBe(1)
    // the session ends: a new one may start; its members stay with it (the summary reads them)
    await q.query(`UPDATE breakout_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [BRK])
    expect(await sqlstate(session(q, { id: 'brk_session000003' }))).toBe('no error')
    expect(await count(q, 'breakout_members')).toBe(1)
    await q.query('DELETE FROM boards WHERE id = $1', [B])
    expect(await count(q, 'breakout_members')).toBe(0)
    expect(await count(q, 'breakout_sessions')).toBe(1)
  })
})

describe('0038: join codes', () => {
  it('only on a board multi-use editor link; unique; n from 0 to 15', async () => {
    db = await openTestDb()
    const q = db
    await seed(q)
    const inv = (id: string, role: string, multi: boolean, hash: string | null, n = 0, board: string | null = B) =>
      q.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at, multi_use,
                                  invited_email, join_code_hash, join_code_n)
         VALUES ($1, md5($1) || md5($1), $2, $3, $4, $5, now() + interval '3 hours', $6, $7, $8, $9)`,
        [id, W, board, role, U, multi, multi ? null : 'ana@darkburn.com', hash, n],
      )
    const h = (c: string) => c.repeat(64)
    expect(await sqlstate(inv('inv_work00000001', 'editor', true, h('a')))).toBe('no error')
    expect(await sqlstate(inv('inv_work00000002', 'editor', true, h('a')))).toBe('23505')
    expect(await sqlstate(inv('inv_work00000003', 'editor', true, h('b'), 15))).toBe('no error')
    expect(await sqlstate(inv('inv_work00000004', 'editor', true, h('c'), 16))).toBe('23514')
    expect(await sqlstate(inv('inv_work00000005', 'editor', true, 'ABC'))).toBe('23514')
    // a review link, a single-use invitation, a workspace invitation: no code
    expect(await sqlstate(inv('inv_rev000000001', 'commenter', true, h('d')))).toBe('23514')
    expect(await sqlstate(inv('inv_one000000001', 'editor', false, h('e')))).toBe('23514')
    expect(await sqlstate(inv('inv_wsp000000001', 'member', false, h('f'), 0, null))).toBe('23514')
    // links without a code are as before
    expect(await sqlstate(inv('inv_work00000006', 'editor', true, null))).toBe('no error')
    expect(await sqlstate(inv('inv_work00000007', 'editor', true, null))).toBe('no error')
  })
})
