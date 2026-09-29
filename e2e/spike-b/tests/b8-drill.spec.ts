// B8's rollback drill through the Excalidraw build (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "Rollback
// drill"): on the Lobby tour and the multi-page board (generated with the current build), A edits in a
// browser on the Excalidraw stack (base 7905), the R0 stand-in (7900) serves the same file and B edits
// through today's tldraw client, the room's open path rolls forward, twice. O4.
//
//   SPIKE_B_PORT_BASE=7905 pnpm --filter @draftroom/e2e spike-b b8-drill
//
// Needs M1/M2: O1's room calling O4's `MigrationService.prepare` on open, O2's board page, O3's harness
// and facade. Until then `node e2e/spike-b/b8/drill.ts` runs the same drill with A's edits written at the
// store level (docs/research/excalidraw/spike-b/B8.md says which run was which).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { makeCorpus } from '../b8/corpus.ts'
import { runDrill } from '../b8/drill.ts'
import { EXCALIDRAW_BASE, harnessSide } from '../b8/excalidraw-side.ts'
import { harness } from '../support/harness.ts'

let dir = ''
test.beforeAll(async () => {
  test.setTimeout(600_000)
  dir = mkdtempSync(join(tmpdir(), 'b8-drill-'))
  await makeCorpus(join(dir, 'corpus'), ['tour', 'multipage'])
})
test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

for (const board of ['b8-tour', 'b8-multipage'])
  test(`the rollback drill on ${board}, two cycles`, async ({ browserName: _browser }, info) => {
    test.setTimeout(600_000)
    const stack = await harness.startStack({
      base: EXCALIDRAW_BASE,
      engine: 'excalidraw',
      dataDir: join(dir, `data-${board}`),
    })
    try {
      const owner = harness.devUser('A')
      const { boardId } = await stack.createBoard({ owner })
      const side = harnessSide(stack, owner)
      try {
        const report = await runDrill({
          board: join(dir, 'corpus', `board-${board}.sqlite`),
          work: join(dir, `work-${board}`),
          dataDir: stack.dataDir,
          boardId,
          excalidraw: 'room',
          side,
        })
        writeFileSync(info.outputPath(`${board}.drill.json`), `${JSON.stringify(report, null, 1)}\n`)
        const failed = [...report.cycles.flatMap((c) => c.checks), ...report.bornAfter]
          .filter((c) => !c.pass)
          .map((c) => c.name)
        expect(failed).toEqual([])
      } finally {
        await side.close()
      }
    } finally {
      await stack.stop()
    }
  })
