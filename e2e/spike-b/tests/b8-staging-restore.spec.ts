// B8's staging row "restoreElements fixed point in the browser" (docs/EXCALIDRAW-MIGRATION.md §8.3,
// §8.6.7), on the restored staging copies converted by `e2e/spike-b/b8/convert-corpus.ts --staging`.
// Project `b8-staging` only (SPIKE_B8_DIR set: output inside it, traces, videos and screenshots off).
// O4 and V3 only.
//
//   SPIKE_B8_DIR=<spike-b8> TEMP=<spike-b8>/tmp-pw TMP=<spike-b8>/tmp-pw SPIKE_B_PORT_BASE=7905 \
//     B8_STAGING_ROOMS=<spike-b8>/work/convert-run1/rooms B8_STAGING_REPORT=<spike-b8>/reports/restore-run1.json \
//     pnpm --filter @draftroom/e2e spike-b --project b8-staging b8-staging-restore
//
// Everything it writes or asserts holds board ids, element ids, field names and counts only. The page
// never renders the boards (the elements go straight into restoreElements).
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { GEOMETRY_TOLERANCE_PX } from '../../../packages/canvas-schema/src/limits.ts'
import { convertedElements, openEnginePage, restoreFixedPoint, summarize } from '../b8/restore-check.ts'

const B8 = process.env.SPIKE_B8_DIR ?? ''
const rooms = process.env.B8_STAGING_ROOMS ?? join(B8, 'work', 'convert-run1', 'rooms')
const report = process.env.B8_STAGING_REPORT ?? join(B8, 'reports', 'b8-staging-restore.json')
const inside = (p: string) => {
  const r = relative(resolve(B8), resolve(p))
  return !!B8 && !!r && !r.startsWith('..') && !r.includes(':')
}

test('the converted staging copies are fixed points of restoreElements', async ({ page }) => {
  test.setTimeout(300_000)
  expect(inside(rooms) && inside(report)).toBe(true)
  expect(existsSync(rooms)).toBe(true)
  await openEnginePage(page)
  const out: Record<string, ReturnType<typeof summarize>> = {}
  for (const f of readdirSync(rooms)
    .filter((n) => /^board-.+\.sqlite$/.test(n))
    .sort()) {
    const boardId = f.slice('board-'.length, -'.sqlite'.length)
    out[boardId] = summarize(
      await restoreFixedPoint(page, convertedElements(join(rooms, f))),
      GEOMETRY_TOLERANCE_PX,
    )
  }
  writeFileSync(report, `${JSON.stringify(out, null, 1)}\n`)
  expect(Object.keys(out).length).toBeGreaterThan(0)
  for (const [board, s] of Object.entries(out))
    expect({ board, dropped: s.dropped, added: s.added, beyondTolerance: s.beyondTolerance }).toEqual({
      board,
      dropped: 0,
      added: 0,
      beyondTolerance: [],
    })
})
