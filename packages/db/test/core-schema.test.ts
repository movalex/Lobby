// 0001_core constraints: the database itself refuses invalid enum values and cross-workspace links,
// so a bug in one API route cannot write a board into another tenant's project.

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, newBoardId, newId, pgErrorCode } from '../src/index.ts'
import { openTestDb } from '../src/testing.ts'

let db: Db
const u1 = newId('usr')
const w1 = newId('wsp')
const w2 = newId('wsp')

async function sqlstate(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'no error',
    (e: unknown) => pgErrorCode(e),
  )
}

beforeEach(async () => {
  db = await openTestDb()
  await db.query("INSERT INTO users (id, name, color) VALUES ($1, 'Ann', '#1d4ed8')", [u1])
  await db.query("INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'A', $3), ($2, 'B', $3)", [
    w1,
    w2,
    u1,
  ])
})
afterEach(() => db.close())

describe('0001_core', () => {
  it('boards default to private + active and reject unknown visibility/status', async () => {
    const id = newBoardId()
    await db.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
      id,
      w1,
      u1,
    ])
    expect(await db.one('SELECT visibility, status FROM boards WHERE id = $1', [id])).toEqual({
      visibility: 'private',
      status: 'active',
    })
    expect(await sqlstate(db.query("UPDATE boards SET visibility = 'public' WHERE id = $1", [id]))).toBe(
      '23514',
    )
    expect(await sqlstate(db.query("UPDATE boards SET status = 'deleted' WHERE id = $1", [id]))).toBe('23514')
    // trashed <=> trashed_at is set
    expect(await sqlstate(db.query("UPDATE boards SET status = 'trashed' WHERE id = $1", [id]))).toBe('23514')
    await db.query("UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1", [id])
  })

  it('rejects role values outside the permission model', async () => {
    expect(
      await sqlstate(
        db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'root')", [
          w1,
          u1,
        ]),
      ),
    ).toBe('23514')
    const b = newBoardId()
    await db.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
      b,
      w1,
      u1,
    ])
    expect(
      await sqlstate(
        db.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'admin')", [b, u1]),
      ),
    ).toBe('23514')
  })

  it("refuses a board in workspace B pointing at workspace A's project", async () => {
    const p = newId('prj')
    await db.query("INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, 'P')", [p, w1])
    const insert = (ws: string) =>
      db.query(
        "INSERT INTO boards (id, workspace_id, project_id, title, created_by) VALUES ($1, $2, $3, 'T', $4)",
        [newBoardId(), ws, p, u1],
      )
    expect(await sqlstate(insert(w2))).toBe('23503')
    expect(await sqlstate(insert(w1))).toBe('no error')
  })

  it("refuses an invitation in workspace B for workspace A's board, and owner board invitations", async () => {
    const b = newBoardId()
    await db.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
      b,
      w1,
      u1,
    ])
    const invite = (ws: string, board: string | null, role: string) =>
      db.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')`,
        [newId('inv'), createHash('sha256').update(newId('inv')).digest('hex'), ws, board, role, u1],
      )
    expect(await sqlstate(invite(w2, b, 'viewer'))).toBe('23503')
    expect(await sqlstate(invite(w1, b, 'owner'))).toBe('23514')
    expect(await sqlstate(invite(w1, null, 'editor'))).toBe('23514')
    expect(await sqlstate(invite(w1, b, 'editor'))).toBe('no error')
  })

  it('keeps identities unique per provider subject and handles unique per user', async () => {
    await db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('dev', 'ann', $1)", [u1])
    expect(
      await sqlstate(
        db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('dev', 'ann', $1)", [u1]),
      ),
    ).toBe('23505')
    expect(
      await sqlstate(
        db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('okta', 'x', $1)", [u1]),
      ),
    ).toBe('23514')
  })

  it('stores only hashed session ids', async () => {
    expect(
      await sqlstate(
        db.query(
          "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('raw-cookie-value', $1, now() + interval '1 day')",
          [u1],
        ),
      ),
    ).toBe('23514')
  })
})

describe('0021_domain_access', () => {
  const addEmail = (email: string, opts: { primary?: boolean; source?: string; user?: string } = {}) =>
    db.query(
      `INSERT INTO user_emails (user_id, email, is_primary, source, seen_at) VALUES ($1, $2, $3, $4, now())`,
      [opts.user ?? u1, email, opts.primary ?? false, opts.source ?? 'clerk'],
    )

  it('stores only normalised addresses, never a Clerk test-mode one, and derives the domain after the last @', async () => {
    expect(await sqlstate(addEmail('ann@darkburn.com', { primary: true }))).toBe('no error')
    expect(await db.one('SELECT domain FROM user_emails WHERE user_id = $1', [u1])).toEqual({
      domain: 'darkburn.com',
    })
    expect(await sqlstate(addEmail('"a@darkburn.com"@evil.test'))).toBe('no error')
    expect(await db.one(`SELECT domain FROM user_emails WHERE email = '"a@darkburn.com"@evil.test'`)).toEqual(
      { domain: 'evil.test' },
    )
    for (const bad of [
      'Ann@darkburn.com', // not lowercased
      'ann@darKburn.com', // non-ASCII
      'ann @darkburn.com', // space
      'ann@', // no domain
      '@darkburn.com', // no local part
      'anyone+clerk_test@darkburn.com', // Clerk test mode
    ])
      expect(await sqlstate(addEmail(bad)), bad).toBe('23514')
    expect(await sqlstate(addEmail('ann@other.example', { source: 'okta' }))).toBe('23514')
  })

  it('allows one primary address per user and provider', async () => {
    await addEmail('ann@darkburn.com', { primary: true })
    expect(await sqlstate(addEmail('ann@other.example', { primary: true }))).toBe('23505')
    expect(await sqlstate(addEmail('ann@dev.invalid', { primary: true, source: 'dev' }))).toBe('no error')
    expect(await sqlstate(addEmail('ann@darkburn.com', { source: 'dev' }))).toBe('23505') // one row per address
  })

  it('marks at most one personal workspace per user', async () => {
    await db.query('UPDATE workspaces SET personal_of = $1 WHERE id = $2', [u1, w1])
    expect(await sqlstate(db.query('UPDATE workspaces SET personal_of = $1 WHERE id = $2', [u1, w2]))).toBe(
      '23505',
    )
  })

  it('locks only single-use invitations, to a normalised address', async () => {
    const b = newBoardId()
    await db.query("INSERT INTO boards (id, workspace_id, title, created_by) VALUES ($1, $2, 'T', $3)", [
      b,
      w1,
      u1,
    ])
    const invite = (email: string | null, multiUse: boolean) =>
      db.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at, multi_use, invited_email)
         VALUES ($1, $2, $3, $4, 'viewer', $5, now() + interval '7 days', $6, $7)`,
        [newId('inv'), createHash('sha256').update(newId('inv')).digest('hex'), w1, b, u1, multiUse, email],
      )
    expect(await sqlstate(invite('pat@client.example', false))).toBe('no error')
    expect(await sqlstate(invite(null, false))).toBe('no error') // an older build's row
    expect(await sqlstate(invite(null, true))).toBe('no error')
    expect(await sqlstate(invite('pat@client.example', true))).toBe('23514')
    for (const bad of ['Pat@client.example', 'pát@client.example', 'pat+clerk_test@client.example', 'pat@'])
      expect(await sqlstate(invite(bad, false)), bad).toBe('23514')
  })
})
