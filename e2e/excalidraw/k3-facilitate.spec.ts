// K3-3 (wave K, UXD-01): one Facilitate button instead of the timer pill, the vote chip, the brainstorm chip,
// the raised-hands chip and the reactions button side by side, and no Export icon in the top bar (Board menu ▸
// Export ▸ Export… stays). The menu keeps the controls' test ids; the pill shows only what is live; each person
// sees the entries they saw before (features/workshops/ported/guest-chrome.ts facilitateEntries, unit-tested).
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { closeFacilitate, openFacilitate } from '../tests/support/workshops.ts'
import { openBoardExport } from './present-kit.ts'
import { expect, post, test, type WorkshopCanvasSession, waitForWorkshopBoard } from './workshops-kit.ts'

const menuIds = (page: Page) =>
  page
    .getByTestId('facilitate-menu')
    .locator('[role="menuitem"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))

/** A name-only guest who joined through an editor link, in a fresh desktop browser. */
async function guestOn(
  browser: Browser,
  owner: WorkshopCanvasSession,
  board: string,
  opened: BrowserContext[],
) {
  const r = await post(owner, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(r.status(), await r.text()).toBe(201)
  const { url } = (await r.json()) as { url: string }
  const context = await browser.newContext()
  opened.push(context)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByTestId('invite-guest-name').fill('Kai')
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForWorkshopBoard(page)
  return page
}

test('K3-3: one Facilitate button: its menu holds the tools, its pill shows only what is live; Export is in the board menu', async ({
  join,
  board,
  browser,
}, testInfo) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  const opened: BrowserContext[] = []
  try {
    await test.step('idle: "Facilitate" with no pill, and none of the old controls in the bar', async () => {
      const button = a.page.getByTestId('facilitate-button')
      await expect(button).toHaveText('Facilitate')
      await expect(button).toHaveAttribute('data-live', 'false')
      await expect(a.page.getByTestId('facilitate-pill')).toHaveCount(0)
      const bar = a.page.getByTestId('topbar')
      for (const id of [
        'timer-pill',
        'vote-chip',
        'reactions-button',
        'hands-chip',
        'pn-chip',
        'export-button',
      ])
        await expect(bar.getByTestId(id), id).toHaveCount(0)
      await expect(bar.getByTestId('present-button')).toBeVisible()
      await a.page.screenshot({
        path: testInfo.outputPath('k3-facilitate-idle.png'),
        clip: { x: 0, y: 0, width: 1280, height: 60 },
      })
    })

    await test.step('the menu: Timer, Reactions and raise hand, Voting, then the wave V entries, by keyboard too; Escape gives the button back', async () => {
      // Wave V adds its entries after the built-ins (workshops/ported/facilitate-entries.ts: Poll or word cloud,
      // Show join code, Breakouts). Each shows once its feature's store has loaded, so the menu is read until all
      // are there; then the keyboard part runs on a menu that is complete.
      const ALICE_MENU = [
        'timer-pill',
        'reactions-button',
        'vote-chip',
        'facilitate-activities',
        'facilitate-join-code',
        'breakouts-entry',
      ]
      await expect
        .poll(async () => {
          await openFacilitate(a.page)
          const ids = await menuIds(a.page)
          await closeFacilitate(a.page)
          return ids
        })
        .toEqual(ALICE_MENU)
      await a.page.getByTestId('facilitate-button').focus()
      await a.page.keyboard.press('Enter')
      await expect(a.page.getByTestId('facilitate-menu')).toBeVisible()
      expect(await menuIds(a.page)).toEqual(ALICE_MENU)
      await expect(a.page.getByTestId('timer-pill')).toBeFocused()
      await a.page.keyboard.press('ArrowDown')
      await expect(a.page.getByTestId('reactions-button')).toBeFocused()
      await a.page.keyboard.press('ArrowUp')
      await a.page.keyboard.press('ArrowUp') // wraps to the last
      await expect(a.page.getByTestId('breakouts-entry')).toBeFocused()
      await a.page.screenshot({ path: testInfo.outputPath('k3-facilitate-menu.png') })
      await a.page.keyboard.press('Escape')
      await expect(a.page.getByTestId('facilitate-menu')).toHaveCount(0)
      await expect(a.page.getByTestId('facilitate-button')).toBeFocused()
      // each entry opens what its control opened
      await (await openFacilitate(a.page)).getByTestId('timer-pill').click()
      await expect(a.page.getByTestId('workshop-popover')).toBeVisible()
      await a.page.keyboard.press('Escape')
      await (await openFacilitate(a.page)).getByTestId('reactions-button').click()
      await expect(a.page.getByTestId('reaction-bar')).toBeVisible()
      await a.page.keyboard.press('Escape')
      await (await openFacilitate(a.page)).getByTestId('vote-chip').click()
      await expect(a.page.getByTestId('vote-setup-dialog')).toBeVisible() // no vote yet: a new one's setup
      await a.page.keyboard.press('Escape')
      await expect(a.page.getByTestId('vote-setup-dialog')).toHaveCount(0)
    })

    await test.step('a viewer has "Session": the timer and the reactions (voting once a vote exists)', async () => {
      await expect(c.page.getByTestId('facilitate-button')).toHaveText('Session')
      await openFacilitate(c.page)
      expect(await menuIds(c.page)).toEqual(['timer-pill', 'reactions-button'])
      await closeFacilitate(c.page)
    })

    await test.step('a name-only guest while nothing runs: only the reactions', async () => {
      const g = await guestOn(browser, a, board, opened)
      await expect(g.getByTestId('facilitate-button')).toHaveText('Session')
      await openFacilitate(g)
      expect(await menuIds(g)).toEqual(['reactions-button'])
      await closeFacilitate(g)
    })

    await test.step('a timer and a vote run: the pill reads "m:ss · Vote" for everyone', async () => {
      expect(
        (await post(a, `/api/boards/${board}/timer`, { action: 'start', durationMs: 300_000 })).status(),
      ).toBe(200)
      const started = await post(a, `/api/boards/${board}/votes`, {
        votesPerPerson: 3,
        onePerObject: false,
        scope: 'board',
      })
      expect(started.status()).toBe(201)
      for (const p of [a.page, c.page]) {
        await expect(p.getByTestId('facilitate-pill')).toHaveText(/^[45]:\d\d·Vote$/)
        await expect(p.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', 'running')
        await expect(p.getByTestId('facilitate-button')).toHaveAttribute('data-live', 'true')
      }
      await openFacilitate(c.page)
      expect(await menuIds(c.page)).toEqual(['timer-pill', 'reactions-button', 'vote-chip'])
      await expect(c.page.getByTestId('vote-chip')).toContainText('Join')
      await closeFacilitate(c.page)
      await a.page.screenshot({
        path: testInfo.outputPath('k3-facilitate-live.png'),
        clip: { x: 0, y: 0, width: 1280, height: 60 },
      })
      // the timer stops: only the vote is left in the pill
      expect((await post(a, `/api/boards/${board}/timer`, { action: 'stop' })).status()).toBe(200)
      await expect(a.page.getByTestId('facilitate-pill')).toHaveText('Vote')
    })

    await test.step('Board menu ▸ Export ▸ Export… still opens the export dialog', async () => {
      await openBoardExport(a.page)
      await expect(a.page.getByTestId('export-dialog')).toBeVisible()
      await a.page.keyboard.press('Escape')
      await expect(a.page.getByTestId('export-dialog')).toHaveCount(0)
    })
  } finally {
    for (const ctx of opened) await ctx.close()
  }
})
