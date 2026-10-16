// The stored report's size (wave R; 0035's CHECK `octet_length(report::text) <= IMPORT_REPORT_MAX_BYTES`): Postgres
// measures the jsonb's text form, which puts a space after every `:` and `,`, so a report the code measured as compact
// JSON could pass the code and fail the CHECK after the seed. The code now measures what the CHECK measures
// (importReportBytes), and a Miro report as large as one can be fits. Runs on PGlite, and on a real Postgres with
// DRAFTROOM_TEST_DATABASE_URL set (openTestDb).

import {
  IMPORT_REPORT_MAX_BYTES,
  IMPORT_REPORT_MAX_ROWS,
  type ImportReportRow,
  importReportBytes,
} from '@draftroom/contracts'
import { type Db, newId } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { buildReport } from '@draftroom/miro-import'
import { afterEach, describe, expect, it } from 'vitest'
import { recordSeeded } from '../../../src/features/imports/jobs.ts'

let db: Db | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const U = 'usr_alice00000001'
const W = 'wsp_studio0000001'

async function runningRow(q: Db) {
  await q.query(`INSERT INTO users (id, name, handle, color) VALUES ($1, 'alice', 'alice', '#3355ff')`, [U])
  await q.query(`INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'Studio', $2)`, [W, U])
  const id = newId('imb')
  await q.query(
    `INSERT INTO board_imports (id, batch_id, workspace_id, created_by, source, title, status)
     VALUES ($1, $2, $3, $4, 'miro', 'Board', 'running')`,
    [id, newId('imp'), W, U],
  )
  return id
}

/** As many short rows as a board can give: the separators Postgres adds are the largest share of these. */
const shortRows = (n: number): ImportReportRow[] =>
  Array.from({ length: n }, (_, i) => ({
    sourceId: String(i),
    type: 'shape',
    result: i % 3 ? 'native' : 'skipped',
    elementId: null,
    note: i % 3 ? null : 'over-limit',
  }))

describe('the import report’s size, as the 0035 CHECK measures it', () => {
  it('importReportBytes is octet_length(report::jsonb::text), byte for byte (nesting, escapes, non-ASCII)', async () => {
    db = await openTestDb()
    const samples: unknown[] = [
      {},
      [],
      { a: 1, b: [1, 2, { c: null }], d: { e: 'x', f: [] } },
      { text: 'quote " backslash \\ tab \t line \n bell \u0007 é 日本 🎉' },
      buildReport(shortRows(50), new Map([['color-substituted', 3]])),
    ]
    for (const s of samples) {
      const r = await db.one<{ n: number }>('SELECT octet_length($1::jsonb::text)::int AS n', [JSON.stringify(s)])
      expect(importReportBytes(s), JSON.stringify(s).slice(0, 60)).toBe(r.n)
    }
  })

  it('the largest Miro report fits the CHECK when it is stored with the seed', async () => {
    db = await openTestDb()
    const rowId = await runningRow(db)
    const notes = new Map(Array.from({ length: 25 }, (_, i) => [`color-substituted-${i}`, 1000 + i] as const))
    const report = buildReport(shortRows(IMPORT_REPORT_MAX_ROWS + 3_000), notes)
    expect(report.rowsOmitted).toBeGreaterThan(0)
    expect(importReportBytes(report)).toBeLessThanOrEqual(IMPORT_REPORT_MAX_BYTES)
    await recordSeeded(db, rowId, report, new Date())
    const stored = await db.one<{ n: number }>(
      'SELECT octet_length(report::text)::int AS n FROM board_imports WHERE id = $1',
      [rowId],
    )
    expect(stored.n).toBe(importReportBytes(report))
    // and the budget is used: most of the cap, not a fraction of it
    expect(stored.n).toBeGreaterThan(IMPORT_REPORT_MAX_BYTES - 2_048)
  })

  it('the code refuses what the CHECK would refuse (never a 23514 after the seed)', async () => {
    db = await openTestDb()
    const rowId = await runningRow(db)
    const base = buildReport(shortRows(10), new Map())
    const compact = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
    const make = (n: number) => ({ ...base, rows: shortRows(n) })
    let n = 1_000
    while (compact(make(n + 50)) <= IMPORT_REPORT_MAX_BYTES) n += 50
    // compact JSON under the cap, Postgres's text form over it
    const big = make(n)
    expect(compact(big)).toBeLessThanOrEqual(IMPORT_REPORT_MAX_BYTES)
    expect(importReportBytes(big)).toBeGreaterThan(IMPORT_REPORT_MAX_BYTES)
    await expect(recordSeeded(db, rowId, big, new Date())).rejects.toThrow('import report too large')
  })
})
