// 0024_vote_selection_access_granted (wave B, RETRO-10 and PRI-09b): the vote scope 'selection' with its
// capped list of object refs, and the notification kind 'access_granted' (no thread). The database refuses
// what the api never writes; an upgrade from 0023 keeps every row, and the previous build's writes (which
// know neither the column nor the values) still work.

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
const b1 = newBoardId()

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )
}

async function seedTenant(q: Db) {
  await q.query("INSERT INTO users (id, name, color) VALUES ($1, 'Ann', '#1d4ed8'), ($2, 'Bo', '#1d4ed8')", [
    u1,
    u2,
  ])
  await q.query("INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'A', $2)", [w1, u1])
  await q.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
    b1,
    w1,
    u1,
  ])
}

interface VoteCols {
  scope: string
  frame_id?: string | null
  /** Only from 0024: the previous build's INSERT has no such column. */
  selection?: unknown
}

/** One open vote session row. */
function insertVote(q: Db, extra: VoteCols) {
  const cols = [
    'id',
    'workspace_id',
    'board_id',
    'title',
    'votes_per_person',
    'scope',
    'frame_id',
    'created_by',
  ]
  const vals: unknown[] = [newId('vot'), w1, b1, 'Dot vote', 3, extra.scope, extra.frame_id ?? null, u1]
  if ('selection' in extra) {
    cols.push('selection')
    vals.push(extra.selection === null ? null : JSON.stringify(extra.selection))
  }
  const ph = cols.map((c, i) => (c === 'selection' ? `$${i + 1}::jsonb` : `$${i + 1}`))
  return q.query(`INSERT INTO vote_sessions (${cols.join(', ')}) VALUES (${ph.join(', ')})`, vals)
}

/** Ends the open vote, so the next one may start (one open vote per board). */
const closeAll = (q: Db) =>
  q.query("UPDATE vote_sessions SET status = 'closed', closed_at = now() WHERE status = 'open'")

function insertNotification(q: Db, kind: string) {
  return q.query(
    `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id) VALUES ($1, $2, $3, $4, $5)`,
    [w1, u2, kind, b1, u1],
  )
}

describe('0024: vote scope selection', () => {
  it('stores a selection vote with 1..200 refs; the list is set exactly for scope selection', async () => {
    const d = await openTestDb()
    db = d
    await seedTenant(d)
    expect(await sqlstate(insertVote(d, { scope: 'selection', selection: ['shape:a', 'shape:b-2_x'] }))).toBe(
      'no error',
    )
    expect(
      await d.one("SELECT scope, selection, frame_id FROM vote_sessions WHERE scope = 'selection'"),
    ).toEqual({ scope: 'selection', selection: ['shape:a', 'shape:b-2_x'], frame_id: null })
    await closeAll(d)
    const max = Array.from({ length: 200 }, (_, i) => `shape:n${i}`)
    expect(await sqlstate(insertVote(d, { scope: 'selection', selection: max }))).toBe('no error')
    await closeAll(d)
    const refused: [string, VoteCols][] = [
      ['no list', { scope: 'selection' }],
      ['a null list', { scope: 'selection', selection: null }],
      ['an empty list', { scope: 'selection', selection: [] }],
      ['201 refs', { scope: 'selection', selection: [...max, 'shape:extra'] }],
      ['a number', { scope: 'selection', selection: ['shape:a', 7] }],
      ['a page ref', { scope: 'selection', selection: ['page:p'] }],
      ['a dotted id', { scope: 'selection', selection: ['shape:a.b'] }],
      ['an object', { scope: 'selection', selection: { a: 'shape:a' } }],
      ['a scalar', { scope: 'selection', selection: 'shape:a' }],
      ['a list on a board vote', { scope: 'board', selection: ['shape:a'] }],
      ['a list on a frame vote', { scope: 'frame', frame_id: 'shape:f', selection: ['shape:a'] }],
      ['a frame on a selection vote', { scope: 'selection', frame_id: 'shape:f', selection: ['shape:a'] }],
      ['an unknown scope', { scope: 'everything' }],
    ]
    for (const [what, bad] of refused) expect(await sqlstate(insertVote(d, bad)), what).toBe('23514')
    // board and frame votes are unchanged
    expect(await sqlstate(insertVote(d, { scope: 'board' }))).toBe('no error')
    await closeAll(d)
    expect(await sqlstate(insertVote(d, { scope: 'frame', frame_id: 'shape:f' }))).toBe('no error')
  })
})

describe('0024: notification kind access_granted', () => {
  it('needs no thread, like access_request; comment kinds still do; unknown kinds are refused', async () => {
    const d = await openTestDb()
    db = d
    await seedTenant(d)
    expect(await sqlstate(insertNotification(d, 'access_granted'))).toBe('no error')
    expect(await sqlstate(insertNotification(d, 'access_request'))).toBe('no error')
    for (const kind of ['mention', 'reply', 'resolved', 'new_comment'])
      expect(await sqlstate(insertNotification(d, kind)), kind).toBe('23514')
    expect(await sqlstate(insertNotification(d, 'access_revoked'))).toBe('23514')
  })
})

describe('0024 on a database at 0023', () => {
  it("keeps every row, and the previous build's inserts (no selection column, old values) still work", async () => {
    const d = await openPglite()
    db = d
    const all = loadMigrations()
    expect(all.find((m) => m.version === 24)?.name).toBe('0024_vote_selection_access_granted')
    await migrate(d, { migrations: all.filter((m) => m.version <= 23) })
    await seedTenant(d)
    await insertVote(d, { scope: 'frame', frame_id: 'shape:f' })
    await insertNotification(d, 'access_request')
    // Before 0024 the new values are refused (what the migration changes).
    expect(await sqlstate(insertNotification(d, 'access_granted'))).toBe('23514')
    await closeAll(d)
    expect(await sqlstate(insertVote(d, { scope: 'selection' }))).toBe('23514')

    // up to 0024 only: later migrations (0025_outside_markers, 0026_feedback) are not what this test is about
    expect((await migrate(d, { migrations: all.filter((m) => m.version <= 24) })).applied).toEqual([
      '0024_vote_selection_access_granted',
    ])
    expect(
      await d.one('SELECT scope, frame_id, selection FROM vote_sessions WHERE board_id = $1', [b1]),
    ).toEqual({ scope: 'frame', frame_id: 'shape:f', selection: null })
    expect((await d.query('SELECT kind FROM notifications')).rows).toEqual([{ kind: 'access_request' }])
    const notValid = await d.query(
      "SELECT conname FROM pg_constraint WHERE NOT convalidated AND contype = 'c'",
    )
    expect(notValid.rows).toEqual([])
    // The previous build's writes: an INSERT without the new column, with its own values.
    expect(await sqlstate(insertVote(d, { scope: 'board' }))).toBe('no error')
    expect(await sqlstate(insertNotification(d, 'access_request'))).toBe('no error')
    // And the new values now pass.
    await closeAll(d)
    expect(await sqlstate(insertVote(d, { scope: 'selection', selection: ['shape:a'] }))).toBe('no error')
    expect(await sqlstate(insertNotification(d, 'access_granted'))).toBe('no error')
  })
})
