import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checksumOf,
  loadMigrations,
  MIGRATIONS_DIR,
  migrate,
  openPglite,
  type PgliteDb,
} from '../src/index.ts'

let dir: string
let db: PgliteDb

const write = (name: string, sql: string) => writeFileSync(join(dir, name), sql)
const tableNames = async () =>
  (
    await db.query<{ t: string }>(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    )
  ).rows.map((r) => r.t)
const recorded = async () =>
  (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY version')).rows.map(
    (r) => r.name,
  )

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dr-migrations-'))
  db = await openPglite()
})
afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('migration runner', () => {
  it('applies pending migrations in numeric order, each recorded once', async () => {
    // Written out of order: execution order must come from the number, not directory order.
    write('0010_third.sql', "INSERT INTO log (step) VALUES ('third');")
    write('0001_first.sql', 'CREATE TABLE log (n serial PRIMARY KEY, step text NOT NULL);')
    write('0002_second.sql', "INSERT INTO log (step) VALUES ('second');")
    const r = await migrate(db, { dir })
    expect(r.applied).toEqual(['0001_first', '0002_second', '0010_third'])
    const steps = (await db.query<{ step: string }>('SELECT step FROM log ORDER BY n')).rows.map(
      (x) => x.step,
    )
    expect(steps).toEqual(['second', 'third'])
    expect(await recorded()).toEqual(['0001_first', '0002_second', '0010_third'])
  })

  it('is idempotent: a re-run applies nothing and re-executes nothing', async () => {
    write('0001_first.sql', 'CREATE TABLE log (n serial PRIMARY KEY, step text NOT NULL);')
    write('0002_second.sql', "INSERT INTO log (step) VALUES ('once');")
    await migrate(db, { dir })
    const again = await migrate(db, { dir })
    expect(again.applied).toEqual([])
    expect((await db.one<{ c: number }>('SELECT count(*)::int AS c FROM log')).c).toBe(1)
  })

  it('applies only the new file when one is added later', async () => {
    write('0001_first.sql', 'CREATE TABLE a (x int);')
    await migrate(db, { dir })
    write('0002_second.sql', 'CREATE TABLE b (x int);')
    expect((await migrate(db, { dir })).applied).toEqual(['0002_second'])
    expect(await tableNames()).toEqual(['a', 'b', 'schema_migrations'])
  })

  it('refuses to run when an applied migration file was edited (checksum guard)', async () => {
    write('0001_first.sql', 'CREATE TABLE a (x int);')
    await migrate(db, { dir })
    write('0001_first.sql', 'CREATE TABLE a (x int, y int);')
    write('0002_second.sql', 'CREATE TABLE b (x int);')
    await expect(migrate(db, { dir })).rejects.toThrow(/0001_first changed after it was applied/)
    // Nothing after the mismatch ran.
    expect(await tableNames()).toEqual(['a', 'schema_migrations'])
  })

  it('refuses to run when the database has a migration this build does not know', async () => {
    write('0001_first.sql', 'CREATE TABLE a (x int);')
    write('0002_second.sql', 'CREATE TABLE b (x int);')
    await migrate(db, { dir })
    rmSync(join(dir, '0002_second.sql'))
    await expect(migrate(db, { dir })).rejects.toThrow(/0002_second, which this build does not know/)
  })

  describe('an older build on a newer database (a rollback, allowNewerSchema)', () => {
    // The newer build applied 0001-0003; the older build knows 0001-0002.
    async function newerDatabase() {
      write('0001_first.sql', 'CREATE TABLE a (x int);')
      write('0002_second.sql', 'CREATE TABLE b (x int);')
      write('0003_third.sql', 'CREATE TABLE c (x int);')
      await migrate(db, { dir })
      rmSync(join(dir, '0003_third.sql'))
    }

    it('refuses to start by default', async () => {
      await newerDatabase()
      await expect(migrate(db, { dir })).rejects.toThrow(/0003_third, which this build does not know/)
    })

    it('with the opt-in, starts: applies nothing, changes nothing and reports the newer migrations', async () => {
      await newerDatabase()
      expect(await migrate(db, { dir, allowNewerSchema: true })).toEqual({
        applied: [],
        newer: ['0003_third'],
      })
      expect(await recorded()).toEqual(['0001_first', '0002_second', '0003_third'])
      expect(await tableNames()).toEqual(['a', 'b', 'c', 'schema_migrations'])
      // Deploying the newer build again finds everything applied.
      write('0003_third.sql', 'CREATE TABLE c (x int);')
      expect(await migrate(db, { dir })).toEqual({ applied: [], newer: [] })
    })

    it('never tolerates an unknown OLDER migration (a gap below the newest file it knows)', async () => {
      await newerDatabase()
      write('0003_third.sql', 'CREATE TABLE c (x int);')
      rmSync(join(dir, '0002_second.sql'))
      await expect(migrate(db, { dir, allowNewerSchema: true })).rejects.toThrow(
        /0002_second, which this build does not know/,
      )
    })

    it('never tolerates anything when the build has no migration files (they were not shipped)', async () => {
      await newerDatabase()
      for (const f of ['0001_first.sql', '0002_second.sql']) rmSync(join(dir, f))
      await expect(migrate(db, { dir, allowNewerSchema: true })).rejects.toThrow(
        /this build has no migration files/,
      )
      await expect(migrate(db, { dir, migrations: [], allowNewerSchema: true })).rejects.toThrow(
        /this build has no migration files/,
      )
    })

    it('never tolerates a checksum mismatch', async () => {
      await newerDatabase()
      write('0002_second.sql', 'CREATE TABLE b (x int, y int);')
      await expect(migrate(db, { dir, allowNewerSchema: true })).rejects.toThrow(
        /0002_second changed after it was applied/,
      )
    })

    it('never applies a migration of this build that the newer database never got', async () => {
      await newerDatabase()
      // A hotfix build that added its own 0003: the database's 0003 is another migration.
      write('0003_hotfix.sql', 'CREATE TABLE h (x int);')
      await expect(migrate(db, { dir, allowNewerSchema: true })).rejects.toThrow(
        /0003_third changed after it was applied/,
      )
      rmSync(join(dir, '0003_hotfix.sql'))
      // The database is at 0001-0003 plus 0005; this build knows 0001-0004.
      write('0003_third.sql', 'CREATE TABLE c (x int);')
      write('0005_fifth.sql', 'CREATE TABLE e (x int);')
      await migrate(db, { dir })
      rmSync(join(dir, '0005_fifth.sql'))
      write('0004_fourth.sql', 'CREATE TABLE d (x int);')
      await expect(migrate(db, { dir, allowNewerSchema: true })).rejects.toThrow(
        /0004_fourth was never applied to this database, which already has newer migrations \(0005_fifth\)/,
      )
      expect(await tableNames()).toEqual(['a', 'b', 'c', 'e', 'schema_migrations'])
    })
  })

  it('refuses a new migration numbered below the latest applied one', async () => {
    write('0003_third.sql', 'CREATE TABLE c (x int);')
    await migrate(db, { dir })
    write('0002_second.sql', 'CREATE TABLE b (x int);')
    await expect(migrate(db, { dir })).rejects.toThrow(/0002_second is older than the applied 0003_third/)
    expect(await tableNames()).toEqual(['c', 'schema_migrations'])
  })

  it('rolls back a failing migration completely and keeps earlier ones', async () => {
    write('0001_first.sql', 'CREATE TABLE a (x int);')
    write('0002_broken.sql', 'CREATE TABLE b (x int);\nINSERT INTO nope VALUES (1);')
    await expect(migrate(db, { dir })).rejects.toThrow()
    expect(await tableNames()).toEqual(['a', 'schema_migrations'])
    expect(await recorded()).toEqual(['0001_first'])
  })

  it('treats CRLF and LF checkouts of the same file as unchanged', async () => {
    write('0001_first.sql', 'CREATE TABLE a (x int);\nCREATE TABLE b (x int);\n')
    await migrate(db, { dir })
    write('0001_first.sql', 'CREATE TABLE a (x int);\r\nCREATE TABLE b (x int);\r\n')
    expect((await migrate(db, { dir })).applied).toEqual([])
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'))
  })

  it('rejects misnamed and duplicate-numbered files instead of skipping them', () => {
    write('0001_first.sql', 'SELECT 1;')
    write('2_second.sql', 'SELECT 1;')
    expect(() => loadMigrations(dir)).toThrow(/must match NNNN_name.sql: 2_second.sql/)
    rmSync(join(dir, '2_second.sql'))
    write('0001_other.sql', 'SELECT 1;')
    expect(() => loadMigrations(dir)).toThrow(/duplicate migration number 0001/)
  })

  it('ignores non-SQL files such as READMEs', () => {
    write('0001_first.sql', 'SELECT 1;')
    mkdirSync(join(dir, 'notes'))
    write('README.md', '# notes')
    expect(loadMigrations(dir).map((m) => m.name)).toEqual(['0001_first'])
  })
})

