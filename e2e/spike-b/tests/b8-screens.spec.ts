// B8's visual check of the converter (docs/EXCALIDRAW-MIGRATION.md §8.4 "the owner's visual verdict";
// §5.1 "Checked visually in spike B8" for arrow bindings): the generated corpus, converted, drawn by the
// engine on spike A's /spike/engine page and saved as screenshots in this test's output folder. O4.
//
//   SPIKE_B_PORT_BASE=7905 pnpm --filter @draftroom/e2e spike-b b8-screens
//
// Generated boards only (no real data): anyone may look at these. The staging boards' screenshots are
// b8-staging-screens.spec.ts's, for the owner only.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { convertCorpus } from '../b8/convert-corpus.ts'
import { makeCorpus } from '../b8/corpus.ts'
import { convertedElements, openEnginePage, screenshotBoard } from '../b8/restore-check.ts'

let dir = ''
let boards: string[] = []

test.beforeAll(async () => {
  test.setTimeout(600_000)
  dir = mkdtempSync(join(tmpdir(), 'b8-screens-'))
  const made = await makeCorpus(join(dir, 'corpus'), ['tour', 'multipage', 'fixtures'])
  const res = await convertCorpus({
    corpus: join(dir, 'corpus'),
    work: join(dir, 'work'),
    mode: 'runtime',
    verifyLocalMode: false,
  })
  expect(res.filter((r) => !r.ok).map((r) => r.boardId)).toEqual([])
  boards = made.map((b) => b.boardId)
})

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('draws every converted generated board', async ({ page }, info) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  for (const boardId of boards) {
    await openEnginePage(page)
    await screenshotBoard(
      page,
      convertedElements(join(dir, 'work', 'rooms', `board-${boardId}.sqlite`)),
      info.outputPath(`${boardId}.png`),
    )
  }
})
