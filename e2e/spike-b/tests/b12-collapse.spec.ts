// B12, the mind-map collapse prototype (docs/EXCALIDRAW-MIGRATION.md §8.3, §4.7): the collapsed branch is
// hidden (labels and frame children named in the opacity override), cannot be clicked, and is left out of
// an export. Ctrl+A (Lobby-owned, O2's selectAll.ts consulting `registries.hidden`) selects everything
// else but none of the hidden items, and a box selection over the branch is post-filtered. Records the
// decision for wave 3d (B12.md).
//
// A collapses through the real chevron; B (a second Chromium process) sees the same branch hidden, from
// the synced `mindmap.collapsed` alone. B pushes 0 ops. Evidence: docs/research/excalidraw/spike-b/B12.md.
import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import {
  buildMindMap,
  centreOf,
  clientOf,
  featuresReady,
  hiddenSets,
  type MindMap,
  near,
  saved,
  seen,
  staticPixel,
} from './b7-b12-kit.ts'

test.describe.configure({ mode: 'serial' })

let stack: SpikeBStack
let A: BrowserProcess
let B: BrowserProcess
let boardId: string
let map: MindMap

const labelOf = (page: BrowserProcess['page'], id: string) =>
  page.evaluate((id) => {
    const el = window.lobbyCanvas?.get(id) as { boundElements?: { id: string; type: string }[] } | null
    return el?.boundElements?.find((b) => b.type === 'text')?.id ?? null
  }, id)

test.beforeAll(async () => {
  stack = await harness.startStack({ base: stackFromEnv().base })
  const alice = harness.devUser('b12c-alice')
  const bob = harness.devUser('b12c-bob')
  ;({ boardId } = await stack.createBoard({ owner: alice, members: [{ user: bob, role: 'editor' }] }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  B = await harness.launchBrowser(stack, bob, { name: 'B' })
  await A.openBoard(boardId)
  await B.openBoard(boardId)
  await featuresReady(A.page)
  await featuresReady(B.page)
  map = await buildMindMap(A.page)
  await saved(A.page)
  await seen([B], map.leaves[1])
})

test.afterAll(async () => {
  await B?.close()
  await A?.close()
  await stack?.stop()
})

test('collapse: hidden everywhere (labels included), not clickable, not in Ctrl+A or a box, not exported', async () => {
  const horizonAtStart = (await harness.readSnapshot(stack, boardId)).horizon
  const bPushes = await harness.recordPushes(B.page)
  const [l1, l2] = map.leaves
  const leafCentre = await centreOf(B.page, l1)
  const inkBefore = await staticPixel(B.page, leafCentre.x, leafCentre.y)

  // A collapses A1 through the chevron (one transact step: mindmap.collapsed on A1 only)
  await A.page.locator(`[data-lobby-collapse="${map.a1}"]`).click()
  await expect(A.page.locator(`[data-lobby-collapse="${map.a1}"]`)).toHaveAttribute('data-collapsed', '1')
  const expected = [l1, l2, map.edges[l1] as string, map.edges[l2] as string].sort()
  for (const p of [A, B]) await expect.poll(async () => (await hiddenSets(p.page)).computed).toEqual(expected)
  // the overrides name the labels too (a container at opacity 0 still draws its label, A10)
  const labels = [await labelOf(B.page, l1), await labelOf(B.page, l2)].filter((x): x is string => !!x)
  const overrides = (await hiddenSets(B.page)).overrides
  for (const id of [...expected, ...labels]) expect(overrides).toContain(id)
  expect(overrides).not.toContain(map.a1)
  // not drawn on B: the leaf's spot shows the background now
  await expect
    .poll(async () => near(await staticPixel(B.page, leafCentre.x, leafCentre.y), [255, 255, 255], 12))
    .toBe(true)
  expect(near(inkBefore, [255, 255, 255], 12)).toBe(false)

  // cannot be clicked (nothing visible lies under the leaf)
  await B.page.mouse.click(leafCentre.x, leafCentre.y)
  expect(await B.page.evaluate(() => window.lobbyCanvas?.selection() ?? [])).toEqual([])
  await B.page.mouse.dblclick(leafCentre.x, leafCentre.y)
  expect(await B.page.evaluate(() => window.lobbyCanvas?.editingId())).toBeNull()
  expect(await B.page.locator('textarea.excalidraw-wysiwyg').count()).toBe(0)

  // Ctrl+A (O2's selectAll consults registries.hidden): everything else, none of the hidden items
  await B.page.mouse.click(5, 300) // focus the board on an empty spot
  await B.page.keyboard.press('Control+A')
  const all = await B.page.evaluate(() => window.lobbyCanvas?.selection() ?? [])
  for (const id of [map.root, map.a1, map.a2, map.edges[map.a1] as string]) expect(all).toContain(id)
  for (const id of [...expected, ...labels]) expect(all).not.toContain(id)
  await B.page.keyboard.press('Escape')

  // a box selection over the whole map is post-filtered
  const from = await clientOf(B.page, 20, 60)
  const to = await clientOf(B.page, 1100, 900)
  await B.page.mouse.move(from.x, from.y)
  await B.page.mouse.down()
  await B.page.mouse.move(to.x, to.y, { steps: 12 })
  await B.page.mouse.up()
  const boxed = await B.page.evaluate(() => window.lobbyCanvas?.selection() ?? [])
  expect(boxed).toContain(map.a2)
  for (const id of [...expected, ...labels]) expect(boxed).not.toContain(id)
  await B.page.keyboard.press('Escape')

  // left out of an export (the SVG carries each visible label's text, none of the hidden ones')
  const svg = await B.page.evaluate(() => window.lobbySpikeFeatures?.exportSvg())
  expect(svg?.text).toContain('Topic A1')
  expect(svg?.text).toContain('Topic A2')
  expect(svg?.text).not.toContain('Leaf one')
  expect(svg?.text).not.toContain('Leaf two')

  // B wrote nothing; the only write was A's collapse; everyone converges
  expect(await bPushes.count()).toBe(0)
  const report = await harness.converged(stack, boardId, [A, B], { horizonAtStart })
  expect(report.ok).toBe(true)
  expect(report.horizonMoved).toBe(false)
  expect(harness.checkInvariants(report.snapshot).violations).toEqual([])
  const stored = report.snapshot.elements.find((e) => e.id === map.a1) as {
    customData?: { lobby?: { mindmap?: { collapsed?: boolean } } }
  }
  expect(stored?.customData?.lobby?.mindmap?.collapsed).toBe(true)

  // expanding brings the branch back on both
  await A.page.locator(`[data-lobby-collapse="${map.a1}"]`).click()
  for (const p of [A, B]) await expect.poll(async () => (await hiddenSets(p.page)).overrides).toEqual([])
  await expect
    .poll(async () => near(await staticPixel(B.page, leafCentre.x, leafCentre.y), inkBefore, 30))
    .toBe(true)
  console.log(
    'B12-METRICS collapse',
    JSON.stringify({
      hidden: expected.length,
      labels: labels.length,
      ctrlA: all.length,
      boxed: boxed.length,
      svgBytes: svg?.bytes,
      bPushes: await bPushes.count(),
    }),
  )
})