describe('shipped migrations', () => {
  it('are named and numbered correctly, starting with 0001_core', () => {
    const shipped = loadMigrations(MIGRATIONS_DIR)
    expect(shipped[0]?.name).toBe('0001_core')
  })

  it('are the milestone-1 core, the four pre-allocated feature migrations, 0006_workshop_links, 0007_assets, 0008_session_revocation and 0009_guests, in order', () => {
    expect(loadMigrations(MIGRATIONS_DIR).map((m) => m.name)).toEqual([
      '0001_core',
      '0002_comments',
      '0003_history',
      '0004_workshops',
      '0005_dashboard',
      '0006_workshop_links',
      '0007_assets',
      '0008_session_revocation',
      '0009_guests',
      '0010_private_notes',
      '0011_board_thumbnails',
      '0012_board_export_policy',
      '0013_asset_gc',
      '0014_checkpoint_policy',
      '0015_board_search',
      '0016_ai_usage',
      '0017_comment_notifications',
      '0018_ai_settings',
      '0019_checkpoint_reasons',
      '0020_comment_visibility',
      '0021_domain_access',
    ])
  })

  it('apply to an empty database in order and are then up to date', async () => {
    const first = await migrate(db)
    expect(first.applied).toEqual([
      '0001_core',
      '0002_comments',
      '0003_history',
      '0004_workshops',
      '0005_dashboard',
      '0006_workshop_links',
      '0007_assets',
      '0008_session_revocation',
      '0009_guests',
      '0010_private_notes',
      '0011_board_thumbnails',
      '0012_board_export_policy',
      '0013_asset_gc',
      '0014_checkpoint_policy',
      '0015_board_search',
      '0016_ai_usage',
      '0017_comment_notifications',
      '0018_ai_settings',
      '0019_checkpoint_reasons',
      '0020_comment_visibility',
      '0021_domain_access',
    ])
    expect(await migrate(db)).toEqual({ applied: [], newer: [] })
    expect(await tableNames()).toEqual([
      'access_requests',
      'ai_notice_acceptances',
      'ai_usage',
      'asset_derivative_reservations',
      'asset_derivatives',
      'asset_gc_pending_deletes',
      'asset_gc_runs',
      'asset_gc_snapshot_refs',
      'asset_gc_snapshot_scans',
      'asset_versions',
      'audit_events',
      'board_ai_settings',
      'board_asset_links',
      'board_checkpoint_state',
      'board_export_policies',
      'board_members',
      'board_search_entries',
      'board_search_state',
      'board_snapshot_blob_deletions',
      'board_snapshots',
      'board_stars',
      'board_thumbnails',
      'boards',
      'comment_mentions',
      'comment_reads',
      'comment_threads',
      'comments',
      'identities',
      'invitation_redemptions',
      'invitations',
      'notifications',
      'preview_jobs',
      'private_brainstorms',
      'private_notes',
      'projects',
      'schema_migrations',
      'sessions',
      'user_emails',
      'users',
      'vote_done',
      'vote_sessions',
      'votes',
      'workshop_timers',
      'workspace_ai_settings',
      'workspace_members',
      'workspaces',
    ])
  })

  it('upgrade a milestone-1 database that already holds data', async () => {
    const shipped = loadMigrations(MIGRATIONS_DIR)
    // What the milestone-1 build left behind: only 0001_core applied, plus a board and a pending,
    // single-use board invitation (0005 adds CHECKs to invitations that existing rows must satisfy).
    expect((await migrate(db, { migrations: shipped.slice(0, 1) })).applied).toEqual(['0001_core'])
    await db.exec(`
      INSERT INTO users (id, name, handle, color) VALUES ('usr_aaaaaaaaaaaa', 'Alice', 'alice', '#3355ff');
      INSERT INTO workspaces (id, name, created_by) VALUES ('wsp_aaaaaaaaaaaa', 'Studio', 'usr_aaaaaaaaaaaa');
      INSERT INTO boards (id, workspace_id, title, created_by)
        VALUES ('b-aaaaaaaaaa', 'wsp_aaaaaaaaaaaa', 'Plan', 'usr_aaaaaaaaaaaa');
      INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, expires_at)
        VALUES ('inv_aaaaaaaaaaaa', repeat('a', 64), 'wsp_aaaaaaaaaaaa', 'b-aaaaaaaaaa', 'editor',
                'usr_aaaaaaaaaaaa', now() + interval '60 days');
      INSERT INTO sessions (id_hash, user_id, expires_at)
        VALUES (repeat('b', 64), 'usr_aaaaaaaaaaaa', now() + interval '30 days');
    `)
    const next = await migrate(db, { migrations: shipped })
    expect(next.applied).toEqual([
      '0002_comments',
      '0003_history',
      '0004_workshops',
      '0005_dashboard',
      '0006_workshop_links',
      '0007_assets',
      '0008_session_revocation',
      '0009_guests',
      '0010_private_notes',
      '0011_board_thumbnails',
      '0012_board_export_policy',
      '0013_asset_gc',
      '0014_checkpoint_policy',
      '0015_board_search',
      '0016_ai_usage',
      '0017_comment_notifications',
      '0018_ai_settings',
      '0019_checkpoint_reasons',
      '0020_comment_visibility',
      '0021_domain_access',
    ])
    expect(await recorded()).toEqual(shipped.map((m) => m.name))
    const inv = await db.one<{ multi_use: boolean; use_count: number }>(
      "SELECT multi_use, use_count FROM invitations WHERE id = 'inv_aaaaaaaaaaaa'",
    )
    expect(inv).toEqual({ multi_use: false, use_count: 0 })
    // A signed-in person stays signed in across 0008 (no Clerk session is known for old sessions).
    const session = await db.one<{ clerk_session_id: string | null; revoked_at: Date | null }>(
      `SELECT clerk_session_id, revoked_at FROM sessions WHERE id_hash = repeat('b', 64)`,
    )
    expect(session).toEqual({ clerk_session_id: null, revoked_at: null })
    // 0009: existing people are account users, and existing links do not let guests in.
    expect(await db.one("SELECT kind, guest_name FROM users WHERE id = 'usr_aaaaaaaaaaaa'")).toEqual({
      kind: 'account',
      guest_name: null,
    })
    expect(await db.one("SELECT allow_guests FROM invitations WHERE id = 'inv_aaaaaaaaaaaa'")).toEqual({
      allow_guests: false,
    })
    // 0021 (domain access): the open single-use link was bound to nobody, so it is revoked (D3); the
    // user's only workspace becomes their personal one; nobody has confirmed addresses yet.
    const unbound = await db.one<{
      invited_email: string | null
      revoked: boolean
      redeemed_by: string | null
    }>(
      "SELECT invited_email, revoked_at IS NOT NULL AS revoked, redeemed_by FROM invitations WHERE id = 'inv_aaaaaaaaaaaa'",
    )
    expect(unbound).toEqual({ invited_email: null, revoked: true, redeemed_by: null })
    expect(await db.one("SELECT personal_of FROM workspaces WHERE id = 'wsp_aaaaaaaaaaaa'")).toEqual({
      personal_of: 'usr_aaaaaaaaaaaa',
    })
    expect(await db.one("SELECT identity_checked_at FROM users WHERE id = 'usr_aaaaaaaaaaaa'")).toEqual({
      identity_checked_at: null,
    })
    expect(await db.one('SELECT count(*)::int AS n FROM user_emails')).toEqual({ n: 0 })
    // The checksum guard covers the feature migrations as well.
    const edited = shipped.map((m) =>
      m.version === 3 ? { ...m, checksum: checksumOf(`${m.sql}\n-- edit`) } : m,
    )
    await expect(migrate(db, { migrations: edited })).rejects.toThrow(
      /0003_history changed after it was applied/,
    )
  })
})
