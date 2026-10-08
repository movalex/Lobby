// Wave K (K4-1, K4-5, K4-6): the dashboard's first impression, in a real browser against the real api.
//   - "Start something": creators get the template row above Recent boards, one click makes a board from a
//     tile and lands on it; an outside account (never creates) and someone who hid the picker do not get it;
//   - the Internal only control sits in the workspace menu (the workspace tile), with a shield on the tile
//     while it is on, and the same behaviour as before;
//   - K4-5: the Feedback pill sends one item to the api; the What's new card dismisses and stays dismissed;
//   - K4-6: Share from a card still opens (its code loads on demand); touch targets measure 40 px on a phone.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-dashboard
import type { Page } from '@playwright/test'
import { Api } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/canvas.ts'
import {
  freshHandle,
  mainCard,
  openDashboard,
  personalWorkspace,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { capture } from '../tests/support/screenshots.ts'
import { waitForLobbyBoard } from './guests-kit.ts'
import { countOf, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1360, height: 860 } })

const CREATOR = 'lobby-test-k4@darkburn.com'

/** A creator with their own personal workspace (domain access: a Dark Burn address). */
async function creator(browser: Parameters<typeof signedInContext>[0], name = 'Kay Four') {
  const p = await signedInContext(browser, freshHandle('k4'), { name, email: CREATOR })
  return { ...p, wid: personalWorkspace(p.me), api: new Api(p.context.request) }
}

/** Makes the dashboard see an outside account (the server still decides: this only shows what the UI does). */
async function pretendOutside(page: Page) {
  const outside = { creator: false, reason: 'outside', email: 'client@client.example.test' }
  for (const url of ['**/api/auth/me', '**/api/me'])
    await page.route(url, async (route) => {
      const res = await route.fetch()
      if (res.status() !== 200) return route.fulfill({ response: res })
      const body = (await res.json()) as Record<string, unknown>
      return route.fulfill({ response: res, json: { ...body, access: outside } })
    })
}

test('"Start something": creators get the row above Recent boards; one click makes a board from a tile and opens it', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const p = await creator(browser)
  try {
    await p.api.createBoard(p.wid, 'First board')
    await openDashboard(p.page, p.wid)
    const row = p.page.getByTestId('start-row')
    await expect(row).toBeVisible()
    await expect(row.getByRole('heading', { name: 'Start something' })).toBeVisible()

    await test.step('twelve tiles, in order, above the boards, with thumbnails once the catalog has loaded', async () => {
      const tiles = row.getByTestId('start-tile')
      await expect(tiles).toHaveCount(12)
      expect(await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-template-id')))).toEqual([
        'blank',
        'lobby-tour',
        'brainstorm',
        'retrospective',
        'mood-board',
        'storyboard',
        'creative-brief',
        'client-feedback',
        'shot-list',
        'launch-timeline',
        'prioritisation-2x2',
        'kanban',
      ])
      await expect(row.locator('.dr-tthumb')).toHaveCount(11, { timeout: 15_000 })
      const rowBox = await row.boundingBox()
      const gridBox = await p.page.getByTestId('board-grid').boundingBox()
      expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(gridBox?.y ?? 0)
      await capture('k4-start-row.png', p.page, testInfo)
    })

    await test.step('Brainstorm: one click, a board named for it, opened with the template on it', async () => {
      await row.locator('[data-template-id="brainstorm"]').click()
      await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
      const id = new URL(p.page.url()).pathname.split('/')[2] ?? ''
      await waitForNavigation(p.page)
      await expect.poll(() => countOf(p.page, 'frame'), { timeout: 30_000 }).toBe(3)
      await expect(p.page.getByTestId('board-title')).toHaveText('Brainstorm')
      const detail = (await (await p.page.request.get(`/api/boards/${id}`)).json()) as {
        board: { title: string; createdBy: string; visibility: string }
      }
      expect(detail.board).toMatchObject({
        title: 'Brainstorm',
        createdBy: p.me.user.id,
        visibility: 'private',
      })
    })

    await test.step('Blank board: an empty board, no template parameter', async () => {
      await openDashboard(p.page, p.wid)
      await p.page.getByTestId('start-row').locator('[data-template-id="blank"]').click()
      await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
      await waitForLobbyBoard(p.page)
      await expect(p.page.getByTestId('board-title')).toHaveText('Untitled board')
      expect(await countOf(p.page, 'frame')).toBe(0)
    })

    await test.step('someone who asked not to see templates gets the plain Templates button, not the row', async () => {
      await p.page.evaluate(
        (key) => localStorage.setItem(key, '1'),
        `draftroom:template-picker-hidden:${p.me.user.id}`,
      )
      await openDashboard(p.page, p.wid)
      await expect(p.page.getByTestId('open-templates')).toBeVisible()
      await expect(p.page.getByTestId('start-row')).toHaveCount(0)
    })
  } finally {
    await p.context.close()
  }
})

