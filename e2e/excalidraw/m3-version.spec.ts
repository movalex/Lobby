// Wave M (W3, M3-5, S2): open tabs learn about a new build (lib/version-check.ts). The build serves /version.json
// {"commit"}; the page compares it with the commit it was built from. The server's answer is swapped here
// (page.route), the tab's visibility is flipped by hand, and the clock is Playwright's, so a quarter of an hour is
// instant.
//  - on the dashboard: nothing is asked while the tab is hidden, one ask when it is shown, one every 15 minutes while it
//    stays shown; a newer commit is no visible change while the tab is shown, and the page reloads once the tab is
//    hidden; a reload for a build is not repeated (the guard): the notice with its Reload button instead;
//  - on a board: the existing "Lobby has been updated" notice, never a reload by itself; its Reload reloads;
//  - the request is /version.json only, without credentials.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m3-version.spec.ts --project=chromium --workers=1
import type { Page, Request } from '@playwright/test'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import {
  freshHandle,
  openDashboard,
  personalWorkspace,
  signedInContext,
} from '../tests/support/dashboard-share.ts'

test.use({ viewport: { width: 1360, height: 860 } })

const NEWER = 'feedc0ffee12'

/** Swaps what /version.json answers, and records every ask with whether the tab was shown. */
async function serveVersion(page: Page) {
  const real = (await (await page.request.get('/version.json')).json()) as { commit: string }
  const state = { commit: real.commit, shown: true, asks: [] as { shown: boolean; request: Request }[] }
  await page.route('**/version.json', async (route) => {
    state.asks.push({ shown: state.shown, request: route.request() })
    await route.fulfill({
      json: { commit: state.commit },
      headers: { 'cache-control': 'no-store' },
    })
  })
  return { real: real.commit, state }
}

/** Hides or shows the tab (the page reads document.visibilityState when the event fires). */
async function setShown(page: Page, state: { shown: boolean }, shown: boolean) {
  state.shown = shown
  await page.evaluate((visible) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }, shown)
}

const marker = (page: Page) => page.evaluate(() => (window as { __m3?: number }).__m3)

