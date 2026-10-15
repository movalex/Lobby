// Wave L, W8: the surfaces this workstream adds pass the same axe audit the rest of the board does (WCAG 2.0 to
// 2.2 AA and best practice), in both themes: the Pieces panel with its list, search box and category chips; the
// sort popover in its three views; the scores' legend. Each scan is scoped to the surface itself, so another
// feature's finding is not this spec's to fix.
//
//   E2E_PORT_BASE=7580 pnpm exec playwright test excalidraw/l8-a11y --project=chromium --workers=1   (from e2e/)
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, expectSaved, select, test } from '../tests/support/canvas.ts'
import {
  fakeAi,
  makeFrame,
  makeNotes,
  sortRun,
  twelve,
  waitForSort,
  withShapesPanel,
} from './l8-kit.ts'

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

for (const colorScheme of ['light', 'dark'] as const) {
  test(`L8-3: the Pieces panel passes the axe audit, empty search and narrowed (${colorScheme})`, async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.emulateMedia({ colorScheme })
    await withShapesPanel(a.page)
    await a.page.getByTestId('dock-tab-pieces').click()
    await expect(a.page.getByTestId('pieces-panel')).toBeVisible()
    // the drawings are there before the audit looks
    await expect(a.page.locator('[data-piece-preview="decision"] polygon')).toHaveCount(1, {
      timeout: 15_000,
    })
    await expectClean(a.page, '[data-testid="pieces-panel"]', `pieces panel ${colorScheme}`)
    await a.page.getByTestId('piece-search').fill('card')
    await a.page.locator('[data-testid="piece-category"][data-category="agency"]').click()
    await expectClean(a.page, '[data-testid="pieces-panel"]', `pieces panel narrowed ${colorScheme}`)
    await a.page.getByTestId('piece-search').fill('zzzz')
    await expectClean(a.page, '[data-testid="pieces-panel"]', `pieces panel, nothing found ${colorScheme}`)
  })

  test(`L8-1/L8-2: the sort popover (its three views) and the scores' legend pass the axe audit (${colorScheme})`, async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await a.page.emulateMedia({ colorScheme })
    await waitForSort(a.page)
    const frame = await makeFrame(a.page, 0, 0, 2000, 1000, 'Retro')
    const ids = await makeNotes(a.page, twelve(60, 120), frame)
    await expectSaved(a.page)
    await fakeAi(a.page, { preview: 'apply' })
    await select(a.page, ids)
    await a.page.getByTestId('selection-sort').click()
    await expect(a.page.getByTestId('sort-menu')).toHaveAttribute('data-view', 'menu')
    await expectClean(a.page, '[data-testid="sort-menu"]', `sort menu ${colorScheme}`)
    await a.page.getByTestId('sort-by-lens').click()
    await expect(a.page.getByTestId('sort-menu')).toHaveAttribute('data-view', 'lens')
    await expectClean(a.page, '[data-testid="sort-menu"]', `sort lens view ${colorScheme}`)
    await a.page.getByTestId('sort-back').click()
    await a.page.getByTestId('sort-place').click()
    await expect(a.page.getByTestId('sort-menu')).toHaveAttribute('data-view', 'axes')
    await expectClean(a.page, '[data-testid="sort-menu"]', `sort axes view ${colorScheme}`)
    // the scores legend, after a placement
    await a.page.getByTestId('sort-axes-go').click()
    await a.page.getByTestId('sort-show-scores').click()
    await expect(a.page.getByTestId('sort-scores-legend')).toBeVisible()
    await expectClean(a.page, '[data-testid="sort-scores-legend"]', `scores legend ${colorScheme}`, 2)
    // the command toggles the same overlay
    expect(await sortRun(a.page, 'sort.scores')).toBe(true)
    await expect(a.page.getByTestId('sort-scores-legend')).toHaveCount(0)
  })
}
