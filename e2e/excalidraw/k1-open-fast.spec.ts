// K1-1 (wave K): the board code downloads alongside the sign-in check, in one lazy step. On the production
// build (minified, chunked) under Chrome's "Fast 4G" network (9 Mbit/s down, 1.5 Mbit/s up, 60 ms) and a 4x
// slower CPU, through CDP: the board page's chunk starts downloading before GET /api/auth/me has answered
// (it waited for that answer, then for route.js, then for LobbyBoardPage.js), the engine chunk starts with
// it, and there is no route.js -> LobbyBoardPage.js step at all (or, were there one, no gap over 50 ms).
// Every request stays on Lobby's own origin (the e2e network assertion).
//
// The timings come from the page's own Resource Timing entries (ms since the navigation started), and are
// attached to the test for the wave's evidence.
import type { BrowserContext, CDPSession, Page, Request } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/fixtures.ts'
import { WEB_URL } from '../tests/support/ports.ts'

const BOARD_CHUNK = /\/assets\/LobbyBoardPage-[\w-]+\.js$/
const ENGINE_CHUNK = /\/assets\/excalidraw-[\w-]+\.js$/
const ROUTE_CHUNK = /\/assets\/route-[\w-]+\.js$/

/** Chrome DevTools' "Fast 4G" preset and a 4x CPU slowdown, through CDP. */
async function fast4g(context: BrowserContext, page: Page): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: (9_000 * 1024) / 8,
    uploadThroughput: (1_500 * 1024) / 8,
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  return cdp
}

interface Timing {
  readonly name: string
  readonly start: number
  readonly end: number
}

const timings = (page: Page): Promise<Timing[]> =>
  page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => ({ name: e.name, start: e.startTime, end: (e as PerformanceResourceTiming).responseEnd })),
  )

const one = (all: Timing[], test: (name: string) => boolean, what: string): Timing => {
  const found = all.filter((t) => test(new URL(t.name).pathname))
  expect(
    found.length,
    `${what}: ${JSON.stringify(all.map((t) => new URL(t.name).pathname))}`,
  ).toBeGreaterThan(0)
  return found[0] as Timing
}

/** Every request of the page that left Lobby's origin (none may: plan §2.12, the e2e network assertion). */
function foreignRequests(page: Page) {
  const origin = new URL(WEB_URL).origin
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (url.origin !== origin) foreign.push(r.url())
  })
  return foreign
}

test('cold open under Fast 4G and CPU 4x: the board code alongside the sign-in check, in one lazy step', async ({
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
    const foreign = foreignRequests(page)
    await fast4g(context, page)
    await page.goto(`/b/${board}`)
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 180_000 })
    const all = await timings(page)
    const authMe = one(all, (p) => p === '/api/auth/me', 'GET /api/auth/me')
    const chunk = one(all, (p) => BOARD_CHUNK.test(p), 'the board page chunk')
    const engine = one(all, (p) => ENGINE_CHUNK.test(p), 'the engine chunk')
    const route = all.find((t) => ROUTE_CHUNK.test(new URL(t.name).pathname)) ?? null
    const evidence = {
      authMe: { start: authMe.start, end: authMe.end },
      boardChunk: { start: chunk.start, end: chunk.end },
      engineChunk: { start: engine.start, end: engine.end },
      routeChunk: route ? { start: route.start, end: route.end } : null,
    }
    await testInfo.attach('k1-open-timings.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    console.log('[k1-1 open timings, ms since navigation]', JSON.stringify(evidence))

    // the board code starts before the session check has answered
    expect(chunk.start, 'the board chunk starts before GET /api/auth/me ends').toBeLessThan(authMe.end)
    // the engine chunk goes with it (one preload list), not after the board page chunk arrived
    expect(engine.start).toBeLessThan(chunk.end)
    // one lazy step: no route.js before LobbyBoardPage.js
    if (route) expect(chunk.start - route.end, 'route.js -> LobbyBoardPage.js gap').toBeLessThanOrEqual(50)
    expect(route, 'no separate route chunk in the build').toBeNull()
    expect(foreign).toEqual([])
  } finally {
    await context.close()
  }
})
