// B12, the hit guard's gaps (docs/EXCALIDRAW-MIGRATION.md §8.3, §2.7; spike A10's three gaps):
//  - the cursor over a hidden element and over one under a remote preview is `default`, not `move`;
//  - under touch emulation, a tap, a double-tap and a long-press on a hidden element do nothing: no
//    selection, no editor, no acquire, no context menu;
//  - a click on a remote-dragged note's old spot, where a visible element lies underneath, selects that
//    element and shows "Bob is moving this";
//  - after a collapse whose re-layout moves a visible sibling over the hidden branch, a click on the
//    sibling selects the sibling.
//
// A (desktop, editor), B ("Bob", desktop, editor: drags a note and holds it), T (a touch browser, editor).
// Evidence: docs/research/excalidraw/spike-b/B12.md.
import { expect, type Page, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import {
  buildMindMap,
  centreOf,
  createNote,
  featuresReady,
  hiddenSets,
  type MindMap,
  saved,
  seen,
} from './b7-b12-kit.ts'

test.describe.configure({ mode: 'serial' })

let stack: SpikeBStack
let A: BrowserProcess
let B: BrowserProcess
let T: BrowserProcess
let boardId: string
let map: MindMap

const canvasCursor = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive')
    return c ? getComputedStyle(c).cursor : 'none'
  })
const selection = (page: Page) => page.evaluate(() => window.lobbyCanvas?.selection() ?? [])

test.beforeAll(async () => {
  stack = await harness.startStack({ base: stackFromEnv().base })
  const alice = harness.devUser('b12g-alice')
  const bob = { ...harness.devUser('b12g-bob'), name: 'Bob' }
  const tess = harness.devUser('b12g-tess')
  ;({ boardId } = await stack.createBoard({
    owner: alice,
    members: [
      { user: bob, role: 'editor' },
      { user: tess, role: 'editor' },
    ],
  }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  B = await harness.launchBrowser(stack, bob, { name: 'B' })
  T = await harness.launchBrowser(stack, tess, {
    name: 'T',
    touch: true,
    viewport: { width: 1024, height: 768 },
  })
  for (const p of [A, B, T]) {
    await p.openBoard(boardId)
    await featuresReady(p.page)
  }
  map = await buildMindMap(A.page)
  await saved(A.page)
  await seen([B, T], map.leaves[1])
  await A.page.evaluate((id) => window.lobbySpikeFeatures?.collapse(id, true), map.a1)
  for (const p of [A, B, T]) await expect.poll(async () => (await hiddenSets(p.page)).computed.length).toBe(4)
})

test.afterAll(async () => {
  await T?.close()
  await B?.close()
  await A?.close()
  await stack?.stop()
})

test('the cursor over a hidden element, and over one under a remote preview, is default (not move)', async () => {
  const leaf = await centreOf(A.page, map.leaves[0])
  await A.page.mouse.move(leaf.x + 3, leaf.y + 3)
  await A.page.mouse.move(leaf.x, leaf.y)
  await expect.poll(() => canvasCursor(A.page)).toBe('default')
  await expect
    .poll(() => A.page.evaluate(() => document.querySelector('.lobby-hit-blocked') !== null))
    .toBe(true)
  // over a visible topic the rule is off (Excalidraw's own cursor)
  const topic = await centreOf(A.page, map.a2)
  await A.page.mouse.move(topic.x, topic.y)
  await expect
    .poll(() => A.page.evaluate(() => document.querySelector('.lobby-hit-blocked') !== null))
    .toBe(false)

  // a remote preview: B drags note M and holds it
  const m = await createNote(B.page, 1300, 120, 'Bob moves me')
  await saved(B.page)
  await seen([A], m)
  const mB = await centreOf(B.page, m)
  await B.page.mouse.move(mB.x, mB.y)
  await B.page.mouse.down()
  await B.page.mouse.move(mB.x + 150, mB.y + 40, { steps: 8 })
  try {
    const mA = await centreOf(A.page, m) // the document position (the drawing moved)
    await expect
      .poll(
        async () => {
          await A.page.mouse.move(mA.x + 1, mA.y)
          await A.page.mouse.move(mA.x, mA.y)
          return canvasCursor(A.page)
        },
        { timeout: 10_000 },
      )
      .toBe('default')
  } finally {
    await B.page.mouse.up()
  }
})

test('touch: a tap, a double-tap and a long-press on a hidden element do nothing', async () => {
  const pushes = await harness.recordPushes(T.page)
  const leaf = await centreOf(T.page, map.leaves[0])
  await T.page.touchscreen.tap(leaf.x, leaf.y)
  expect(await selection(T.page)).toEqual([])
  // a double-tap: two taps within the engine's 300 ms window
  await T.page.touchscreen.tap(leaf.x, leaf.y)
  await T.page.waitForTimeout(80)
  await T.page.touchscreen.tap(leaf.x, leaf.y)
  await T.page.waitForTimeout(400)
  expect(await T.page.evaluate(() => window.lobbyCanvas?.editingId())).toBeNull()
  expect(await T.page.locator('textarea.excalidraw-wysiwyg').count()).toBe(0)
  expect(await T.page.evaluate(() => window.lobbyCanvas?.leaseState().pending ?? [])).toEqual([])
  expect(await T.page.evaluate(() => window.lobbyCanvas?.leaseState().held ?? [])).toEqual([])
  // a long-press (CDP touch events held 900 ms): no context menu, no selection
  const cdp = await T.context.newCDPSession(T.page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: leaf.x, y: leaf.y }] })
  await T.page.waitForTimeout(900)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await T.page.waitForTimeout(300)
  expect(await T.page.locator('.context-menu, [data-testid="context-menu"]').count()).toBe(0)
  expect(await selection(T.page)).toEqual([])
  expect(await pushes.count()).toBe(0)
  // a visible topic still takes a tap
  const topic = await centreOf(T.page, map.a2)
  await T.page.touchscreen.tap(topic.x, topic.y)
  await expect.poll(() => selection(T.page)).toEqual([map.a2])
})

