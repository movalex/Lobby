// Wave M (W4, M4-3, FTU-2): the Sort and AI popovers never open under the style panel, the bottom toolbar or the
// selection bar. They open in a layer of their own above the board's chrome, placed clear of it.
//  - Notes at the right of the view, under the style panel: Sort opens, and a press at the middle of each of its
//    options lands on that option (document.elementFromPoint), never on the style panel.
//  - A real click on "By colour" sorts the notes (their places change) and restyles nothing (no note's or label's
//    strokeColor or fontSize changes): the click never reaches the style panel's Small or a colour.
//  - The AI menu's last item can be pressed at 1440 x 900 and on a 390 x 844 phone (scrolled to inside the menu
//    when it is taller than its room), and the menu stops above the bottom toolbar.
//  - The AI preview's panel is not under the selection bar: its count line and its buttons are what a press hits.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m4-popovers.spec.ts --project=chromium --workers=1
import type { Locator, Page } from '@playwright/test'
import { LOBBY_PALETTE } from '../../packages/board-ops/src/elements/palette.ts'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  test as base,
  type CanvasElement,
  canvasCall,
  createNote,
  expect,
  expectSaved,
  items,
  setViewport,
  viewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiPreviewPanel,
  continueIfAsked,
  elementAt,
  FAKE_OPENAI_PORT_3H,
  foreignRequests,
  hitTestable,
  openAiMenu,
  selectIds,
  showBounds,
} from './ai-kit.ts'
import { showStylePanel } from './canvas-ux-kit.ts'

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

test.use({ apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

const YELLOW = LOBBY_PALETTE.yellow.noteFill
const BLUE = LOBBY_PALETTE['light-blue'].noteFill

/** Scene x of a client-px x at the current camera. */
async function sceneX(page: Page, clientX: number): Promise<number> {
  return (await canvasCall(page, 'screenToScene', { x: clientX, y: 0 })).x
}

/** Four notes in two colours at the right of the view, under the style panel's column; their ids. */
async function rightHandNotes(page: Page): Promise<string[]> {
  await setViewport(page, { x: 0, y: 0, zoom: 1 })
  const x0 = await sceneX(page, 1440 - 470)
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    ids.push(
      await createNote(page, {
        x: x0 + (i % 2) * 220,
        y: 160 + Math.floor(i / 2) * 220,
        text: `Idea ${i + 1}`,
        color: i % 2 ? BLUE : YELLOW,
        size: 200,
      }),
    )
    await expectSaved(page)
  }
  return ids
}

const styleOf = (all: readonly CanvasElement[], ids: readonly string[]) =>
  JSON.stringify(
    all
      .filter((e) => ids.includes(e.id) || ids.includes(String((e as { containerId?: string }).containerId)))
      .map((e) => [
        e.id,
        (e as { strokeColor?: string }).strokeColor,
        (e as { backgroundColor?: string }).backgroundColor,
        (e as { fontSize?: number }).fontSize ?? null,
      ])
      .sort(),
  )
const placesOf = (all: readonly CanvasElement[], ids: readonly string[]) =>
  JSON.stringify(all.filter((e) => ids.includes(e.id)).map((e) => [e.id, Math.round(e.x), Math.round(e.y)]))

test.describe('on a 1440 x 900 window', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('M4-3: Sort for the right-hand notes opens clear of the style panel; a press at each option’s middle lands on it, and By colour sorts without restyling', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    // P-021: the style panel opens on request; this person has it open
    await showStylePanel(a.page)
    const foreign = foreignRequests(a.page)
    const ids = await rightHandNotes(a.page)
    await selectIds(a.page, ids)
    const panel = a.page.locator('[data-lobby-slot="stylePanel"] [data-testid="style.panel"]')
    await expect(panel).toBeVisible()
    await a.page.getByTestId('selection-sort').click()
    const menu = a.page.getByTestId('sort-menu')
    await expect(menu).toBeVisible()

    await test.step('every option is what a press at its middle hits', async () => {
      const options = await menu.getByRole('menuitem').all()
      expect(options.length).toBeGreaterThanOrEqual(6)
      for (const o of options) {
        await o.scrollIntoViewIfNeeded()
        const box = await o.boundingBox()
        const at = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 }
        expect(await hitTestable(o), `${await o.textContent()} → ${await elementAt(a.page, at)}`).toBe(true)
      }
    })

    await test.step('the menu is clear of the style panel and the bottom toolbar (or the panel is folded away)', async () => {
      const m = await menu.boundingBox()
      const bar = await a.page.locator('[data-lobby-slot="toolbar"]').boundingBox()
      if (!m || !bar) throw new Error('no boxes')
      expect(apart(m, bar), 'clear of the bottom toolbar').toBe(true)
      const p = await panel.boundingBox()
      const shown = await panel.evaluate((el) => getComputedStyle(el).visibility !== 'hidden')
      if (p && shown) expect(apart(m, p), 'clear of the style panel').toBe(true)
    })

    await test.step('a real click on By colour sorts the notes and changes no colour or size', async () => {
      const before = await items(a.page)
      const option = menu.getByTestId('sort-by-colour')
      const box = await option.boundingBox()
      if (!box) throw new Error('no option')
      await a.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(a.page.getByTestId('sort-notice')).toBeVisible({ timeout: 15_000 })
      await expect(menu).toHaveCount(0)
      await expectSaved(a.page)
      const after = await items(a.page)
      expect(placesOf(after, ids)).not.toBe(placesOf(before, ids))
      expect(styleOf(after, ids)).toBe(styleOf(before, ids))
      expect(foreign).toEqual([])
    })
  })

  test('M4-3: the AI preview’s panel is not under the selection bar: its title, count line and buttons are what a press hits', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const ids = await fourNotes(a.page)
    await test.step('Group into themes on notes low in the view: the preview panel’s count line and buttons are what a press hits', async () => {
      // the selection fills the view down to just over the toolbar: the selection bar sits where the panel opened
      await showBounds(a.page, { x: -60, y: -60, w: 640, h: 640 })
      await selectIds(a.page, ids)
      await openAiMenu(a.page)
      await aiMenu(a.page).getByTestId('ai-themes').click()
      await continueIfAsked(a.page)
      const p = aiPreviewPanel(a.page)
      await expect(p).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(() => hitTestable(p.locator('.dr-ai-pop__title')), { message: 'its title' })
        .toBe(true)
      for (const id of ['ai-preview-summary', 'ai-preview-discard', 'ai-preview-retry', 'ai-preview-apply'])
        await expect.poll(() => hitTestable(p.getByTestId(id)), { message: id }).toBe(true)
      await p.getByTestId('ai-preview-discard').click()
      await expect(p).toHaveCount(0)
    })
  })

  test('M4-3: the AI menu’s last item can be pressed and the menu is clear of the toolbar, opened over the middle of the toolbar with just its height of room', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const ids = await fourNotes(a.page)
    await selectIds(a.page, ids)
    await aiMenuJustAboveToolbar(a.page, (l) => l.click(), { centre: true })
    await expectLastItemPressable(a.page)
  })
})