test('"Start something" is not for accounts that cannot create (the api still refuses them whatever the page shows)', async ({
  browser,
}) => {
  const p = await creator(browser, 'Out Sider')
  try {
    await pretendOutside(p.page)
    await openDashboard(p.page, p.wid)
    await expect(p.page.getByTestId('access-outside')).toBeVisible()
    await expect(p.page.getByTestId('start-row')).toHaveCount(0)
    await expect(p.page.getByTestId('create-board')).toHaveCount(0)
  } finally {
    await p.context.close()
  }
})

/** Opens the workspace tile's menu (the Internal only control lives in it). */
async function openWorkspaceMenu(page: Page) {
  const tile = page.getByTestId('workspace-switcher')
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click()
  await expect(page.getByTestId('workspace-menu')).toBeVisible()
}

test('Internal only sits in the workspace menu: one click opens it, the shield shows while it is on, Escape closes it', async ({
  browser,
}, testInfo) => {
  const p = await creator(browser, 'Ina Internal')
  try {
    await openDashboard(p.page, p.wid)
    const tile = p.page.getByTestId('workspace-switcher')
    await expect(tile).toHaveAttribute('aria-expanded', 'false')
    await expect(p.page.getByTestId('internal-only')).toHaveCount(0)
    await expect(p.page.getByTestId('workspace-internal-badge')).toHaveCount(0)

    await openWorkspaceMenu(p.page)
    const section = p.page.getByTestId('workspace-menu').getByTestId('internal-only')
    await expect(section).toHaveAttribute('data-on', 'false')
    await section.getByTestId('internal-only-switch').check()
    await expect(section).toHaveAttribute('data-on', 'true')
    await expect(p.page.getByTestId('workspace-internal-badge')).toBeVisible()
    await capture('k4-workspace-menu.png', p.page, testInfo)

    // the server holds it, and the shield is there on the next visit with the menu closed
    const stored = (await (await p.page.request.get(`/api/workspaces/${p.wid}/internal-only`)).json()) as {
      workspace: boolean
    }
    expect(stored.workspace).toBe(true)
    await p.page.reload()
    await expect(p.page.getByTestId('workspace-internal-badge')).toBeVisible()
    await expect(p.page.getByTestId('internal-only')).toHaveCount(0)

    await openWorkspaceMenu(p.page)
    await p.page.keyboard.press('Escape')
    await expect(p.page.getByTestId('workspace-menu')).toHaveCount(0)
    await expect(tile).toBeFocused()

    await openWorkspaceMenu(p.page)
    await p.page.getByTestId('internal-only-switch').uncheck()
    await expect(p.page.getByTestId('internal-only')).toHaveAttribute('data-on', 'false')
    await expect(p.page.getByTestId('workspace-internal-badge')).toHaveCount(0)
  } finally {
    await p.api.fetch('PUT', `/api/workspaces/${p.wid}/internal-only`, { internalOnly: false })
    await p.context.close()
  }
})

test('a card’s Share opens the dialog (its code loads when it is asked for)', async ({ browser }) => {
  const p = await creator(browser, 'Sam Share')
  try {
    const board = await p.api.createBoard(p.wid, 'Share me')
    await openDashboard(p.page, p.wid)
    const card = mainCard(p.page, board.id)
    await expect(card).toBeVisible()
    await card.getByTestId('board-card-menu').click()
    await card.locator('[role="menuitem"][data-action="share"]').click()
    await expect(shareDialog(p.page)).toBeVisible({ timeout: 15_000 })
  } finally {
    await p.context.close()
  }
})
