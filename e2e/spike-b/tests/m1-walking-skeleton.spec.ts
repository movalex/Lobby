// M1, the walking skeleton (docs/EXCALIDRAW-MIGRATION.md §8.6.4), the lead's integration spec. Two
// SEPARATE Chromium processes (A, B), each signed in as a different dev user, open the same board at
// /b/:id; a note is created and moved through the facade and by pointer (B's note tool, A's drag); after
// each step both maps (tombstones included) hash equal to the test snapshot and the invariant checker finds
// nothing; a third Chromium process (C, an editor that only watches) pushes 0 ops.
//
//   SPIKE_B_PORT_BASE=7850 pnpm --filter @draftroom/e2e spike-b m1-walking-skeleton
//
// (The arrow acceptance tests, M1's other half, run in the unit gate: `pnpm test:arrows`.)
import { expect, test } from '@playwright/test'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { allSaved, centreOf, closeWindow, everywhere, openWindow, writeEvidence } from '../support/checks.ts'
import { canvasOf, closeAllBrowsers, harness, writePushEvidence } from '../support/harness.ts'
import type { O3Stack } from '../support/stack.ts'

test.describe.configure({ mode: 'serial' })
test.setTimeout(10 * 60_000)

let stack: O3Stack
let A: O3BrowserProcess
let B: O3BrowserProcess
let C: O3BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  A = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })
  B = await harness.launchBrowser(stack, harness.devUser('B'), { name: 'B' })
  C = await harness.launchBrowser(stack, harness.devUser('C'), { name: 'C' })
  ;({ boardId } = await stack.createBoard({
    owner: A.user,
    members: [
      { user: B.user, role: 'editor' },
      { user: C.user, role: 'editor' },
    ],
    title: 'M1',
  }))
  for (const b of [A, B, C]) await b.openBoard(boardId)
})

test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

test('M1: create and move a note through the facade and by pointer; A, B, C converge; C pushes 0 ops', async () => {
  const info = test.info()
  const steps: Record<string, unknown>[] = []
  expect(A.browser, 'separate processes').not.toBe(B.browser)
  expect(A.user.handle).not.toBe(B.user.handle)
  const cPushes = await harness.recordPushes(C.page)
  const w0 = await openWindow(stack, boardId)

  // 1. A creates a note through the facade
  const n1 = await canvasOf(A.page).create('note', { x: 0, y: 0, text: 'm1 facade' })
  await everywhere([A, B, C], n1)
  await allSaved([A, B, C])
  let r = await closeWindow(stack, boardId, [A, B, C], w0)
  steps.push({ step: 'A creates n1 (facade)', hash: r.snapshot.hash, elements: r.snapshot.elements.length })

  // 2. B moves it through the facade
  await canvasOf(B.page).update(n1, { x: 300, y: 120 })
  await expect
    .poll(async () => (await canvasOf(A.page).get(n1))?.x, { message: 'A sees B facade move' })
    .toBe(300)
  await allSaved([A, B, C])
  r = await closeWindow(stack, boardId, [A, B, C], w0)
  expect(r.snapshot.elements.find((e) => e.id === n1)).toMatchObject({ x: 300, y: 120 })
  steps.push({ step: 'B moves n1 (facade)', hash: r.snapshot.hash })

  // 3. B creates a note by pointer: the note tool, a click on empty canvas, a word, Escape
  const before = new Set((await canvasOf(B.page).items()).map((e) => e.id))
  expect(await canvasOf(B.page).setTool('note'), 'B selects the note tool').toBe(true)
  const spot = await canvasOf(B.page).sceneToScreen({ x: 900, y: 200 })
  await B.page.mouse.click(spot.x, spot.y)
  let n2 = ''
  await expect
    .poll(
      async () => {
        const made = (await canvasOf(B.page).items()).filter(
          (e) => !before.has(e.id) && e.type !== 'text' && !e.isDeleted,
        )
        n2 = made[0]?.id ?? ''
        return made.length
      },
      { message: 'B placed one note by pointer' },
    )
    .toBe(1)
  await B.page.keyboard.type('m1 pointer')
  await B.page.keyboard.press('Escape')
  await everywhere([A, B, C], n2)
  await allSaved([A, B, C])
  r = await closeWindow(stack, boardId, [A, B, C], w0)
  steps.push({ step: 'B creates n2 (pointer)', hash: r.snapshot.hash })

  // 4. A drags n2 by pointer
  await canvasOf(A.page).setTool('select')
  await canvasOf(A.page).select([])
  const n2Before = r.snapshot.elements.find((e) => e.id === n2)
  const c = await centreOf(A, n2)
  await A.page.mouse.move(c.x, c.y)
  await A.page.mouse.down()
  for (let s = 1; s <= 10; s++) await A.page.mouse.move(c.x + s * 15, c.y + s * 8)
  await A.page.mouse.up()
  await expect
    .poll(async () => (await canvasOf(B.page).get(n2))?.x, { message: 'B sees A pointer drag' })
    .not.toBe(n2Before?.x)
  await allSaved([A, B, C])
  r = await closeWindow(stack, boardId, [A, B, C], w0)
  const n2After = r.snapshot.elements.find((e) => e.id === n2)
  expect(n2After?.x, 'stored n2 moved by the drag').not.toBe(n2Before?.x)
  expect(n2After?.x).toBe((await canvasOf(A.page).get(n2))?.x)
  steps.push({
    step: 'A drags n2 (pointer)',
    dx: (n2After?.x ?? 0) - (n2Before?.x ?? 0),
    hash: r.snapshot.hash,
  })

  // 5. A moves n1 by pointer too (a facade-made note under a real drag)
  const c1 = await centreOf(A, n1)
  await A.page.mouse.move(c1.x, c1.y)
  await A.page.mouse.down()
  for (let s = 1; s <= 8; s++) await A.page.mouse.move(c1.x - s * 10, c1.y + s * 10)
  await A.page.mouse.up()
  await expect
    .poll(async () => (await canvasOf(B.page).get(n1))?.x, { message: 'B sees n1 drag' })
    .not.toBe(300)
  await allSaved([A, B, C])
  r = await closeWindow(stack, boardId, [A, B, C], w0)
  steps.push({ step: 'A drags n1 (pointer)', hash: r.snapshot.hash, hashes: r.hashes })

  const ev = await writePushEvidence(info, 'C', cPushes)
  expect(ev.ops, 'C (receiving only) pushes 0 ops').toBe(0)
  writeEvidence(info, 'M1', { boardId, steps, cPushes: ev })
})
