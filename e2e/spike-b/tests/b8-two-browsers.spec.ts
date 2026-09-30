// B8 "Opening the converted board in two browsers: both converge; 0 pushes from either"
// (docs/EXCALIDRAW-MIGRATION.md §8.3 B8), on the generated corpus (the Lobby tour, the multi-page board,
// the heavy board, [DATA]'s 8 fixtures), converted by the Excalidraw stack's own room-open path (O1's
// conversion on open through O4's MigrationService). O4.
//
//   SPIKE_B_PORT_BASE=7905 [B8_CORPUS=<corpus dir>] [B8_BOARDS=b8-tour,b8-heavy] //     pnpm --filter @draftroom/e2e spike-b b8-two-browsers
//
// Setup: a board row under a NEW id through the api, the tldraw board file copied to that id's path
// before the room opens (the room converts it on open), two separate Chromium processes signed in as two
// dev users; A opens first (the conversion runs while it is held), then B. Pass per board: the conversion
// report is ok (the invariant checker ran, 0 violations), the snapshot holds every converted element,
// both tabs' hashes equal the test snapshot's, its invariants hold, and neither tab pushed an op (their
// push logs also go to B10's evidence folder). The report (`b8-two-browsers.json` in the test's output)
// carries ids, counts, timings and hash prefixes only. B8_CORPUS reuses a corpus made by
// `e2e/spike-b/b8/corpus.ts` (O4's run script makes one per run); without it the spec makes its own.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type CorpusBoard, makeCorpus } from '../b8/corpus.ts'
import { EXCALIDRAW_BASE, opSummary, placeBoardFile } from '../b8/excalidraw-side.ts'
import { harness, writePushEvidence } from '../support/harness.ts'

let dir = ''
let corpusDir = ''
let corpus: CorpusBoard[] = []
test.beforeAll(async () => {
  test.setTimeout(600_000)
  dir = mkdtempSync(join(tmpdir(), 'b8-two-'))
  if (process.env.B8_CORPUS) {
    corpusDir = process.env.B8_CORPUS
    corpus = JSON.parse(readFileSync(join(corpusDir, 'corpus.json'), 'utf8')) as CorpusBoard[]
  } else {
    corpusDir = join(dir, 'corpus')
    corpus = await makeCorpus(corpusDir)
  }
  // B8_BOARDS narrows the corpus for a smoke run (the evidence runs use every board)
  const only = process.env.B8_BOARDS?.split(',').filter(Boolean)
  if (only) corpus = corpus.filter((b) => only.includes(b.boardId))
})
test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface ConvertReportView {
  ok: boolean
  recordsIn: number
  elementsOut: number
  ms: number
  invariants?: string
  violations?: unknown[]
  peakHeapTotalMb: number
}

test('every converted generated board opens in two browsers: converged, 0 pushes', async ({
  browserName: _b,
}, info) => {
  test.setTimeout(1_800_000)
  const stack = await harness.startStack({
    base: EXCALIDRAW_BASE,
    engine: 'excalidraw',
    dataDir: join(dir, 'data'),
  })
  const rows: Record<string, unknown>[] = []
  try {
    const a = harness.devUser('A')
    const b = harness.devUser('B')
    const pa = await harness.launchBrowser(stack, a, { name: 'A' })
    const pb = await harness.launchBrowser(stack, b, { name: 'B' })
    try {
      for (const board of corpus) {
        const { boardId } = await stack.createBoard({ owner: a, members: [{ user: b, role: 'editor' }] })
        placeBoardFile(stack, join(corpusDir, board.file), boardId)
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
        await writePushEvidence(info, `${board.boardId}-A`, ra)
        await writePushEvidence(info, `${board.boardId}-B`, rb)
        const row = {
          board: board.boardId,
          converted: report?.ok === true,
          checkerRan: report?.invariants === 'ran',
          reportViolations: report?.violations?.length ?? null,
          allElements: conv.snapshot.elements.length === report?.elementsOut,
          converged: conv.ok,
          violations: inv.violations.length,
          pushesA: await ra.count(),
          pushesB: await rb.count(),
        }
        rows.push({
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
          board: board.boardId,
          converted: true,
          checkerRan: true,
          reportViolations: 0,
          allElements: true,
          converged: true,
          violations: 0,
          pushesA: 0,
          pushesB: 0,
        })
        if (existsSync(reportPath)) cpSync(reportPath, info.outputPath('migration', `${board.boardId}.json`))
      }
    } finally {
      await pa.close()
      await pb.close()
    }
  } finally {
    writeFileSync(info.outputPath('b8-two-browsers.json'), `${JSON.stringify(rows, null, 1)}\n`)
    await stack.stop()
  }
  expect(rows.length).toBe(corpus.length)
})
