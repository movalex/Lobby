// B8's rollback drill on the largest restored staging copy (by records: 64), through the Excalidraw
// build (docs/EXCALIDRAW-MIGRATION.md §8.3 B8, §8.6.7): the same drill as b8-drill.spec.ts (conversion
// on open, A in a browser, the R0 stand-in with B's edits and the born-after refusal against a board
// created on the Excalidraw build, the roll-forward on open, twice). Project `b8-staging` only; every data
// dir (the launcher's dr-e2e-* folder included), temp dir, log and report stays inside SPIKE_B8_DIR (the
// caller sets TEMP/TMP inside it); the report carries ids, group names, counts, timings and hashes only.
// O4 and V3 only.
//
//   SPIKE_B8_DIR=<spike-b8> TEMP=<spike-b8>/t3 TMP=<spike-b8>/t3 SPIKE_B_PORT_BASE=7905 \
//     B8_RUN=<tag> pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-drill
//
// Paths are kept short (`w3/dr-<run>`, data dir `d`): SPIKE_B8_DIR is deep in the scratchpad, and the
// stack's data dir adds the launcher's dr-e2e-* level, so the stand-in's backup files (and their SQLite
// journals) would pass Windows' 260-character path limit under longer names ("unable to open database
// file"). A check fails if the deepest backup path could pass it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { readDb } from '../../../apps/sync/test/migrate/board-files.ts'
import { runDrill } from '../b8/drill.ts'
import { DRILL_SYNC_ENV, EXCALIDRAW_BASE, harnessSide } from '../b8/excalidraw-side.ts'
import { harness } from '../support/harness.ts'

const B8 = process.env.SPIKE_B8_DIR ?? ''
const inside = (p: string) => {
  const r = relative(resolve(B8), resolve(p))
  return !!B8 && !!r && !r.startsWith('..') && !r.includes(':')
}

/**
 * The largest restored copy by record count (§8.3 B8: "the largest staging board copy (64 records)").
 * The counts are read from scratch copies inside `work` (the restored files are never opened), and only
 * the count leaves the query.
 */
function largestCopy(work: string): { path: string; records: number } {
  const tmp = join(B8, 'tmp')
  const drill = readdirSync(tmp).find((d) => d.startsWith('dr-restore-drill-'))
  if (!drill) throw new Error('no restored copies')
  const rooms = join(tmp, drill, 'rooms')
  const scratch = join(work, 'count')
  mkdirSync(scratch, { recursive: true })
  let best: { path: string; records: number } | null = null
  try {
    for (const f of readdirSync(rooms).filter((x) => x.endsWith('.sqlite'))) {
      const copy = join(scratch, f)
      copyFileSync(join(rooms, f), copy)
      if (existsSync(join(rooms, `${f}-wal`))) copyFileSync(join(rooms, `${f}-wal`), `${copy}-wal`)
      const records = readDb(copy, (db) =>
        Number((db.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).n),
      )
      if (!best || records > best.records) best = { path: join(rooms, f), records }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (!best) throw new Error('no restored copies')
  return best
}

test('the rollback drill on the largest staging copy, two cycles', async ({ browserName: _b }, info) => {
  test.setTimeout(900_000)
  const run = process.env.B8_RUN ?? '1'
  const work = join(B8, 'w3', `dr-${run}`)
  expect(inside(work)).toBe(true)
  expect(inside(info.project.outputDir)).toBe(true)
  for (const k of ['TEMP', 'TMP'] as const) expect(inside(process.env[k] ?? '')).toBe(true)
  mkdirSync(work, { recursive: true })
  const copy = largestCopy(work)
  const dataDir = join(work, 'd')
  const stack = await harness.startStack({
    base: EXCALIDRAW_BASE,
    engine: 'excalidraw',
    dataDir,
    syncEnv: DRILL_SYNC_ENV,
  })
  expect(inside(stack.dataDir)).toBe(true)
  // the deepest file the stand-in writes: <data>/backups/<board id>/.<ISO stamp>-<8 hex>.tmp-journal
  expect(
    resolve(stack.dataDir, 'backups', 'b-0123456789', `.${'x'.repeat(24)}-01234567.tmp-journal`).length,
  ).toBeLessThan(250)
  try {
    const owner = harness.devUser('A')
    const { boardId } = await stack.createBoard({ owner })
    const side = harnessSide(stack, owner)
    try {
      const report = await runDrill({
        board: copy.path,
        work,
        dataDir: stack.dataDir,
        boardId,
        excalidraw: 'room',
        side,
        staging: true,
      })
      const source = copy.path.replace(/^.*board-(.+)\.sqlite$/, '$1')
      mkdirSync(join(B8, 'reports'), { recursive: true })
      writeFileSync(
        join(B8, 'reports', `b8-staging-drill-room-${run}.json`),
        `${JSON.stringify({ source, sourceRecords: copy.records, releasesClean: side.releases, ...report }, null, 1)}\n`,
      )
      const failed = [...report.setup, ...report.cycles.flatMap((c) => c.checks), ...report.bornAfter]
        .filter((c) => !c.pass)
        .map((c) => c.name)
      expect.soft(failed).toEqual([])
      expect(report.cycles.length).toBe(2)
    } finally {
      await side.close()
    }
  } finally {
    await stack.stop()
  }
})
