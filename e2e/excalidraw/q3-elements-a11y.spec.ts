// Wave Q, WS3: the Elements panel's accessibility on the real board page (the panel on through the dev-auth override,
// the library through the route double of ./q3-kit.ts). What must hold: the panel passes the axe audit on each tab and
// in both themes, and the Save to library dialog too; the search box keeps the keyboard and names the active tile
// (aria-activedescendant), the tabs are a tablist the arrows move along, and the grid itself takes the keyboard.
//
//   E2E_PORT_BASE=7760 pnpm exec playwright test excalidraw/q3-elements-a11y --project=chromium --workers=1   (from e2e/)
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, items, select, test } from '../tests/support/canvas.ts'
import { THEME_KEY } from '../tests/support/theme.ts'
import { libraryDouble, openElements, reloadWithElements, tab, tile } from './q3-kit.ts'

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

test.use({ viewport: { width: 1280, height: 800 } })

/** One axe run limited to `selector`: nothing violated, and something was really checked. */
async function expectClean(page: Page, selector: string, label: string, minPasses = 5) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(AXE_TAGS).analyze()
  const violations = results.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id} [${v.impact}] ${n.target.join(' >> ')}: ${v.help}`),
  )
  expect(violations, `axe violations: ${label}`).toEqual([])
  expect(results.passes.length, `axe rules that passed: ${label}`).toBeGreaterThanOrEqual(minPasses)
}

for (const mode of ['light', 'dark'] as const) {
  test(`Q3: the Elements panel passes the axe audit on every tab, and the save dialog too (${mode})`, async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.context().addInitScript((v) => localStorage.setItem(v.key, v.mode), { key: THEME_KEY, mode })
    await libraryDouble(a.page)
    await reloadWithElements(a.page)
    await openElements(a.page)
    const panel = '[data-testid="elements-panel"]'
    // the shipped sets (wave Q integration): the first icons of the index
    await expect(a.page.locator('[data-testid="element-tile"][data-source="icon"]').first()).toBeVisible({
      timeout: 15_000,
    })
    await expectClean(a.page, panel, `icons (${mode})`)
    await a.page.getByTestId('element-color').click()
    await expectClean(a.page, panel, `icons with the colours open (${mode})`)
    await tab(a.page, 'shapes').click()
    await expect(a.page.locator('[data-piece-preview="decision"] polygon')).toHaveCount(1, {
      timeout: 15_000,
    })
    await expectClean(a.page, panel, `shapes (${mode})`)
    await a.page.getByTestId('element-search').fill('process')
    await tile(a.page, 'piece', 'process').click()
    await expect.poll(async () => (await items(a.page)).length).toBe(2)
    await a.page.getByTestId('element-search').fill('')
    await tab(a.page, 'library').click()
    await expect(a.page.getByTestId('element-empty')).toContainText('Nothing here yet')
    await expectClean(a.page, panel, `library, empty (${mode})`)
    const box = (await items(a.page)).find((e) => e.type === 'rectangle')
    await select(a.page, [box?.id as string])
    await a.page.getByTestId('selection-save-to-library').click()
    await expect(a.page.getByTestId('element-save-dialog')).toBeVisible()
    await expectClean(a.page, '[data-testid="element-save-dialog"]', `save dialog (${mode})`)
  })
}

test('Q3: the keyboard: the search box keeps it and names the active tile; the tabs and the grid take arrows', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await reloadWithElements(a.page)
  await openElements(a.page)
  const search = a.page.getByTestId('element-search')
  await expect(search).toBeFocused()
  // the shipped sets (wave Q integration): "arrow" lists the arrows first
  await search.fill('arrow')
  await expect(tile(a.page, 'icon', 'lucide:arrow-left')).toBeVisible({ timeout: 15_000 })
  const active = () => search.getAttribute('aria-activedescendant')
  const shown = await a.page
    .getByTestId('element-section-results')
    .getByTestId('element-tile')
    .evaluateAll((els) => els.map((e) => e.id))
  expect(await active()).toBe(shown[0])
  await search.press('ArrowRight')
  expect(await active()).toBe(shown[1])
  await search.press('ArrowDown')
  // four columns at this width: a row down from the second tile is the sixth
  const ids = await a.page
    .getByTestId('element-section-results')
    .getByTestId('element-tile')
    .evaluateAll((els) => els.map((e) => e.id))
  const cols = await a.page
    .locator('.dr-el-grid')
    .first()
    .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
  expect(await active()).toBe(ids[1 + cols])
  await expect(a.page.locator(`#${ids[1 + cols]}`)).toHaveAttribute('aria-selected', 'true')
  // the tabs: a tablist the arrows move along
  await tab(a.page, 'icons').focus()
  await a.page.keyboard.press('ArrowRight')
  await expect(tab(a.page, 'shapes')).toBeFocused()
  await expect(tab(a.page, 'shapes')).toHaveAttribute('aria-selected', 'true')
  // the grid itself takes the keyboard: Right moves even with a query typed
  await search.fill('d')
  await a.page.getByTestId('element-grid').focus()
  const before = await a.page.getByTestId('element-grid').getAttribute('aria-activedescendant')
  await a.page.keyboard.press('ArrowRight')
  expect(await a.page.getByTestId('element-grid').getAttribute('aria-activedescendant')).not.toBe(before)
  // the context-menu key opens the active tile's actions, Escape gives the keyboard back to the search box
  await a.page.keyboard.press('Shift+F10')
  await expect(a.page.getByTestId('element-menu')).toBeVisible()
  await expect(a.page.locator('[data-testid="element-menu"] [data-action="insert"]')).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('element-menu')).toHaveCount(0)
  await expect(search).toBeFocused()
})
