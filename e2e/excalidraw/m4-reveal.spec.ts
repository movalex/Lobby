// Wave M (W4, M4-4, FTU-8): new AI, paste and Pieces output lands in view, in free space, and not inside someone's
// frame; the camera move that shows it is this tab's alone.
//  - A Mermaid paste with the pointer near the bottom right: the prompt opens at the top of the view, and the
//    diagram ends wholly inside the safe part of the view (clear of the bottom toolbar and the style panel).
//    The camera move writes nothing: alice pushes only the diagram, and bob, who watches, pushes nothing and keeps
//    his own view.
//  - A Piece inserted with Enter while a 2x2 frame fills the middle of the view lands outside it (frameId null).
//  - After "Add as Recap frame" the recap panel folds to its header and its follow-ups (Copy, PDF, Add again), "Add
//    again" is no longer the primary button, and the frame is unobstructed: a press at its middle lands on the canvas.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m4-reveal.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  type CanvasElement,
  createItem,
  createNote,
  expect,
  expectSaved,
  items,
  pushedOps,
  sceneToScreen,
  setViewport,
  viewport,
} from '../tests/support/canvas.ts'
import { pushCount } from '../tests/support/excalidraw.ts'
import { AI_API_ENV_3H, elementAt, FAKE_OPENAI_PORT_3H, fakeAiRuns, foreignRequests } from './ai-kit.ts'
import { focusBoard } from './board-kit.ts'
import { sortRun, waitForSort } from './l8-kit.ts'
import { grantClipboard, writeClipboard } from './navigation-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

type Box = { x: number; y: number; width: number; height: number }

/** The camera has stopped (an animated move is over). */
const cameraStill = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __lobbyBoard?: { canvas: { viewport: { moving(): boolean } } } }
          ).__lobbyBoard?.canvas.viewport.moving() ?? false,
      ),
    )
    .toBe(false)

/** The screen box of scene elements `els` (their own boxes; client px). */
async function screenBox(page: Page, els: readonly CanvasElement[]): Promise<Box> {
  const tl = await sceneToScreen(page, {
    x: Math.min(...els.map((e) => e.x)),
    y: Math.min(...els.map((e) => e.y)),
  })
  const br = await sceneToScreen(page, {
    x: Math.max(...els.map((e) => e.x + e.width)),
    y: Math.max(...els.map((e) => e.y + e.height)),
  })
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
}

const within = (outer: Box, inner: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5

/** The part of the canvas region the chrome along its edges leaves (the bottom toolbar, the style panel). */
async function safePart(page: Page): Promise<Box> {
  const region = (await page.locator('[data-lobby-board-canvas]').boundingBox()) as Box
  let bottom = region.y + region.height
  let right = region.x + region.width
  const bar = await page.locator('[data-lobby-slot="toolbar"]').boundingBox()
  if (bar) bottom = Math.min(bottom, bar.y)
  const panel = page.locator('[data-lobby-slot="stylePanel"] [data-testid="style.panel"]')
  if ((await panel.count()) && (await panel.isVisible())) {
    const p = await panel.boundingBox()
    if (p) right = Math.min(right, p.x)
  }
  return { x: region.x, y: region.y, width: right - region.x, height: bottom - region.y }
}

const CHART = [
  'flowchart TD',
  '  A[Brief] --> B[Concept]',
  '  B --> C{Approved?}',
  '  C -->|no| B',
  '  C -->|yes| D[Production]',
  '  D --> E((Ship))',
].join('\n')

test('M4-4: a Mermaid paste near the bottom right asks at the top of the view and ends wholly in the safe view; the camera move writes nothing and bob’s view stays', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const bView = await viewport(b.page)
  const bPushes = await pushCount(b.page)
  await grantClipboard(a.context)
  await writeClipboard(a.page, { 'text/plain': CHART })
  await focusBoard(a.page)
  const region = (await a.page.locator('[data-lobby-board-canvas]').boundingBox()) as Box
  // the pointer near the bottom right corner, where the paste lands
  await a.page.mouse.move(region.x + region.width - 120, region.y + region.height - 110)
  await a.page.keyboard.press('ControlOrMeta+v')
  const prompt = a.page.getByTestId('mermaid-paste-prompt')
  await expect(prompt).toBeVisible()

  // where it asked (checked once the paste is done: the diagram's place is the first thing to judge)
  const asked = (await prompt.boundingBox()) as Box
  const pushes = (await pushedOps(a.page)).length
  await prompt.getByTestId('mermaid-paste-diagram').click()
  const shapes = async () =>
    (await items(a.page)).filter((e) => ['rectangle', 'diamond', 'ellipse'].includes(e.type))
  await expect.poll(async () => (await shapes()).length).toBe(5)
  await expectSaved(a.page)
  await cameraStill(a.page)

  await test.step('the diagram is wholly inside the safe part of the view', async () => {
    const all = await items(a.page)
    const made = all.filter((e) => ['rectangle', 'diamond', 'ellipse', 'arrow'].includes(e.type))
    expect(within(await safePart(a.page), await screenBox(a.page, made))).toBe(true)
  })

  await test.step('the prompt asked at the top of the view, in its middle', async () => {
    expect(asked.y - region.y).toBeLessThan(120)
    expect(Math.abs(asked.x + asked.width / 2 - (region.x + region.width / 2))).toBeLessThan(40)
  })

  await test.step('the camera move wrote nothing: one push for the diagram; bob pushed nothing and his view stayed', async () => {
    const recs = (await pushedOps(a.page)).slice(pushes)
    // the diagram's two writes (its shapes and connectors, then their binds and labels) are all alice sent
    expect(recs.length).toBeLessThanOrEqual(2)
    await expect.poll(async () => (await items(b.page)).filter((e) => e.type === 'diamond').length).toBe(1)
    expect(await pushCount(b.page)).toBe(bPushes)
    expect(await viewport(b.page)).toEqual(bView)
    expect(foreign).toEqual([])
  })
})

