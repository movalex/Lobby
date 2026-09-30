// OWNER: 2C. The board page's corner chrome on narrow screens (the host slots' places, canvas/board/chrome.tsx
// and board.css): on a phone and a small tablet no slot covers another's buttons. Found porting the guest
// specs and R13 (a11y-phone-overlays.spec.ts): on a phone the dock's fold button sat on the board menu, and
// up to about 770 px an editor's toolbar ran under the navigation panel's corner (its first tools could not
// be clicked). The tldraw page laid these out in one flex layout; here each slot is placed on its own.
import type { Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import { waitForLobbyBoard } from './guests-kit.ts'

/** Every visible button of `selector` whose centre is not the button itself (something covers it there). */
async function coveredButtons(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = []
    for (const root of document.querySelectorAll(sel)) {
      for (const b of root.querySelectorAll('button')) {
        const r = b.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const x = r.x + r.width / 2
        const y = r.y + r.height / 2
        // a tool scrolled out of the toolbar's own view is not on screen: skip it
        let clipped = false
        for (let p = b.parentElement; p && p !== root.parentElement; p = p.parentElement) {
          const s = getComputedStyle(p)
          if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
          const c = p.getBoundingClientRect()
          if (x < c.left || x > c.right || y < c.top || y > c.bottom) clipped = true
        }
        if (clipped || x < 0 || x > window.innerWidth) continue
        const top = document.elementFromPoint(x, y)
        if (!top || !b.contains(top))
          out.push(`${b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? b.textContent}`)
      }
    }
    return out
  }, selector)
}

const SLOTS = ['toolbar', 'navigation', 'mainMenu'].map((s) => `[data-lobby-slot="${s}"]`).join(', ')

for (const size of [
  { width: 390, height: 844 },
  { width: 560, height: 800 },
  { width: 700, height: 800 },
  { width: 1280, height: 800 },
]) {
  test(`at ${size.width} px nothing covers the board menu, the toolbar's tools or the navigation panel`, async ({
    canvasSession,
  }, testInfo) => {
    const a = await canvasSession('alice')
    await waitForLobbyBoard(a.page)
    await a.page.setViewportSize(size)
    await expect(a.page.locator('[data-lobby-slot="toolbar"] button').first()).toBeVisible()
    await expect(a.page.getByTestId('main-menu.button')).toBeVisible()
    await expect(a.page.locator('[data-lobby-slot="navigation"] button').first()).toBeVisible()
    // the canvas follows the window a moment later
    await expect
      .poll(() => coveredButtons(a.page, SLOTS), { message: 'buttons covered by other chrome' })
      .toEqual([])
    await a.page.screenshot({ path: testInfo.outputPath(`board-chrome-${size.width}.png`) })
    // the board menu opens from where it sits
    await a.page.getByTestId('main-menu.button').click()
    await expect(a.page.getByTestId('main-menu.button')).toHaveAttribute('aria-expanded', 'true')
  })
}
