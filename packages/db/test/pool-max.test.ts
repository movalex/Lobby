// Wave M, M5-2: the api's Postgres pool is capped by DRAFTROOM_DB_POOL_MAX (render.yaml: 5 on the api), and a
// pooled client is never kept: every `.connect()` in the repo's source releases its client in a `finally`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DB_POOL_MAX_DEFAULT,
  DB_POOL_MAX_ENV,
  DB_POOL_MAX_MAX,
  DB_POOL_MAX_MIN,
  dbPoolMaxFromEnv,
} from '../src/pg.ts'

describe('DRAFTROOM_DB_POOL_MAX', () => {
  it('unset or empty keeps today’s pool of 10', () => {
    expect(DB_POOL_MAX_DEFAULT).toBe(10)
    expect(dbPoolMaxFromEnv({})).toBe(10)
    expect(dbPoolMaxFromEnv({ [DB_POOL_MAX_ENV]: '' })).toBe(10)
    expect(dbPoolMaxFromEnv({ [DB_POOL_MAX_ENV]: '   ' })).toBe(10)
  })

  it('takes a whole number from 2 to 20 (render.yaml’s 5 included)', () => {
    expect([DB_POOL_MAX_MIN, DB_POOL_MAX_MAX]).toEqual([2, 20])
    for (const n of [2, 3, 5, 10, 19, 20]) expect(dbPoolMaxFromEnv({ [DB_POOL_MAX_ENV]: String(n) })).toBe(n)
    expect(dbPoolMaxFromEnv({ [DB_POOL_MAX_ENV]: ' 5 ' })).toBe(5)
  })

  it('refuses anything else, naming the variable (the process does not start on a guess)', () => {
    for (const bad of [
      '0',
      '1',
      '21',
      '100',
      '-5',
      '5.5',
      '5e1',
      'five',
      '0x10',
      '+5',
      '5 6',
      'NaN',
      'Infinity',
    ])
      expect(() => dbPoolMaxFromEnv({ [DB_POOL_MAX_ENV]: bad }), bad).toThrow(/DRAFTROOM_DB_POOL_MAX/)
  })

  it('reads process.env by default', () => {
    const before = process.env[DB_POOL_MAX_ENV]
    try {
      process.env[DB_POOL_MAX_ENV] = '7'
      expect(dbPoolMaxFromEnv()).toBe(7)
      delete process.env[DB_POOL_MAX_ENV]
      expect(dbPoolMaxFromEnv()).toBe(10)
    } finally {
      if (before === undefined) delete process.env[DB_POOL_MAX_ENV]
      else process.env[DB_POOL_MAX_ENV] = before
    }
  })
})

// ---- every pooled client is released in a finally ---------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** The source trees that talk to Postgres (or may one day): the api, the worker, the sync server, the packages. */
const TREES = ['apps/api/src', 'apps/worker/src', 'apps/sync/src', 'packages']

function sources(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.(ts|mts|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** `const <name> = await <pool>.connect()`: a pg pool checkout (not a socket's or a room's connect). */
const CHECKOUT = /const\s+(\w+)\s*=\s*await\s+([\w.]*pool[\w.]*)\.connect\(\s*\)/gi

/** Problems with each checkout in `text`: its client must be released inside a `finally` block after it. */
export function checkoutProblems(text: string, file: string): string[] {
  const problems: string[] = []
  for (const m of text.matchAll(CHECKOUT)) {
    const name = m[1] as string
    const after = text.slice((m.index ?? 0) + m[0].length)
    const fin = after.search(/\bfinally\s*\{/)
    if (fin < 0) {
      problems.push(`${file}: ${name} from ${m[2]}.connect() has no finally after it`)
      continue
    }
    // the finally block's own text (brace-matched)
    const open = after.indexOf('{', fin)
    let depth = 0
    let end = open
    for (; end < after.length; end++) {
      if (after[end] === '{') depth++
      else if (after[end] === '}' && --depth === 0) break
    }
    const block = after.slice(open, end + 1)
    if (!new RegExp(`\\b${name}\\.release\\(`).test(block))
      problems.push(`${file}: ${name} from ${m[2]}.connect() is not released in the finally that follows it`)
  }
  return problems
}

describe('pooled clients are released in finally (M5-2)', () => {
  it('the check finds a checkout without a release, or released outside a finally', () => {
    expect(
      checkoutProblems('const c = await pool.connect()\nawait c.query("x")\nc.release()', 'a.ts'),
    ).toEqual(['a.ts: c from pool.connect() has no finally after it'])
    expect(
      checkoutProblems('const c = await this.pool.connect()\ntry { } finally { log() }\nc.release()', 'b.ts'),
    ).toEqual(['b.ts: c from this.pool.connect() is not released in the finally that follows it'])
    expect(
      checkoutProblems('const c = await pool.connect()\ntry { x() } finally { c.release(broken) }', 'c.ts'),
    ).toEqual([])
    // a socket's or a room's connect is not a pool checkout
    expect(checkoutProblems('const s = await rooms.connect()', 'd.ts')).toEqual([])
  })

  it('every pg pool checkout in the source trees releases its client in a finally', () => {
    const files = TREES.flatMap((t) => sources(join(ROOT, t)))
    expect(files.length).toBeGreaterThan(100)
    const problems: string[] = []
    let checkouts = 0
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      checkouts += [...text.matchAll(CHECKOUT)].length
      problems.push(...checkoutProblems(text, relative(ROOT, f).replaceAll('\\', '/')))
    }
    expect(problems).toEqual([])
    // today exactly one: packages/db/src/pg.ts transaction()
    expect(checkouts).toBeGreaterThanOrEqual(1)
  })
})