/** Four notes in a square, 260 apart (the M4-1 layout). */
async function fourNotes(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    ids.push(await createNote(page, { x: (i % 2) * 260, y: Math.floor(i / 2) * 260, text: `Step ${i}` }))
    await expectSaved(page)
  }
  return ids
}

/**
 * Opens the AI menu from the selection bar with the selection moved so that the menu's whole height just fits
 * between the bar and the canvas region's foot if the bottom toolbar is not counted (FTU-2: placed there, its last
 * rows were under the toolbar). The camera only moves; nothing is written.
 */
async function aiMenuJustAboveToolbar(
  page: Page,
  press: (l: Locator) => Promise<void>,
  opts: { centre?: boolean } = {},
) {
  const button = page.getByTestId('selection-ai')
  await press(button)
  const menu = aiMenu(page)
  await expect(menu).toBeVisible()
  const h = await menu.evaluate((el) => {
    const e = el as HTMLElement
    return e.scrollHeight + (e.offsetHeight - e.clientHeight)
  })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  const region = await page.locator('[data-lobby-board-canvas]').boundingBox()
  const bar = page.getByTestId('selection-bar')
  const before = await bar.boundingBox()
  if (!region || !before) throw new Error('no canvas region or selection bar')
  // the old placement put it below when the bar's foot was 22 px plus its height above the region's foot
  const target = region.y + region.height - 24 - h
  const v = await viewport(page)
  // centred: the AI button over the middle of the region, where the bottom toolbar is
  const ai = await button.boundingBox()
  const dx = opts.centre && ai ? region.x + region.width / 2 - (ai.x + ai.width / 2) : 0
  await setViewport(page, {
    x: v.x - dx / v.zoom,
    y: v.y - (target - (before.y + before.height)) / v.zoom,
    zoom: v.zoom,
  })
  await expect
    .poll(async () => {
      const b = await bar.boundingBox()
      return b ? Math.round(b.y + b.height - target) : null
    })
    .toBeLessThanOrEqual(2)
  await press(button)
  await expect(menu).toBeVisible()
}

/** The AI menu's last item: scrolled to inside the menu if need be, then what a press at its middle hits. */
async function expectLastItemPressable(page: Page) {
  const menu = aiMenu(page)
  const last = menu.getByRole('menuitem').last()
  await last.scrollIntoViewIfNeeded()
  const box = await last.boundingBox()
  const at = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 }
  expect(await hitTestable(last), `${await last.textContent()} → ${await elementAt(page, at)}`).toBe(true)
  const m = await menu.boundingBox()
  const bar = await page.locator('[data-lobby-slot="toolbar"]').boundingBox()
  if (m && bar && bar.width > 0) expect(apart(m, bar), 'the menu is clear of the bottom toolbar').toBe(true)
}

type Box = { x: number; y: number; width: number; height: number }
/** Two boxes that do not overlap (touching edges do not count). */
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x + 0.5 ||
  b.x + b.width <= a.x + 0.5 ||
  a.y + a.height <= b.y + 0.5 ||
  b.y + b.height <= a.y + 0.5

test.describe('on a 390 x 844 phone', () => {
  test('M4-3: the AI menu’s last item can be pressed on a phone', async ({ browser, board, users }) => {
    const alice = await users.get('alice')
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    try {
      const page = await context.newPage()
      await signInContext(context, alice.handle, alice.name)
      await page.goto(`/b/${board}`)
      await waitForCanvas(page)
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        ids.push(await createNote(page, { x: i * 150, y: 300, text: `Phone ${i}`, size: 140 }))
        await expectSaved(page)
      }
      await setViewport(page, { x: -40, y: 0, zoom: 1 })
      await selectIds(page, ids)
      await aiMenuJustAboveToolbar(page, (l) => l.tap())
      await expectLastItemPressable(page)
    } finally {
      await context.close()
    }
  })
})