test('the dashboard asks only while shown (on showing, then every 15 minutes), reloads for a newer build once the tab is hidden, and not twice for the same build', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await signedInContext(browser, freshHandle('m3v'), {
    name: 'Vic Version',
    email: 'lobby-test-m3v@darkburn.com',
  })
  try {
    await p.page.clock.install()
    await openDashboard(p.page, personalWorkspace(p.me))
    const { real, state } = await serveVersion(p.page)
    await p.page.evaluate(() => {
      ;(window as { __m3?: number }).__m3 = 1
    })

    await test.step('hidden: a quarter of an hour passes twice and nothing is asked', async () => {
      await setShown(p.page, state, false)
      await p.page.clock.fastForward('16:00')
      await p.page.clock.fastForward('16:00')
      expect(state.asks).toHaveLength(0)
    })

    await test.step('shown: one ask, the same build, nothing happens; then one every 15 minutes while it stays shown', async () => {
      await setShown(p.page, state, true)
      await expect.poll(() => state.asks.length).toBe(1)
      // the next ask is armed once the page has read the first answer, a quarter of an hour from then: when the page
      // read it only after the jump, the timer is a quarter of an hour on from the jump, so jump once more
      await p.page.clock.fastForward('15:01')
      const second = () => expect.poll(() => state.asks.length, { timeout: 3_000 }).toBe(2)
      if (
        !(await second().then(
          () => true,
          () => false,
        ))
      )
        await p.page.clock.fastForward('15:01')
      await expect.poll(() => state.asks.length).toBe(2)
      expect(state.asks.every((a) => a.shown)).toBe(true)
      // only /version.json, uncached and without the session cookie
      for (const a of state.asks) {
        expect(new URL(a.request.url()).pathname).toBe('/version.json')
        expect(await a.request.headerValue('cookie')).toBeNull()
      }
      expect(await marker(p.page)).toBe(1)
    })

    await test.step('a newer build is seen while the tab is shown: nothing visible happens', async () => {
      state.commit = NEWER
      await p.page.clock.fastForward('01:01')
      await setShown(p.page, state, false)
      // hidden right away: the page reloads without anyone seeing it, so first look again that nothing is shown
      await setShown(p.page, state, true)
      await expect.poll(() => state.asks.length).toBe(3)
      await p.page.waitForTimeout(300)
      expect(await marker(p.page)).toBe(1)
      await expect(p.page.getByTestId('stale-chunk-notice')).toHaveCount(0)
    })

    await test.step('the tab is hidden: the page reloads (the new build is the one the page asks for)', async () => {
      await setShown(p.page, state, false)
      await expect.poll(() => marker(p.page).catch(() => 'reloading'), { timeout: 30_000 }).toBeUndefined()
      await expect(p.page.getByTestId('dashboard')).toBeVisible()
      // the page that came back is this build again, so it still sees NEWER: one reload per build
      const guard = await p.page.evaluate(() => ({
        version: sessionStorage.getItem('lobby:version-reload'),
        reloaded: sessionStorage.getItem('lobby:stale-chunk-reload'),
      }))
      expect(guard.version).toMatch(new RegExp(`^${NEWER}@\\d+$`))
      expect(guard.reloaded).toMatch(/^\d+$/)
    })

    await test.step('and does not reload again for the same build: the notice with its Reload button instead', async () => {
      await p.page.evaluate(() => {
        ;(window as { __m3?: number }).__m3 = 2
      })
      await p.page.clock.fastForward('02:00')
      await setShown(p.page, state, false)
      await setShown(p.page, state, true)
      await expect.poll(() => state.asks.length).toBeGreaterThanOrEqual(4)
      await setShown(p.page, state, false)
      await p.page.waitForTimeout(500)
      expect(await marker(p.page)).toBe(2)
      await setShown(p.page, state, true)
      const notice = p.page.getByTestId('stale-chunk-notice')
      await expect(notice).toBeVisible()
      await expect(notice).toContainText('Lobby has been updated')
      await expect(p.page.getByTestId('stale-chunk-reload')).toBeVisible()
      expect(real).not.toBe(NEWER)
    })
  } finally {
    await p.context.close()
  }
})

test('on a board a newer build is the stale-chunk notice, never a reload by itself; its Reload reloads', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  const { state } = await serveVersion(a.page)
  await a.page.evaluate(() => {
    ;(window as { __m3?: number }).__m3 = 1
  })

  await test.step('shown, hidden and shown again with the same build: nothing', async () => {
    await setShown(a.page, state, false)
    await setShown(a.page, state, true)
    await expect.poll(() => state.asks.length).toBe(1)
    await expect(a.page.getByTestId('stale-chunk-notice')).toHaveCount(0)
  })

  await test.step('a newer build: the notice appears, with Reload; the board stays as it is, hidden or shown', async () => {
    state.commit = NEWER
    // a second ask is not within a minute of the first: the page waits, so say the time has passed
    await a.page.clock.install()
    await a.page.clock.fastForward('02:00')
    await setShown(a.page, state, false)
    await setShown(a.page, state, true)
    await expect.poll(() => state.asks.length).toBe(2)
    const notice = a.page.getByTestId('stale-chunk-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Lobby has been updated')
    await setShown(a.page, state, false)
    await a.page.waitForTimeout(600)
    expect(await marker(a.page)).toBe(1)
    await setShown(a.page, state, true)
    await expect(notice).toBeVisible()
    expect(await marker(a.page)).toBe(1)
  })

  await test.step('Reload (nothing unsent) reloads the board', async () => {
    await a.page.getByTestId('stale-chunk-reload').click()
    await expect.poll(() => marker(a.page).catch(() => 'reloading'), { timeout: 30_000 }).toBeUndefined()
    await waitForCanvas(a.page)
  })
})
