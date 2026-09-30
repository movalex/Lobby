// B8's staging row "Opening the converted board in two browsers" (docs/EXCALIDRAW-MIGRATION.md §8.3 B8,
// §8.6.7): every restored staging copy, converted by the Excalidraw stack's room-open path (O1's
// conversion on open through O4's MigrationService), opened in two Chromium processes. Project
// `b8-staging` only; the stack's data dir (with the launcher's dr-e2e-* folder) inside SPIKE_B8_DIR; the
// run's TEMP/TMP inside it too (the caller sets them); assertions, the report and B10's push logs carry
// board ids, counts, timings and hash prefixes only. O4 and V3 only. The same pass as
// b8-two-browsers.spec.ts.
//
//   SPIKE_B8_DIR=<spike-b8> TEMP=<spike-b8>/t3 TMP=<spike-b8>/t3 SPIKE_B_PORT_BASE=7905 \
//     B8_RUN=<tag> pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-two-browsers
//
// Paths are kept short (`w3/2b-<run>/d`): SPIKE_B8_DIR is deep in the scratchpad, and the stack's data dir
// adds the launcher's dr-e2e-* level (Windows' 260-character path limit).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { EXCALIDRAW_BASE, opSummary, placeBoardFile } from '../b8/excalidraw-side.ts'
import { harness, writePushEvidence } from '../support/harness.ts'

const B8 = process.env.SPIKE_B8_DIR ?? ''
const inside = (p: string) => {
  const r = relative(resolve(B8), resolve(p))
  return !!B8 && !!r && !r.startsWith('..') && !r.includes(':')
}

interface ConvertReportView {
  ok: boolean
  recordsIn: number
  elementsOut: number
  ms: number
  invariants?: string
  violations?: unknown[]
  peakHeapTotalMb: number
}

test('every staging copy opens converted in two browsers: converged, 0 pushes', async ({
  browserName: _b,
}, info) => {
  test.setTimeout(900_000)
  const run = process.env.B8_RUN ?? '1'
  const dataDir = join(B8, 'w3', `2b-${run}`, 'd')
  expect(inside(dataDir)).toBe(true)
  expect(inside(info.project.outputDir)).toBe(true)
  for (const k of ['TEMP', 'TMP'] as const) expect(inside(process.env[k] ?? '')).toBe(true)
  const tmp = join(B8, 'tmp')
  const drill = readdirSync(tmp).find((d) => d.startsWith('dr-restore-drill-')) as string
  const rooms = join(tmp, drill, 'rooms')
  const files = readdirSync(rooms)
    .filter((x) => x.endsWith('.sqlite'))
    .sort()
  const stack = await harness.startStack({ base: EXCALIDRAW_BASE, engine: 'excalidraw', dataDir })
  expect(inside(stack.dataDir)).toBe(true)
  const out: Record<string, unknown>[] = []
  try {
    const a = harness.devUser('A')
    const b = harness.devUser('B')
    const pa = await harness.launchBrowser(stack, a, { name: 'A' })
    const pb = await harness.launchBrowser(stack, b, { name: 'B' })
    try {
      for (const f of files) {
        const source = f.slice('board-'.length, -'.sqlite'.length)
        const { boardId } = await stack.createBoard({ owner: a, members: [{ user: b, role: 'editor' }] })
        placeBoardFile(stack, join(rooms, f), boardId)
        const ra = await harness.recordPushes(pa.page)
        const rb = await harness.recordPushes(pb.page)
        const t0 = Date.now()
        await pa.openBoard(boardId)
        const openA = Date.now() - t0
        const t1 = Date.now()
        await pb.openBoard(boardId)
        const openB = Date.now() - t1
        const conv = await harness.converged(stack, boardId, [pa, pb], { timeoutMs: 60_000 })
        const inv = harness.checkInvariants(conv.snapshot)
        const reportPath = join(stack.dataDir, 'migration', `${boardId}.json`)
        const report = existsSync(reportPath)
          ? (JSON.parse(readFileSync(reportPath, 'utf8')) as ConvertReportView)
          : null
        const live = conv.snapshot.elements.filter((e) => !e.isDeleted).length
        await writePushEvidence(info, `${source}-A`, ra)
        await writePushEvidence(info, `${source}-B`, rb)
        const row = {
          board: source,
          converted: report?.ok === true,
          checkerRan: report?.invariants === 'ran',
          reportViolations: report?.violations?.length ?? null,
          allElements: conv.snapshot.elements.length === report?.elementsOut,
          converged: conv.ok,
          violations: inv.violations.length,
          pushesA: await ra.count(),
          pushesB: await rb.count(),
        }
        out.push({
          ...row,
          boardId,
          recordsIn: report?.recordsIn ?? null,
          elementsOut: report?.elementsOut ?? null,
          snapshotElements: conv.snapshot.elements.length,
          live,
          tombstones: conv.snapshot.elements.length - live,
          convertMs: report?.ms ?? null,
          peakHeapTotalMb: report?.peakHeapTotalMb ?? null,
          openMsA: openA,
          openMsB: openB,
          hash: conv.snapshot.hash.slice(0, 16),
          opsA: await opSummary(ra),
          opsB: await opSummary(rb),
        })
        expect.soft(row).toEqual({
          board: source,
          converted: true,
          checkerRan: true,
          reportViolations: 0,
          allElements: true,
          converged: true,
          violations: 0,
          pushesA: 0,
          pushesB: 0,
        })
      }
    } finally {
      await pa.close()
      await pb.close()
    }
  } finally {
    mkdirSync(join(B8, 'reports'), { recursive: true })
    writeFileSync(
      join(B8, 'reports', `b8-staging-two-browsers-${run}.json`),
      `${JSON.stringify(out, null, 1)}\n`,
    )
    await stack.stop()
  }
  expect(out.length).toBe(files.length)
})
