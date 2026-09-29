// B8 "Opening the converted board in two browsers: both converge; 0 pushes from either"
// (docs/EXCALIDRAW-MIGRATION.md §8.3 B8), on the generated corpus (the Lobby tour, the multi-page board,
// the heavy board, [DATA]'s 8 fixtures), converted by the Excalidraw stack's own room-open path. O4.
//
//   SPIKE_B_PORT_BASE=7905 pnpm --filter @draftroom/e2e spike-b b8-two-browsers
//
// Setup: a board row under a NEW id through the api, the tldraw board file copied to that id's path
// before the room opens (the room converts it on open), two separate Chromium processes signed in as two
// dev users. Pass: every hash equals the test snapshot's, the invariants hold, neither browser pushed an
// op, and the conversion report is ok. Needs M1 (O1's room, O2's page, O3's harness and facade).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type CorpusBoard, makeCorpus } from '../b8/corpus.ts'
import { EXCALIDRAW_BASE, placeBoardFile } from '../b8/excalidraw-side.ts'
import { harness } from '../support/harness.ts'

let dir = ''
let corpus: CorpusBoard[] = []
test.beforeAll(async () => {
  test.setTimeout(600_000)
  dir = mkdtempSync(join(tmpdir(), 'b8-two-'))
  corpus = await makeCorpus(join(dir, 'corpus'))
})
test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('every converted generated board opens in two browsers: converged, 0 pushes', async () => {
  test.setTimeout(900_000)
  const stack = await harness.startStack({
    base: EXCALIDRAW_BASE,
    engine: 'excalidraw',
    dataDir: join(dir, 'data'),
  })
  try {
    const a = harness.devUser('A')
    const b = harness.devUser('B')
    const pa = await harness.launchBrowser(stack, a, { name: 'A' })
    const pb = await harness.launchBrowser(stack, b, { name: 'B' })
    try {
      for (const board of corpus) {
        const { boardId } = await stack.createBoard({ owner: a, members: [{ user: b, role: 'editor' }] })
        placeBoardFile(stack, join(dir, 'corpus', board.file), boardId)
        const ra = await harness.recordPushes(pa.page)
        const rb = await harness.recordPushes(pb.page)
        await pa.openBoard(boardId)
        await pb.openBoard(boardId)
        const conv = await harness.converged(stack, boardId, [pa, pb])
        const inv = harness.checkInvariants(conv.snapshot)
        const report = JSON.parse(
          readFileSync(join(stack.dataDir, 'migration', `${boardId}.json`), 'utf8'),
        ) as {
          ok: boolean
        }
        expect({
          board: board.boardId,
          converted: report.ok,
          converged: conv.ok,
          violations: inv.violations.length,
          pushesA: await ra.count(),
          pushesB: await rb.count(),
        }).toEqual({
          board: board.boardId,
          converted: true,
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
    await stack.stop()
  }
})
