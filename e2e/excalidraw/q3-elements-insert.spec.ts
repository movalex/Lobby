// Wave Q, WS3: the Elements panel on the real board page against the real api and sync server, turned on for the page
// by the dev-auth override (ELEMENTS_PANEL ships false until the lead's integration). The icons are the panel's dev
// test double until WS1's sets land (apps/web/src/features/elements/icons-double.ts): the insert path, the undo step,
// sync and the drop are what this spec proves, not the icon set. What must hold: the Elements panel takes the Shapes
// panel's dock place; a click inserts an icon at the middle of the view as native elements (kind 'icon') in one undo
// step, at the size and colour chosen, and a second tab sees it; the search narrows the tiles and the arrows plus
// Enter insert; an icon dragged into a frame lands in it, centred on the pointer; a shape from the Shapes tab is the
// piece; nothing leaves Lobby's own origins; a viewer has no panel.
//
//   E2E_PORT_BASE=7760 pnpm exec playwright test excalidraw/q3-elements-insert --project=chromium --workers=1   (from e2e/)
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  items,
  sceneToScreen,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { THEME_KEY } from '../tests/support/theme.ts'
import { makeFrame, withCanvas } from './l8-kit.ts'
import { undoKey } from './navigation-kit.ts'
import { foreignRequests, openElements, reloadWithElements, tab, tile, tileIds } from './q3-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const lobbyOf = (e: CanvasElement) =>
  (e.customData as { lobby?: { kind?: string; alt?: string } } | undefined)?.lobby
const iconEls = async (page: Page, alt?: string) =>
  (await items(page)).filter((e) => lobbyOf(e)?.kind === 'icon' && (!alt || lobbyOf(e)?.alt === alt))
const pieceEls = async (page: Page, kind: string) =>
  (await items(page)).filter((e) => lobbyOf(e)?.kind === kind)

