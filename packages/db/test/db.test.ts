import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, isId, isUniqueViolation, newBoardId, newId, openDb } from '../src/index.ts'

describe('Db (PGlite, in memory)', () => {
  let db: Db
  beforeEach(async () => {
    db = await openDb({ kind: 'pglite' })
    await db.exec('CREATE TABLE t (id int PRIMARY KEY, v text, at timestamptz, j jsonb)')
  })
  afterEach(() => db.close())

  it('query returns rows and rowCount; params are positional', async () => {
    const ins = await db.query('INSERT INTO t (id, v) VALUES ($1, $2), ($3, $4)', [1, 'a', 2, 'b'])
    expect(ins.rowCount).toBe(2)
    const sel = await db.query<{ id: number; v: string }>(
      'SELECT id, v FROM t WHERE id > $1 ORDER BY id',
      [0],
    )
    expect(sel.rows).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ])
    const upd = await db.query('UPDATE t SET v = $1 WHERE id = $2', ['z', 2])
    expect(upd.rowCount).toBe(1)
  })

  it('maps timestamptz to Date and round-trips jsonb passed as text', async () => {
    const at = new Date('2026-01-02T03:04:05.678Z')
    await db.query('INSERT INTO t (id, at, j) VALUES (1, $1, $2::jsonb)', [at, JSON.stringify({ k: [1] })])
    const row = await db.one<{ at: Date; j: unknown }>('SELECT at, j FROM t WHERE id = 1')
    expect(row.at).toBeInstanceOf(Date)
    expect(row.at.toISOString()).toBe(at.toISOString())
    expect(row.j).toEqual({ k: [1] })
  })

  it('one requires exactly one row; maybeOne allows zero but not two', async () => {
    await db.query("INSERT INTO t (id, v) VALUES (1, 'x'), (2, 'x')")
    await expect(db.one('SELECT * FROM t WHERE id = 9')).rejects.toThrow(/exactly one row, got 0/)
    await expect(db.one("SELECT * FROM t WHERE v = 'x'")).rejects.toThrow(/exactly one row, got 2/)
    expect(await db.maybeOne('SELECT * FROM t WHERE id = 9')).toBeNull()
    expect(await db.maybeOne<{ id: number }>('SELECT id FROM t WHERE id = 2')).toEqual({ id: 2 })
    await expect(db.maybeOne("SELECT * FROM t WHERE v = 'x'")).rejects.toThrow(/at most one row, got 2/)
  })

  it('transaction commits on success and rolls back everything on throw', async () => {
    const r = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO t (id) VALUES (1)')
      return (await tx.one<{ c: number }>('SELECT count(*)::int AS c FROM t')).c
    })
    expect(r).toBe(1)
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO t (id) VALUES (2)')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await db.one<{ c: number }>('SELECT count(*)::int AS c FROM t')).c).toBe(1)
  })

  it('surfaces the SQLSTATE so callers can recognize unique violations', async () => {
    await db.query('INSERT INTO t (id) VALUES (1)')
    const err = await db.query('INSERT INTO t (id) VALUES (1)').catch((e: unknown) => e)
    expect(isUniqueViolation(err)).toBe(true)
    expect(isUniqueViolation(new Error('x'))).toBe(false)
  })
})

describe('Db (PGlite, data directory)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dr-pg-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists across close and reopen', async () => {
    let db = await openDb({ kind: 'pglite', dataDir: join(dir, 'pg') })
    await db.exec("CREATE TABLE kept (v text); INSERT INTO kept VALUES ('still here')")
    await db.close()
    db = await openDb({ kind: 'pglite', dataDir: join(dir, 'pg') })
    expect(await db.one('SELECT v FROM kept')).toEqual({ v: 'still here' })
    await db.close()
  })

  it('refuses a second opener of the same directory until the first closes', async () => {
    const pgDir = join(dir, 'pg')
    const first = await openDb({ kind: 'pglite', dataDir: pgDir })
    await expect(openDb({ kind: 'pglite', dataDir: pgDir })).rejects.toThrow(/already open in process/)
    await first.close()
    await first.close() // idempotent: must not remove a lock someone else takes next
    const second = await openDb({ kind: 'pglite', dataDir: pgDir })
    await second.close()
  })

  it('takes over a lock left by a process that no longer exists', async () => {
    const pgDir = join(dir, 'pg')
    // A pid far above any real one: the lock's owner is gone (crash, kill -9).
    writeFileSync(`${pgDir}.lock`, '2147483646')
    const db = await openDb({ kind: 'pglite', dataDir: pgDir })
    expect(readFileSync(`${pgDir}.lock`, 'utf8')).toBe(String(process.pid))
    await db.close()
    expect(existsSync(`${pgDir}.lock`)).toBe(false)
  })
})

describe('ids', () => {
  it('newId: prefix + 20 base62, unique, accepted by isId for its own prefix only', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('usr')))
    expect(ids.size).toBe(2000)
    for (const id of ids) expect(id).toMatch(/^usr_[0-9A-Za-z]{20}$/)
    const wsp = newId('wsp')
    expect(isId('wsp', wsp)).toBe(true)
    expect(isId('usr', wsp)).toBe(false)
    expect(isId('usr', 'usr_short')).toBe(false)
  })

  it('newBoardId: b- + 10 lowercase base36, valid for the sync board id rule', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newBoardId()))
    expect(ids.size).toBe(2000)
    for (const id of ids) {
      expect(id).toMatch(/^b-[0-9a-z]{10}$/)
      expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{2,63}$/)
    }
  })

  it('uses every alphabet character (no truncated alphabet)', () => {
    const seen = new Set(
      Array.from({ length: 500 }, () => newId('prj').slice(4))
        .join('')
        .split(''),
    )
    expect(seen.size).toBe(62)
  })
})
