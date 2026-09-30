// B8's rollback drill through the Excalidraw build (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "Rollback
// drill"), on every generated board (the Lobby tour, the multi-page board, the heavy board and [DATA]'s 8
// fixtures, made with the current build): the Excalidraw stack (base 7905) converts the board on open, A
// edits in a browser through the facade, the R0 stand-in (7900) serves the same file and B edits through
// today's tldraw client, the born-after refusal runs against a board created on the Excalidraw build, the
// room's open path rolls forward, twice. O4.
//
//   SPIKE_B_PORT_BASE=7905 [B8_CORPUS=<corpus dir>] [B8_BOARDS=b8-tour,b8-multipage] \
//     pnpm --filter @draftroom/e2e spike-b b8-drill
//
// One stack per board (its sync evicts an idle room after 1 s, so the drill's release waits for the room
// to close the file before it stops the sync). The report (`<board>.drill.json` in the test's output)
// holds ids, group names, counts, timings and hashes only. Every failed check is listed (soft); a test
// fails if any check of its board failed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type CorpusBoard, makeCorpus } from '../b8/corpus.ts'
import { runDrill } from '../b8/drill.ts'
import { DRILL_SYNC_ENV, EXCALIDRAW_BASE, harnessSide } from '../b8/excalidraw-side.ts'
import { harness } from '../support/harness.ts'

/** Every generated board (corpus.ts's order); B8_BOARDS narrows it for a smoke run. */
const BOARDS = (
  process.env.B8_BOARDS?.split(',') ?? [
    'b8-tour',
    'b8-multipage',
    'b8-heavy',
    'b8-fx-brainstorm',
    'b8-fx-kitchen-sink',
    'b8-fx-lobby-tour',
    'b8-fx-mood-board',
    'b8-fx-pitch-outline',
    'b8-fx-production-plan',
    'b8-fx-retrospective',
    'b8-fx-storyboard',
  ]
).filter(Boolean)

let dir = ''
let corpusDir = ''
test.beforeAll(async () => {
  test.setTimeout(900_000)
  dir = mkdtempSync(join(tmpdir(), 'b8-drill-'))
  if (process.env.B8_CORPUS) corpusDir = process.env.B8_CORPUS
  else {
    corpusDir = join(dir, 'corpus')
    await makeCorpus(corpusDir)
  }
  const made = (JSON.parse(readFileSync(join(corpusDir, 'corpus.json'), 'utf8')) as CorpusBoard[]).map(
    (b) => b.boardId,
  )
  expect(BOARDS.filter((b) => !made.includes(b))).toEqual([])
})
test.afterAll(() => {
  if (dir && !process.env.B8_KEEP)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

for (const board of BOARDS)
  test(`the rollback drill on ${board}, two cycles`, async ({ browserName: _browser }, info) => {
    test.setTimeout(900_000)
    const stack = await harness.startStack({
      base: EXCALIDRAW_BASE,
      engine: 'excalidraw',
      dataDir: join(dir, `data-${board}`),
      syncEnv: DRILL_SYNC_ENV,
    })
    try {
      const owner = harness.devUser('A')
      const { boardId } = await stack.createBoard({ owner })
      const side = harnessSide(stack, owner)
      try {
        const report = await runDrill({
          board: join(corpusDir, `board-${board}.sqlite`),
          work: join(dir, `work-${board}`),
          dataDir: stack.dataDir,
          boardId,
          excalidraw: 'room',
          side,
        })
        writeFileSync(
          info.outputPath(`${board}.drill.json`),
          `${JSON.stringify({ source: board, releasesClean: side.releases, ...report }, null, 1)}\n`,
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
