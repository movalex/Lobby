// Wave W (WS5, W5-3; docs/WAVE-W-CONTRACTS.md §7): the audit log viewer's page query on a real Postgres with a large
// log (the table is never purged). The `before` page must not read the whole table: its plan uses an index on
// audit_events (the primary key read backwards, or audit_events_workspace_idx), never a sequential scan, and stays fast.
// The plans are printed for the gate's evidence. Set DRAFTROOM_TEST_DATABASE_URL to run it (skipped otherwise).
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { auditPageSql } from '../../../src/features/workspace-admin/queries.ts'
import { createTestApi, type TestApi } from '../../helpers.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL

let api: TestApi | undefined
let base: Db | undefined
afterEach(async () => {
  await api?.close()
  await base?.close()
  api = undefined
  base = undefined
})

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

function scansOf(node: PlanNode, out: { type: string; index?: string }[] = []) {
  if (node['Relation Name'] === 'audit_events') out.push({ type: node['Node Type'], index: node['Index Name'] })
  for (const p of node.Plans ?? []) scansOf(p, out)
  return out
}

describe.skipIf(!PG)('the audit page on a real Postgres', () => {
  it('reads a page of a large log through an index, never a sequential scan', async () => {
    base = await openTestDb()
    expect(base.kind).toBe('pg')
    api = await createTestApi({ db: base })
    const big = await api.login('auditbig')
    const small = await api.login('auditsmall')
    // 120,000 rows: three quarters in one workspace, a quarter in another (ids interleaved, as real writes are)
    await base.query(
      `INSERT INTO audit_events (workspace_id, actor_id, action, target, detail, at)
       SELECT CASE WHEN g % 4 = 0 THEN $2 ELSE $1 END, $3,
              CASE WHEN g % 50 = 0 THEN 'board.visibility' ELSE 'library.folder.create' END,
              'x', '{}'::jsonb, timestamptz '2026-01-01' + g * interval '1 second'
         FROM generate_series(1, 120000) AS g`,
      [big.personalWorkspaceId, small.personalWorkspaceId, big.userId],
    )
    await base.query('ANALYZE audit_events')
    const mid = await base.one<{ id: number }>(
      'SELECT (min(id) + (max(id) - min(id)) / 2)::float8 AS id FROM audit_events',
    )
    const cases: [string, string, Parameters<typeof auditPageSql>[1]][] = [
      ['big, first page', big.personalWorkspaceId, {}],
      ['big, before the middle', big.personalWorkspaceId, { before: Number(mid.id) }],
      ['small, before the middle', small.personalWorkspaceId, { before: Number(mid.id) }],
      ['big, one action', big.personalWorkspaceId, { before: Number(mid.id), action: 'board.visibility' }],
      ['big, one person', big.personalWorkspaceId, { before: Number(mid.id), actor: big.userId }],
    ]
    for (const [name, wid, query] of cases) {
      const { text, params } = auditPageSql(wid, query, 100)
      const explained = await base.query<{ 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
        params,
      )
      const plan = explained.rows[0]?.['QUERY PLAN'][0]
      if (!plan) throw new Error('no plan')
      const scans = scansOf(plan.Plan)
      console.log(
        `audit plan, ${name}: ${scans.map((s) => `${s.type}${s.index ? ` on ${s.index}` : ''}`).join(', ')}; ${plan['Execution Time'].toFixed(2)} ms`,
      )
      expect(scans.length, name).toBeGreaterThan(0)
      for (const s of scans) expect(s.type, name).not.toBe('Seq Scan')
      expect(plan['Execution Time'], name).toBeLessThan(250)
    }
  }, 120_000)
})
