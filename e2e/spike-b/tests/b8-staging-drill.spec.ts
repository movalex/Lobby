// B8's rollback drill on the largest restored staging copy (64 records), through the Excalidraw build
// (docs/EXCALIDRAW-MIGRATION.md §8.3 B8, §8.6.7). Project `b8-staging` only; every data dir, temp dir,
// log and report stays inside SPIKE_B8_DIR; the report carries ids, group names, counts and hashes only.
// O4 and V3 only. Needs M1/M2 (see b8-drill.spec.ts).
//
//   SPIKE_B8_DIR=<spike-b8> TEMP=<spike-b8>/tmp-pw TMP=<spike-b8>/tmp-pw SPIKE_B_PORT_BASE=7905 \
//     pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-drill
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { runDrill } from '../b8/drill.ts'
import { EXCALIDRAW_BASE, harnessSide } from '../b8/excalidraw-side.ts'
import { harness } from '../support/harness.ts'

const B8 = process.env.SPIKE_B8_DIR ?? ''
const inside = (p: string) => {
  const r = relative(resolve(B8), resolve(p))
  return !!B8 && !!r && !r.startsWith('..') && !r.includes(':')
}
/** The largest restored copy (by records; by bytes as the proxy the file system gives). */
function largestCopy(): string {
  const tmp = join(B8, 'tmp')
  const drill = readdirSync(tmp).find((d) => d.startsWith('dr-restore-drill-'))
  if (!drill) throw new Error('no restored copies')
  const rooms = join(tmp, drill, 'rooms')
  const files = readdirSync(rooms).filter((f) => f.endsWith('.sqlite'))
  return join(
    rooms,
    files.sort((a, b) => statSync(join(rooms, b)).size - statSync(join(rooms, a)).size)[0] as string,
  )
}

test('the rollback drill on the largest staging copy, two cycles', async () => {
  test.setTimeout(600_000)
  const run = process.env.B8_RUN ?? '1'
  const work = join(B8, 'work', `drill-room-run${run}`)
  const dataDir = join(work, 'data')
  expect(inside(work)).toBe(true)
  const stack = await harness.startStack({ base: EXCALIDRAW_BASE, engine: 'excalidraw', dataDir })
  try {
    const owner = harness.devUser('A')
    const { boardId } = await stack.createBoard({ owner })
    const side = harnessSide(stack, owner)
    try {
      const report = await runDrill({
        board: largestCopy(),
        work,
        dataDir,
        boardId,
        excalidraw: 'room',
        side,
        staging: true,
      })
      writeFileSync(
        join(B8, 'reports', `b8-staging-drill-room-run${run}.json`),
        `${JSON.stringify(report, null, 1)}\n`,
      )
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