/** The box of a set of elements (linear elements by their points). */
function boxOf(els: CanvasElement[]) {
  const xs: number[] = []
  const ys: number[] = []
  for (const e of els) {
    const pts = (e as { points?: [number, number][] }).points
    if (pts) for (const [px, py] of pts) xs.push(e.x + px), ys.push(e.y + py)
    else xs.push(e.x, e.x + e.width), ys.push(e.y, e.y + e.height)
  }
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

test('Q3: the Elements panel takes the Shapes panel’s place; a click inserts an icon in one undo step at the size and colour chosen; a second tab sees it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  await reloadWithElements(a.page)
  await expect(a.page.getByTestId('dock-tab-pieces')).toHaveCount(0)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await openElements(a.page)
  await expect(tab(a.page, 'icons')).toHaveAttribute('aria-selected', 'true')
  await expect(tile(a.page, 'icon', 'lucide:star')).toBeVisible({ timeout: 15_000 })
  const before = (await items(a.page)).length

  await test.step('a click on the star inserts it at the middle of the view, selected, as native elements', async () => {
    await tile(a.page, 'icon', 'lucide:star').click()
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: star')).length).toBe(1)
    const [star] = await iconEls(a.page, 'Lucide icon: star')
    if (!star) throw new Error('no star')
    expect(star.type).toBe('line')
    const v = await withCanvas(a.page, (c) => c.viewport.get(), undefined)
    const box = boxOf([star])
    expect(box.x + box.w / 2).toBeCloseTo(v.x + v.width / 2, -2)
    expect(box.y + box.h / 2).toBeCloseTo(v.y + v.height / 2, -2)
    expect(await withCanvas(a.page, (c) => [...c.selection], undefined)).toEqual([star.id])
    await expectSaved(a.page)
    await expect.poll(async () => (await iconEls(b.page, 'Lucide icon: star')).length).toBe(1)
  })

  await test.step('size L and red: the next icon is 192 px with a 16 px red stroke, all its parts one group', async () => {
    await a.page.locator('[data-testid="element-size"][data-size="L"]').click()
    await a.page.getByTestId('element-color').click()
    await a.page.locator('[data-testid="element-color-pick"][data-color="red"]').click()
    await expect(a.page.getByTestId('element-color')).toHaveAttribute('data-color', 'red')
    await tile(a.page, 'icon', 'lucide:arrow-right').click()
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: arrow-right')).length).toBe(2)
    const parts = await iconEls(a.page, 'Lucide icon: arrow-right')
    for (const p of parts) {
      expect(p.strokeColor).toBe('#e03131')
      expect(p.strokeWidth).toBe(16)
    }
    expect(new Set(parts.map((p) => (p.groupIds as string[]).join())).size).toBe(1)
    expect((parts[0]?.groupIds as string[]).length).toBe(1)
    const box = boxOf(parts)
    expect(box.w).toBeGreaterThan(100)
    expect(box.w).toBeLessThan(200)
    await expectSaved(a.page)
    // the choice is remembered for this viewer
    await a.page.getByTestId('dock-panel-close').click()
    await openElements(a.page)
    await expect(a.page.locator('[data-testid="element-size"][data-size="L"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  await test.step('one Ctrl+Z takes the whole arrow away, another the star; the second tab follows', async () => {
    await undoKey(a.page)
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: arrow-right')).length).toBe(0)
    expect((await iconEls(a.page, 'Lucide icon: star')).length).toBe(1)
    await undoKey(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(before)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })

  expect(foreign).toEqual([])
})

test('Q3: one search over the sources; the arrows and Enter insert; Escape clears the search', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await reloadWithElements(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await openElements(a.page)
  const search = a.page.getByTestId('element-search')
  await expect(tile(a.page, 'icon', 'lucide:star')).toBeVisible({ timeout: 15_000 })

  await test.step('"arrow" narrows the icons; the tabs count each source’s matches', async () => {
    await search.fill('arrow')
    await expect
      .poll(() => tileIds(a.page))
      .toEqual(['lucide:arrow-left', 'lucide:arrow-right', 'lucide:arrow-up'])
    await expect(tab(a.page, 'icons').locator('.dr-el__count')).toHaveText('3')
    await expect(search).toHaveAttribute('aria-activedescendant', /arrow-left$/)
  })

  await test.step('"decision" finds no icon: the panel points at the Shapes tab, which has it', async () => {
    await search.fill('decision')
    await expect(a.page.getByTestId('element-empty')).toContainText('No icons match.')
    await a.page.locator('[data-testid="element-other-tab"][data-tab="shapes"]').click()
    await expect(tab(a.page, 'shapes')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => tileIds(a.page)).toEqual(['decision'])
  })

  await test.step('Enter inserts the active shape; ArrowDown then Enter the next one of a longer list', async () => {
    await search.focus()
    await search.press('Enter')
    await expect.poll(async () => (await pieceEls(a.page, 'piece-decision')).length).toBe(2)
    await expectSaved(a.page)
    await search.fill('arrow')
    await tab(a.page, 'icons').click()
    await search.focus()
    await search.press('ArrowRight')
    // with something typed, Right moves the caret, not the tile
    await expect(search).toHaveAttribute('aria-activedescendant', /arrow-left$/)
    await search.fill('')
    await search.press('ArrowRight')
    await expect(search).not.toHaveAttribute('aria-activedescendant', /arrow-left$/)
    const second = await a.page
      .getByTestId('element-section-results')
      .getByTestId('element-tile')
      .nth(1)
      .getAttribute('data-tile-id')
    await search.press('Enter')
    const alt = `Lucide icon: ${second?.split(':')[1]}`
    await expect.poll(async () => (await iconEls(a.page, alt)).length).toBeGreaterThan(0)
  })

  await test.step('Escape clears what is typed, a second Escape closes the panel', async () => {
    await openElements(a.page)
    await a.page.getByTestId('element-search').fill('star')
    await a.page.getByTestId('element-search').press('Escape')
    await expect(a.page.getByTestId('element-search')).toHaveValue('')
    await a.page.getByTestId('element-search').press('Escape')
    await expect(a.page.getByTestId('elements-panel')).toHaveCount(0)
  })
})

test('Q3: an icon dragged into a frame lands in it, centred on the pointer, in one undo step; a shape dragged from the Shapes tab too', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await reloadWithElements(a.page)
  const frame = await makeFrame(a.page, 100, 100, 700, 600, 'Screen')
  await setViewport(a.page, { x: 0, y: 0, zoom: 0.6 })
  await openElements(a.page)
  await expect(tile(a.page, 'icon', 'lucide:house')).toBeVisible({ timeout: 15_000 })
  await expectSaved(a.page)

  const dragTo = async (source: 'icon' | 'piece', id: string, scene: { x: number; y: number }) => {
    const target = a.page.locator('.excalidraw').first()
    const box = await target.boundingBox()
    if (!box) throw new Error('no canvas box')
    const p = await sceneToScreen(a.page, scene)
    await tile(a.page, source, id).dragTo(target, { targetPosition: { x: p.x - box.x, y: p.y - box.y } })
  }

  await test.step('the house icon dropped on the frame: every part joins it, centred on the pointer', async () => {
    await dragTo('icon', 'lucide:house', { x: 400, y: 300 })
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: house')).length).toBe(2)
    const parts = await iconEls(a.page, 'Lucide icon: house')
    for (const p of parts) expect(p.frameId).toBe(frame)
    const box = boxOf(parts)
    expect(box.x + box.w / 2).toBeCloseTo(400, -1)
    expect(box.y + box.h / 2).toBeCloseTo(300, -1)
    await expectSaved(a.page)
    await expect.poll(async () => (await iconEls(b.page, 'Lucide icon: house')).length).toBe(2)
    for (const p of await iconEls(b.page, 'Lucide icon: house')) expect(p.frameId).toBe(frame)
  })

  await test.step('one Ctrl+Z removes the whole icon, and the second tab follows', async () => {
    await undoKey(a.page)
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: house')).length).toBe(0)
    await expect.poll(async () => (await iconEls(b.page, 'Lucide icon: house')).length).toBe(0)
  })

  await test.step('a Button dragged from the Shapes tab is the piece, in the frame', async () => {
    await tab(a.page, 'shapes').click()
    await dragTo('piece', 'button', { x: 450, y: 450 })
    await expect.poll(async () => (await pieceEls(a.page, 'piece-button')).length).toBe(2)
    for (const e of await pieceEls(a.page, 'piece-button')) expect(e.frameId).toBe(frame)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('Q3: a viewer has no Elements panel', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  await reloadWithElements(a.page)
  await v.page.context().addInitScript(() => localStorage.setItem('lobby.elementsPanel', '1'))
  await v.page.reload()
  await waitForCanvas(v.page)
  await expect(a.page.getByTestId('dock-tab-elements')).toBeVisible()
  await expect(v.page.getByTestId('dock-tab-elements')).toHaveCount(0)
  await expect(v.page.getByTestId('dock-tab-pieces')).toHaveCount(0)
})

test('Q3: in the dark theme the panel’s tiles are the panel’s own surfaces, never white cards', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await a.page.context().addInitScript((key) => localStorage.setItem(key, 'dark'), THEME_KEY)
  await reloadWithElements(a.page)
  await openElements(a.page)
  await tab(a.page, 'shapes').click()
  await expect(a.page.locator('[data-piece-preview="decision"] polygon')).toHaveCount(1, {
    timeout: 15_000,
  })
  const backgrounds = await a.page
    .locator('.dr-el-tile, .dr-el-tile__art')
    .evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))])
  for (const bg of backgrounds) expect(['rgb(255, 255, 255)', 'rgb(249, 250, 251)']).not.toContain(bg)
  await a.page.screenshot({ path: testInfo.outputPath('q3-dark-shapes.png') })
  await tab(a.page, 'icons').click()
  await expect(tile(a.page, 'icon', 'lucide:star')).toBeVisible({ timeout: 15_000 })
  // the icon drawings take the theme's ink
  const stroke = await a.page
    .locator('[data-icon-preview="lucide:star"] svg')
    .evaluate((e) => getComputedStyle(e).stroke)
  expect(stroke).not.toBe('rgb(0, 0, 0)')
  await a.page.screenshot({ path: testInfo.outputPath('q3-dark-icons.png') })
})
