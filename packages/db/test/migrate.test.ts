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

  it('apply to an empty database and are then up to date', async () => {
    const first = await migrate(db)
    expect(first.applied[0]).toBe('0001_core')
    expect(await migrate(db)).toEqual({ applied: [] })
    expect(await tableNames()).toEqual([
      'audit_events',
      'board_members',
      'boards',
      'identities',
      'invitations',
      'projects',
      'schema_migrations',
      'sessions',
      'users',
      'workspace_members',
      'workspaces',
    ])
  })
})
