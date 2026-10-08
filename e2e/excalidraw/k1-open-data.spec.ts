// K1-2 (wave K): GET /api/boards/:id and the first ticket go out together. Under Chrome's "Fast 4G" network
// and a 4x slower CPU (CDP), POST /api/boards/:id/ticket starts before GET /api/boards/:id has answered (it
// waited for it: one more round trip, 200-280 ms on staging). A 403 or 404 on the board still shows the
// no-access screen and never opens the board socket, even though the ticket was granted; an archived board
// still opens read-only, its ticket asked for alongside the board.
import type { BrowserContext, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { noAccessScreen } from '../tests/support/excalidraw.ts'
import { expect, test } from '../tests/support/fixtures.ts'

async function fast4g(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: (9_000 * 1024) / 8,
    uploadThroughput: (1_500 * 1024) / 8,
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
}

interface Timing {
  readonly path: string
  readonly start: number
  readonly end: number
}

/** The first Resource Timing entry of `path` (ms since the navigation started). */
async function timingOf(page: Page, path: string): Promise<Timing> {
  const all = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => ({
      path: new URL(e.name).pathname,
      start: e.startTime,
      end: (e as PerformanceResourceTiming).responseEnd,
    })),
  )
  const t = all.find((e) => e.path === path)
  expect(t, `${path}: ${JSON.stringify(all.map((e) => e.path))}`).toBeTruthy()
  return t as Timing
}

test('cold open under Fast 4G and CPU 4x: the ticket starts before the board’s answer is in', async ({
  browser,
  board,
  users,
}, testInfo) => {
  test.setTimeout(240_000)
  const alice = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    await fast4g(context, page)
    await page.goto(`/b/${board}`)
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 180_000 })
    const boardGet = await timingOf(page, `/api/boards/${board}`)
    const ticket = await timingOf(page, `/api/boards/${board}/ticket`)
    const evidence = { boardGet, ticket }
    await testInfo.attach('k1-open-data-timings.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    console.log('[k1-2 open timings, ms since navigation]', JSON.stringify(evidence))
    expect(ticket.start, 'the ticket starts before GET /api/boards/:id ends').toBeLessThan(boardGet.end)
  } finally {
    await context.close()
  }
})

for (const status of [404, 403] as const) {
  test(`a ${status} on the board shows the no-access screen and never connects, though the ticket was granted`, async ({
    browser,
    board,
    users,
  }) => {
    const alice = await users.get('alice')
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await signInContext(context, alice.handle, alice.name)
      await page.route(`**/api/boards/${board}`, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              status,
              contentType: 'application/json',
              body: JSON.stringify({
                error: { code: status === 404 ? 'NOT_FOUND' : 'FORBIDDEN', message: 'No access.' },
              }),
            })
          : route.continue(),
      )
      const sockets: string[] = []
      page.on('websocket', (ws) => sockets.push(ws.url()))
      const tickets: number[] = []
      page.on('response', (r) => {
        if (new URL(r.url()).pathname === `/api/boards/${board}/ticket`) tickets.push(r.status())
      })
      await page.goto(`/b/${board}`)
      await expect(noAccessScreen(page)).toBeVisible({ timeout: 30_000 })
      // the ticket went out with the board and was granted: the page still never opens the board socket
      await expect.poll(() => tickets).toEqual([200])
      await page.waitForTimeout(1_500)
      expect(sockets.filter((u) => new URL(u).pathname.startsWith('/connect'))).toEqual([])
      await expect(page.getByTestId('lobby-board')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
}

test('an archived board opens read-only, its ticket asked for alongside the board', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const api = await users.api('alice')
  const res = await api.fetch('POST', `/api/boards/${board}/archive`)
  expect(res.status(), await res.text()).toBe(200)
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, alice.handle, alice.name)
    await page.goto(`/b/${board}`)
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId('readonly-pill')).toBeVisible()
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'readonly')
    const boardGet = await timingOf(page, `/api/boards/${board}`)
    const ticket = await timingOf(page, `/api/boards/${board}/ticket`)
    expect(ticket.start).toBeLessThan(boardGet.end)
  } finally {
    await context.close()
  }
})
