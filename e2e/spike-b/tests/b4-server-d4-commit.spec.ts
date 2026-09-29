// B4 D4 (docs/EXCALIDRAW-MIGRATION.md §8.3): an injected COMMIT failure (the test hook POST …/fail-commit).
// Pass: the push is answered UNAVAILABLE; the client retries (the room reopens its file and every session
// gets 4000 RECONNECT); nothing is lost; "Saved" shows only after the retry succeeded. Owner: O1 (server
// half; the Saved indicator is O2's page).

import { expect, test } from '@playwright/test'
import type {} from '../../../apps/web/src/canvas/test-facade.types.ts' // window.lobbyCanvas
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { storedElement } from './b6-forge-kit.ts'

let stack: SpikeBStack
let A: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  const ua = harness.devUser('d4-alice')
  ;({ boardId } = await stack.createBoard({ owner: ua }))
  A = await harness.launchBrowser(stack, ua, { name: 'A' })
  await A.openBoard(boardId)
})
test.afterAll(async () => {
  await A?.close()
  await stack?.stop()
})

test('D4: COMMIT failure → UNAVAILABLE, retry, nothing lost, Saved only after success', async () => {
  const id = await A.page.evaluate(
    () => window.lobbyCanvas?.create('rectangle', { x: 10, y: 10, width: 80, height: 60 }) ?? '',
  )
  await expect.poll(() => A.page.evaluate(() => window.lobbyCanvas?.saveState().state)).toBe('saved')
  const kept = await storedElement(stack, boardId, id)
  expect(kept).not.toBeNull()

  await harness.testHooks(stack).failNextCommits(boardId, 1)
  await A.page.evaluate((el) => window.lobbyCanvas?.update(el, { x: 400, y: 300 }), id)
  // the indicator may say Saving… or retrying, never Saved, until the move is on disk
  const seen: string[] = []
  const deadline = Date.now() + 30_000
  for (;;) {
    const state = await A.page.evaluate(() => window.lobbyCanvas?.saveState().state ?? 'none')
    seen.push(state)
    const stored = await storedElement(stack, boardId, id)
    if (state === 'saved') {
      expect(stored).toMatchObject({ x: 400, y: 300 })
      break
    }
    if (Date.now() > deadline) throw new Error(`never saved: ${[...new Set(seen)].join(',')}`)
    await A.page.waitForTimeout(20)
  }
  expect(seen.some((s) => s !== 'saved')).toBe(true)
  const conv = await harness.converged(stack, boardId, [A])
  expect(conv.ok).toBe(true)
  test.info().annotations.push({ type: 'D4', description: JSON.stringify([...new Set(seen)]) })
})
