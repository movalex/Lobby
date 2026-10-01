// B10 (docs/EXCALIDRAW-MIGRATION.md §8.3): echo. A and B each create 50 notes at the top of the order at
// the same time (both get keyBetween(max, null): the E2 index-collision case); C only watches. Pass: C
// pushes 0 ops, every live element's index key is unique, and all three maps (tombstones included)
// hash equal to the test snapshot, with 0 invariant violations. Three separate Chromium processes.
//
// The rest of B10 ("across B1-B9 every receiving-only browser and simulated client pushes 0 ops") is the
// aggregate of the push logs every owner's spec writes with writePushEvidence (support/pushes.ts), and of
// the load runs' receivers (e2e/load report `echo`): support/b10-aggregate.ts reads them into B10's
// evidence. 3 runs (SPIKE_B_RUN=1..3). Needs M1.
import { expect, test } from '@playwright/test'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { allSaved, closeWindow, openWindow, writeEvidence } from '../support/checks.ts'
import { canvasOf, closeAllBrowsers, harness, runTogether, writePushEvidence } from '../support/harness.ts'
import type { O3Stack } from '../support/stack.ts'

test.setTimeout(10 * 60_000)

let stack: O3Stack
let A: O3BrowserProcess
let B: O3BrowserProcess
let C: O3BrowserProcess

test.beforeAll(async () => {
  stack = await harness.startStack()
  A = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })
  B = await harness.launchBrowser(stack, harness.devUser('B'), { name: 'B' })
  C = await harness.launchBrowser(stack, harness.devUser('C'), { name: 'C' })
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

test('B10: 50 + 50 concurrent creates at the top of the order; the watcher pushes nothing', async () => {
  const testInfo = test.info()
  const { boardId } = await stack.createBoard({
    owner: A.user,
    members: [
      { user: B.user, role: 'editor' },
      { user: C.user, role: 'editor' },
    ],
    title: 'B10',
  })
  for (const b of [A, B, C]) await b.openBoard(boardId)
  // one note first, so both creators start from the same "max" index
  const seed = await canvasOf(A.page).create('note', { x: 0, y: 0 })
  await allSaved([A])
  await Promise.all([B, C].map((b) => b.page.waitForFunction((id) => !!window.lobbyCanvas?.get(id), seed)))
  const w = await openWindow(stack, boardId)
  const cPushes = await harness.recordPushes(C.page)
  const r = await runTogether<{ row: number }, string[]>([
    {
      name: 'A',
      page: A.page,
      arg: { row: 1 },
      fn: ({ row }) =>
        Array.from(
          { length: 50 },
          (_, k) => window.lobbyCanvas?.create('note', { x: k * 220, y: row * 240 }) as string,
        ),
    },
    {
      name: 'B',
      page: B.page,
      arg: { row: 2 },
      fn: ({ row }) =>
        Array.from(
          { length: 50 },
          (_, k) => window.lobbyCanvas?.create('note', { x: k * 220, y: row * 240 }) as string,
        ),
    },
  ])
  const created = r.parties.flatMap((p) => p.value)
  await Promise.all(
    [A, B, C].map((b) =>
      b.page.waitForFunction((ids) => ids.every((id) => !!window.lobbyCanvas?.get(id)), created, {
        timeout: 60_000,
      }),
    ),
  )
  await allSaved([A, B, C], 60_000)
  const report = await closeWindow(stack, boardId, [A, B, C], w, { timeoutMs: 60_000 })
  const live = report.snapshot.elements.filter((e) => !e.isDeleted)
  const keys = live.map((e) => e.index as string)
  const ev = await writePushEvidence(testInfo, 'C', cPushes)
  writeEvidence(testInfo, 'B10', {
    spreadMs: r.spreadMs,
    created: created.length,
    live: live.length,
    uniqueKeys: new Set(keys).size,
    receiverC: { pushes: ev.pushes, ops: ev.ops },
    hashes: report.hashes,
  })
  expect(r.spreadMs).toBeLessThanOrEqual(20)
  expect(created).toHaveLength(100)
  expect(new Set(keys).size, 'index keys unique').toBe(keys.length)
  expect(ev.ops, 'C pushes 0 ops').toBe(0)
})
