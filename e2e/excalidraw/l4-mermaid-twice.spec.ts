// L4-3 follow-up (wave L, the L-compat 3 flake): a second Mermaid paste on a board asks "Paste as diagram?" like the
// first, whatever the first left behind: its diagram still selected, one of its shapes selected (its + handles and
// the selection toolbar on screen), nothing selected, or the view moved away from it (as l-compat-rev11's second
// round does).
//
// The flake was the spec's, not the paste's: the first paste's bring-into-view (an animated camera move, 320 ms)
// was still running when the next round set the camera through the facade, which does not stop it; its next frame
// took the camera back to the first diagram, the click meant for empty canvas selected one of its shapes, and the
// selection toolbar then lay under the pointer, where Excalidraw takes no paste (index.js pasteFromClipboard: the
// element under the last pointer position must be its canvas). Every camera move here waits for the camera first.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l4-mermaid-twice --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  expect,
  expectSaved,
  items,
  saveState,
  select,
  selection,
  setViewport,
  test,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import {
  boundsOf,
  cameraIdle,
  focusCanvas,
  grantClipboard,
  viewport,
  writeClipboard,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** l-compat-rev11's chart: 8 nodes of mixed kinds, 8 links (three of them labelled). */
const CHART = [
  'flowchart TD',
  '  A[Brief] --> B{Approved?}',
  '  B -->|yes| C((Shoot))',
  '  B -->|no| D[/Rework/]',
  '  D --> A',
  '  C --> E[Edit]',
  '  E --> F[Grade]',
  '  F --> G[Mix]',
  '  G -->|final| H[Deliver]',
].join('\n')
const NODES = 8
const LINKS = 8

const prompt = (page: Page) => page.getByTestId('mermaid-paste-prompt')
const arrows = async (page: Page) => (await items(page)).filter((e) => e.type === 'arrow').length
const shapes = (all: readonly CanvasElement[]) =>
  all.filter((e) => e.type === 'rectangle' || e.type === 'diamond' || e.type === 'ellipse')

/** Ctrl+V of the chart, then Paste as diagram: 8 more connectors, Saved, nothing refused; the new shapes' ids. */
async function pasteDiagram(page: Page): Promise<string[]> {
  const before = new Set((await items(page)).map((e) => e.id))
  const n = await arrows(page)
  await writeClipboard(page, { 'text/plain': CHART })
  await page.keyboard.press('ControlOrMeta+v')
  await expect(prompt(page)).toBeVisible()
  await expect(prompt(page)).toContainText(`${NODES} shapes, ${LINKS} connectors`)
  await page.getByTestId('mermaid-paste-diagram').click()
  await expect(prompt(page)).toHaveCount(0)
  await expect.poll(() => arrows(page)).toBe(n + LINKS)
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
  return shapes(await items(page))
    .filter((e) => !before.has(e.id))
    .map((e) => e.id)
}

/**
 * The camera still, then moved so `ids` sit in the right half of the canvas; a screen point in its left half,
 * which is empty canvas.
 */
async function diagramOnTheRight(page: Page, ids: readonly string[]): Promise<{ x: number; y: number }> {
  await cameraIdle(page)
  const b = await boundsOf(page, ids)
  if (!b) throw new Error('no diagram bounds')
  const v = await viewport(page)
  await setViewport(page, { x: b.x - v.width * 0.6, y: b.y - 40, zoom: v.zoom })
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return { x: box.x + box.width * 0.2, y: box.y + box.height * 0.5 }
}

test.beforeEach(async () => {
  test.setTimeout(90_000)
})

test('two Mermaid pastes in a row, the first diagram still selected: the second asks too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await focusBoard(a.page)
  const first = await pasteDiagram(a.page)
  expect([...(await selection(a.page))].sort()).toEqual([...first].sort())
  const at = await diagramOnTheRight(a.page, first)
  await a.page.mouse.move(at.x, at.y)
  await focusCanvas(a.page)
  expect((await selection(a.page)).length).toBe(NODES)
  const second = await pasteDiagram(a.page)
  expect(second).toHaveLength(NODES)
})

test('two Mermaid pastes in a row, one shape of the first selected (its + handles and toolbar on screen): the second asks too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await focusBoard(a.page)
  const first = await pasteDiagram(a.page)
  const at = await diagramOnTheRight(a.page, first)
  await select(a.page, [first[5] as string])
  await a.page.mouse.move(at.x, at.y)
  await focusCanvas(a.page)
  await expect(a.page.getByRole('button', { name: 'Add a connected shape right' })).toBeVisible()
  await expect(a.page.getByRole('toolbar', { name: 'Selection' })).toBeVisible()
  await pasteDiagram(a.page)
})

test('two Mermaid pastes in a row, nothing selected after a click on empty canvas: the second asks too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await focusBoard(a.page)
  const first = await pasteDiagram(a.page)
  const at = await diagramOnTheRight(a.page, first)
  await a.page.mouse.click(at.x, at.y)
  await expect.poll(() => selection(a.page)).toEqual([])
  await focusCanvas(a.page)
  await pasteDiagram(a.page)
})

test('two Mermaid pastes in a row, the view moved away first (l-compat-rev11 W4’s second round): the second asks too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.6 })
  await focusBoard(a.page)
  await pasteDiagram(a.page)
  // the paste's bring-into-view may still be running: the facade's camera move does not stop it
  await cameraIdle(a.page)
  await setViewport(a.page, { x: 5_800, y: -200, zoom: 0.6 })
  await focusBoard(a.page)
  expect(await selection(a.page)).toEqual([])
  await pasteDiagram(a.page)
})
