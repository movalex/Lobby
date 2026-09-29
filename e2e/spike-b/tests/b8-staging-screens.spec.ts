// The owner's screenshots of the converted staging copies (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "Report:
// screenshots for the owner only", §8.6.7). Project `b8-staging` only; the files go to
// SPIKE_B8_DIR/owner-screens/ and are handed to the owner by path. Agents never open them.
//
//   SPIKE_B8_DIR=<spike-b8> TEMP=<spike-b8>/tmp-pw TMP=<spike-b8>/tmp-pw SPIKE_B_PORT_BASE=7905 \
//     B8_STAGING_ROOMS=<spike-b8>/work/convert-run1/rooms pnpm --filter @draftroom/e2e spike-b --project=b8-staging b8-staging-screens
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { convertedElements, openEnginePage, screenshotBoard } from '../b8/restore-check.ts'

const B8 = process.env.SPIKE_B8_DIR ?? ''
const rooms = process.env.B8_STAGING_ROOMS ?? join(B8, 'work', 'convert-run1', 'rooms')
const screens = join(B8, 'owner-screens')
const inside = (p: string) => {
  const r = relative(resolve(B8), resolve(p))
  return !!B8 && !!r && !r.startsWith('..') && !r.includes(':')
}

test('owner screenshots of the converted staging copies', async ({ page }) => {
  test.setTimeout(300_000)
  expect(inside(rooms) && inside(screens) && existsSync(rooms)).toBe(true)
  mkdirSync(screens, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 1000 })
  let n = 0
  for (const f of readdirSync(rooms)
    .filter((x) => /^board-.+\.sqlite$/.test(x))
    .sort()) {
    await openEnginePage(page)
    await screenshotBoard(
      page,
      convertedElements(join(rooms, f)),
      join(screens, `${f.slice(0, -'.sqlite'.length)}.png`),
    )
    n++
  }
  expect(n).toBeGreaterThan(0)
})