test("the dead zone: a click on a remote-dragged note's old spot selects the visible note under it and says who moves it", async () => {
  // U lies under M (M created later, on top); B drags M away and holds it
  const u = await createNote(A.page, 1300, 500, 'Under')
  const m = await createNote(A.page, 1320, 520, 'Moving')
  await saved(A.page)
  await seen([B], m)
  const mB = await centreOf(B.page, m)
  await B.page.mouse.move(mB.x, mB.y)
  await B.page.mouse.down()
  await B.page.mouse.move(mB.x + 260, mB.y + 20, { steps: 10 })
  try {
    // a point of M's old spot that U covers too
    const uA = await centreOf(A.page, u)
    await expect
      .poll(
        async () => {
          await A.page.mouse.click(uA.x, uA.y)
          return selection(A.page)
        },
        { timeout: 10_000 },
      )
      .toEqual([u])
    await expect(A.page.locator('[data-lobby-hit-toast]')).toContainText('Bob is moving this')
  } finally {
    await B.page.mouse.up()
  }
})

test('a visible sibling moved over the hidden branch: a click on it selects the sibling', async () => {
  // the "re-layout": A2 (created before the leaves, so below them) moves over Leaf one
  const leafBounds = await A.page.evaluate((id) => window.lobbyCanvas?.bounds(id), map.leaves[0])
  await A.page.evaluate(({ id, x, y }) => window.lobbyCanvas?.update(id, { x, y }), {
    id: map.a2,
    x: (leafBounds?.x ?? 0) + 20,
    y: (leafBounds?.y ?? 0) + 20,
  })
  await saved(A.page)
  const a2 = await centreOf(B.page, map.a2)
  // Excalidraw's own pick at that point is the hidden leaf (it sorts above A2); the guard selects A2
  await expect
    .poll(
      async () => {
        await B.page.mouse.click(a2.x, a2.y)
        return selection(B.page)
      },
      { timeout: 10_000 },
    )
    .toEqual([map.a2])
  const report = await harness.converged(stack, boardId, [A, B, T])
  expect(report.ok).toBe(true)
  expect(harness.checkInvariants(report.snapshot).violations).toEqual([])
})
