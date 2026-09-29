// B8's staging row "Opening the converted board in two browsers" (docs/EXCALIDRAW-MIGRATION.md §8.3 B8,
// §8.6.7): every restored staging copy, converted by the Excalidraw stack's room-open path, opened in two
// Chromium processes. Project `b8-staging` only; the stack's data dir inside SPIKE_B8_DIR; assertions and
// output carry board ids and counts only. O4 and V3 only. Needs M1 (see b8-two-browsers.spec.ts).
//
//   SPIKE_B8_DIR=<spike-b8> TEMP=<spike-b8>/tmp-pw TMP=<spike-b8>/tmp-pw SPIKE_B_PORT_BASE=7905 \
//     B8_RUN=1 pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-two-browsers
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { EXCALIDRAW_BASE, placeBoardFile } from '../b8/excalidraw-side.ts'
import { harness } from '../support/harness.ts'

const B8 = process.env.SPIKE_B8_DIR ?? ''
const inside = (p: string) => {
  const r = relative(resolve(B8), resolve(p))
  return !!B8 && !!r && !r.startsWith('..') && !r.includes(':')
}

test('every staging copy opens converted in two browsers: converged, 0 pushes', async () => {
  test.setTimeout(900_000)
  const run = process.env.B8_RUN ?? '1'
  const dataDir = join(B8, 'work', `two-browsers-run${run}`, 'data')
  expect(inside(dataDir)).toBe(true)
  const tmp = join(B8, 'tmp')
  const drill = readdirSync(tmp).find((d) => d.startsWith('dr-restore-drill-')) as string
  const rooms = join(tmp, drill, 'rooms')
  const stack = await harness.startStack({ base: EXCALIDRAW_BASE, engine: 'excalidraw', dataDir })
  const out: Record<string, unknown>[] = []
  try {
    const a = harness.devUser('A')
    const b = harness.devUser('B')
    const pa = await harness.launchBrowser(stack, a, { name: 'A' })
    const pb = await harness.launchBrowser(stack, b, { name: 'B' })
    try {
      for (const f of readdirSync(rooms)
        .filter((x) => x.endsWith('.sqlite'))
        .sort()) {
        const source = f.slice('board-'.length, -'.sqlite'.length)
        const { boardId } = await stack.createBoard({ owner: a, members: [{ user: b, role: 'editor' }] })
        placeBoardFile(stack, join(rooms, f), boardId)
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
        const row = {
          board: source,
          converted: report.ok,
          converged: conv.ok,
          violations: inv.violations.length,
          pushesA: await ra.count(),
          pushesB: await rb.count(),
        }
        out.push(row)
        expect(row).toEqual({
          board: source,
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
    writeFileSync(
      join(B8, 'reports', `b8-staging-two-browsers-run${run}.json`),
      `${JSON.stringify(out, null, 1)}\n`,
    )
    await stack.stop()
  }
})
