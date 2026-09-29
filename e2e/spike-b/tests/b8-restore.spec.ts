// B8 (docs/EXCALIDRAW-MIGRATION.md §8.3): "restoreElements fixed point in the browser: 0 changed fields",
// on the generated corpus (the Lobby tour, the multi-page board, the heavy board and [DATA]'s 8 fixtures,
// all made with the current build) converted in the sync's capped worker. O4.
//
//   SPIKE_B_PORT_BASE=7905 pnpm --filter @draftroom/e2e spike-b b8-restore
//
// Needs no stack: the corpus is made on O4's R0 stand-in port (7900) and converted in-process through
// room/migrate; the page is spike A's /spike/engine on this run's web build (7907).
// Pass: no element dropped or added, no non-numeric field changed (`text`, i.e. every line break,
// included), and no number moved by more than GEOMETRY_TOLERANCE_PX. Deviation from "0 changed fields",
// recorded in B8.md: a label's `width` (and, centred, its `x`) is re-measured with Chromium's canvas and
// differs from the server table's by a fraction of a pixel; those are counted and their maximum reported.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX } from '../../../packages/canvas-schema/src/limits.ts'
import { convertCorpus } from '../b8/convert-corpus.ts'
import { makeCorpus } from '../b8/corpus.ts'
import { convertedElements, openEnginePage, restoreFixedPoint, summarize } from '../b8/restore-check.ts'

test.describe.configure({ mode: 'serial' })

let dir = ''
let boards: string[] = []

test.beforeAll(async () => {
  test.setTimeout(600_000)
  dir = mkdtempSync(join(tmpdir(), 'b8-restore-'))
  const corpus = join(dir, 'corpus')
  const made = await makeCorpus(corpus)
  const results = await convertCorpus({
    corpus,
    work: join(dir, 'work'),
    mode: 'runtime',
    verifyLocalMode: false,
  })
  expect(results.filter((r) => !r.ok).map((r) => r.boardId)).toEqual([])
  boards = made.map((b) => b.boardId)
})

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('every converted element is a fixed point of restoreElements (repairBindings, refreshDimensions)', async ({
  page,
}, info) => {
  test.setTimeout(600_000)
  await openEnginePage(page)
  const out: Record<string, ReturnType<typeof summarize>> = {}
  for (const boardId of boards) {
    const d = await restoreFixedPoint(
      page,
      convertedElements(join(dir, 'work', 'rooms', `board-${boardId}.sqlite`)),
    )
    out[boardId] = summarize(d, GEOMETRY_TOLERANCE_PX)
  }
  writeFileSync(info.outputPath('b8-restore.json'), `${JSON.stringify(out, null, 1)}\n`)
  for (const [board, s] of Object.entries(out))
    expect({ board, dropped: s.dropped, added: s.added, beyondTolerance: s.beyondTolerance }).toEqual({
      board,
      dropped: 0,
      added: 0,
      beyondTolerance: [],
    })
})