test('M4-4: a Piece inserted with Enter while a 2x2 frame fills the middle of the view lands outside it (frameId null)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.waitForFunction(() => !!document.querySelector('[data-testid="dock-tab-pieces"]'), undefined, {
    timeout: 30_000,
  })
  await setViewport(a.page, { x: 0, y: 0, zoom: 0.8 })
  const v = await viewport(a.page)
  // a 2x2 frame over the middle of the view
  const frame = await createItem(a.page, 'frame', {
    x: v.x + v.width / 2 - 600,
    y: v.y + v.height / 2 - 400,
    width: 1200,
    height: 800,
    name: 'Impact by Effort',
  })
  await expectSaved(a.page)
  await a.page.getByTestId('dock-tab-pieces').click()
  await expect(a.page.getByTestId('pieces-panel')).toBeVisible()
  await a.page.getByTestId('piece-search').fill('dec')
  await a.page.getByTestId('piece-search').press('Enter')
  const kindOf = (e: CanvasElement) =>
    (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind
  await expect
    .poll(async () => (await items(a.page)).filter((e) => kindOf(e) === 'piece-decision').length)
    .toBe(2)
  await expectSaved(a.page)
  const all = await items(a.page)
  const piece = all.filter((e) => kindOf(e) === 'piece-decision')
  for (const e of piece) expect(e.frameId ?? null, e.type).toBeNull()
  const f = all.find((e) => e.id === frame) as CanvasElement
  const d = piece.find((e) => e.type === 'diamond') as CanvasElement
  const apart = d.x + d.width <= f.x || f.x + f.width <= d.x || d.y + d.height <= f.y || f.y + f.height <= d.y
  expect(apart, 'the Decision is outside the 2x2 frame').toBe(true)
  // and in view once the camera is still
  await cameraStill(a.page)
  const region = (await a.page.locator('[data-lobby-board-canvas]').boundingBox()) as Box
  expect(within(region, await screenBox(a.page, [d]))).toBe(true)
})

test('M4-4: after Add as Recap frame the panel folds, Add again is secondary, and a press at the frame’s middle lands on the canvas', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForSort(a.page)
  for (const [i, text] of [
    'Summer beach screenings',
    'Solstice trailer drop',
    'Ski lodge premiere',
  ].entries()) {
    await createNote(a.page, { x: i * 260, y: 0, text })
    await expectSaved(a.page)
  }
  await setViewport(a.page, { x: -100, y: -100, zoom: 1 })
  await fakeAiRuns(a.page)
  expect(await sortRun(a.page, 'ai.recap', { scope: 'session' })).toBe(true)
  const cont = a.page.getByTestId('ai-notice-continue')
  const panel = a.page.locator('[data-testid="recap-panel"][data-status="done"]')
  await expect(cont.or(panel).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByTestId('recap-add')).toHaveClass(/dr-btn--primary/)
  await panel.getByTestId('recap-add').click()
  await expectSaved(a.page)

  await test.step('the panel folds to its header and its follow-ups; Add again is the lesser button', async () => {
    await expect(panel).toHaveAttribute('data-collapsed', '')
    await expect(panel.getByTestId('recap-added')).toBeVisible()
    await expect(panel.locator('.dr-ai-recap__body')).toHaveCount(0)
    const again = panel.getByTestId('recap-add')
    await expect(again).toHaveText('Add again')
    await expect(again).not.toHaveClass(/dr-btn--primary/)
  })

  await test.step('the frame is unobstructed: a press at its middle lands on the canvas', async () => {
    await cameraStill(a.page)
    const frame = (await items(a.page)).find(
      (e) => e.type === 'frame' && String(e.name).startsWith('Recap · '),
    ) as CanvasElement
    expect(frame).toBeTruthy()
    const mid = await sceneToScreen(a.page, { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 })
    const hit = await elementAt(a.page, mid)
    expect(hit, `a press at the frame's middle lands on ${hit}`).toMatch(/^canvas/)
  })

  await test.step('Show opens the whole recap again, Add again still the lesser button', async () => {
    await panel.getByTestId('recap-expand').click()
    await expect(panel).not.toHaveAttribute('data-collapsed', '')
    await expect(panel.locator('.dr-ai-recap__body')).toBeVisible()
    await expect(panel.getByTestId('recap-add')).not.toHaveClass(/dr-btn--primary/)
  })
})
