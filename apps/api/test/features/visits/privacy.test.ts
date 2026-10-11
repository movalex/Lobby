// Wave N, N4-1: the owner's condition for storing visit times is that nobody else ever sees who visited when. These
// tests read the api's SOURCE, so a later change that adds a way to read another person's row (or to expose visit times
// in a list, export, counter or log) fails here instead of in review. The runtime half is visits.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MARK_SEEN_SQL,
  PRUNE_VISITS_SQL,
  RECORD_VISIT_SQL,
  STORED_VISIT_SQL,
} from '../../../src/features/visits/store.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}
/** Source without its comments (a comment may name the table; code may not, outside the store). */
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
const rel = (p: string) => relative(SRC, p).split(sep).join('/')

describe('board_visits is touched by one file, and never by another person’s id', () => {
  const files = walk(SRC)

  it('only features/visits/store.ts has SQL on board_visits', () => {
    const naming = files.filter((f) => /board_visits/.test(code(f))).map(rel)
    expect(naming).toEqual(['features/visits/store.ts'])
  })

  it('no other table-reading code joins, lists or counts it: the one statement without a user id is the prune', () => {
    for (const [name, sql] of Object.entries({ RECORD_VISIT_SQL, MARK_SEEN_SQL, STORED_VISIT_SQL })) {
      // keyed by the board ($1) and the person ($2), both in the lookup and in the write
      expect(sql, name).toMatch(/user_id = \$2|VALUES \(\$1, \$2, \$3\)/)
      expect(sql, name).not.toMatch(/JOIN|GROUP BY|count\(|string_agg|array_agg|ORDER BY|LIMIT/i)
    }
    expect(RECORD_VISIT_SQL).toMatch(/WHERE board_id = \$1 AND user_id = \$2/)
    expect(STORED_VISIT_SQL).toMatch(/WHERE board_id = \$1 AND user_id = \$2$/)
    // the prune deletes by age only and returns nothing (no RETURNING): a count is all the sweeper learns
    expect(PRUNE_VISITS_SQL).toMatch(/^\s*DELETE FROM board_visits/)
    expect(PRUNE_VISITS_SQL).not.toMatch(/RETURNING/i)
  })

  it('the routes pass only the session’s user id to the store, and read no user id from the request', () => {
    const index = code(join(SRC, 'features/visits/index.ts'))
    const calls = [...index.matchAll(/\b(recordVisit|markSeen|storedVisit)\(([^)]*)\)/g)]
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const [, fn, args] of calls) expect(args, String(fn)).toMatch(/^db, boardId, user\.id(, at)?$/)
    // the request is read for the board id only: no body, no query, no other param
    expect(index).not.toMatch(/req\.(body|query)/)
    expect(index.match(/req\.params/g)?.length).toBe(2)
    expect(index).not.toMatch(/\.(userId|uid)\b/)
    // and nothing logs or audits a visit
    expect(index).not.toMatch(/\blog\b|audit\(|countUsage|publish\(/)
  })

  it('the store’s statements are only used from the visits feature', () => {
    const imports = (f: string) =>
      rel(f).startsWith('features/visits/')
        ? /from '\.\/store\.ts'/.test(code(f))
        : /visits\/store\.ts'/.test(code(f))
    const users = files.filter(imports).map(rel)
    expect(users.sort()).toEqual(['features/visits/index.ts', 'features/visits/sweep.ts'])
  })

  it('no other module of the api mentions a visit time: nothing exports, lists or counts them', () => {
    for (const f of files.filter((f) => !rel(f).startsWith('features/visits/'))) {
      const src = code(f)
      expect(src, rel(f)).not.toMatch(/previousSeenAt|board_visits/)
    }
  })
})
