// K5 (wave K): phone comfort on the Excalidraw board page, at 375 × 812 with touch (Playwright's mobile
// emulation reports `(pointer: coarse)`, as a phone does).
//
//  K5-2  Every field a phone types into is 16 px or more, so Safari on iPhone never zooms the page into it:
//        the comment composer, the Share dialog's invite field and selects, the dashboard search and the
//        board title rename. The sheets and the docked comment popover sit above the soft keyboard's
//        `--dr-kb-inset` (main.tsx). Not run here (no browser emulates a soft keyboard): a real iPhone's
//        and a real Android phone's keyboard; listed as not run in docs/PROGRESS.md.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/k5-phone.spec.ts --project=chromium --workers=1
import type { Locator, Page } from '@playwright/test'
import { expect, setTool, test } from '../tests/support/canvas.ts'
import { openDashboard } from '../tests/support/dashboard-share.ts'
import { openPhoneSession } from './a11y-kit.ts'

export const PHONE_375 = { width: 375, height: 812 }

const fontPx = (l: Locator) => l.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))

const coarse = (page: Page) => page.evaluate(() => matchMedia('(pointer: coarse)').matches)

test('K5-2: at 375 px on a touch screen every field is 16 px (no iOS zoom), and the docked comment sheet and panel sheets sit above the keyboard inset', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice', 'owner', PHONE_375)
  const page = a.page
  try {
    expect(await coarse(page)).toBe(true)

    await test.step('the board title rename field', async () => {
      await page.getByTestId('board-title').tap()
      const input = page.getByTestId('board-title-input')
      await expect(input).toBeVisible()
      expect(await fontPx(input)).toBeGreaterThanOrEqual(16)
      await page.keyboard.press('Escape')
      await expect(input).toHaveCount(0)
    })

    await test.step('the comment composer, docked at the bottom; lifted by the keyboard inset', async () => {
      await setTool(page, 'comment')
      const c = await page.locator('[data-lobby-board-canvas]').boundingBox()
      if (!c) throw new Error('no canvas')
      await page.touchscreen.tap(c.x + c.width / 2, c.y + c.height * 0.3)
      const popover = page.getByTestId('new-comment-popover')
      await expect(popover).toHaveAttribute('data-docked', 'true')
      const composer = popover.getByTestId('comment-composer')
      expect(await fontPx(composer)).toBeGreaterThanOrEqual(16)
      const before = await popover.boundingBox()
      if (!before) throw new Error('no popover box')
      // what main.tsx sets while Safari's keyboard covers the bottom 300 px of the layout viewport
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--dr-kb-inset', '300px')
        document.documentElement.setAttribute('data-dr-kb', '')
      })
      await expect
        .poll(async () => Math.round((await popover.boundingBox())?.y ?? 0))
        .toBeLessThan(Math.round(before.y))
      const lifted = await popover.boundingBox()
      if (!lifted) throw new Error('no popover box')
      // its bottom is 300 px higher (or more: it also got shorter), and its top stays on the canvas
      expect(lifted.y + lifted.height).toBeLessThanOrEqual(before.y + before.height - 300 + 1)
      expect(lifted.y).toBeGreaterThanOrEqual(c.y - 1)
      // the Post button is above the keyboard
      const post = popover.getByTestId('comment-submit')
      const p = await post.boundingBox()
      expect((p?.y ?? 9999) + (p?.height ?? 0)).toBeLessThanOrEqual(PHONE_375.height - 300)
      await page.screenshot({ path: testInfo.outputPath('k5-2-composer-above-keyboard.png') })
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--dr-kb-inset', '0px')
        document.documentElement.removeAttribute('data-dr-kb')
      })
      await expect
        .poll(async () => Math.round((await popover.boundingBox())?.y ?? 0))
        .toBe(Math.round(before.y))
      await page.keyboard.press('Escape')
      await expect(popover).toHaveCount(0)
      await setTool(page, 'select')
    })

    await test.step('a dock panel sheet (Comments) ends above the keyboard inset', async () => {
      await page.getByTestId('dock-rail-toggle').tap()
      await page.getByTestId('dock-tab-comments').tap()
      const panel = page.getByTestId('dock-panel-comments')
      await expect(panel).toBeVisible()
      const full = await panel.boundingBox()
      await page.evaluate(() => document.documentElement.style.setProperty('--dr-kb-inset', '300px'))
      await expect
        .poll(async () => Math.round(((await panel.boundingBox())?.height ?? 0) + 300))
        .toBe(Math.round(full?.height ?? 0))
      await page.evaluate(() => document.documentElement.style.setProperty('--dr-kb-inset', '0px'))
      await page.getByTestId('dock-panel-close').tap()
      await expect(panel).toHaveCount(0)
    })

    await test.step('the Share dialog: the invite field and every select', async () => {
      await page.getByTestId('share-button').tap()
      const dialog = page.getByTestId('share-dialog')
      await expect(dialog).toBeVisible()
      const input = dialog.getByTestId('share-invite-input')
      await expect(input).toBeVisible()
      expect(await fontPx(input)).toBeGreaterThanOrEqual(16)
      const sizes = await dialog
        .locator('select, input:not([type="checkbox"]), textarea')
        .evaluateAll((els) =>
          els.map((el) => ({
            id: el.getAttribute('data-testid') ?? el.tagName,
            px: Number.parseFloat(getComputedStyle(el).fontSize),
          })),
        )
      expect(sizes.length).toBeGreaterThan(2)
      expect(sizes.filter((s) => s.px < 16)).toEqual([])
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })

    await test.step('the dashboard search', async () => {
      await openDashboard(page, users.devStudioId)
      const search = page.getByTestId('dashboard-search')
      await expect(search).toBeVisible()
      expect(await fontPx(search)).toBeGreaterThanOrEqual(16)
    })
  } finally {
    await a.context.close()
  }
})

test('K5-2: on a desktop (a fine pointer) the fields keep their size', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const page = a.page
  expect(await coarse(page)).toBe(false)
  await page.getByTestId('share-button').click()
  const input = page.getByTestId('share-dialog').getByTestId('share-invite-input')
  await expect(input).toBeVisible()
  expect(await fontPx(input)).toBeLessThan(16)
})
