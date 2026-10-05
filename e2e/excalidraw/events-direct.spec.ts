// Wave H1: the board event stream straight from the api's own origin, as on Render (the static site's /api/*
// rewrite holds a streamed response until it ends, so through the page's origin nothing arrived live).
//
// The stack runs the api with DRAFTROOM_EVENTS_ORIGIN = its own URL (http://127.0.0.1:<base + 1>) while the
// page is served from the web port (<base + 2>): a DIFFERENT origin, so the browser applies CORS exactly as
// it does for draftroom-staging-web -> draftroom-staging-api. The page mints a ticket same-origin (through
// the preview proxy, with the cookie) and fetches the stream cross-origin with `Authorization: Bearer`.
//  - direct: the stream goes to the api origin, the ticket only in a header (never a URL), no cookie, CORS
//    for the page's origin; a new comment reaches the open board live; no same-origin stream is opened.
//  - under render.yaml's own CSP (the staging origins swapped for the local ones): with the api origin in
//    connect-src the direct stream works; without it the browser blocks it, and the page falls back to the
//    same-origin cookie stream (live events still arrive): never worse than before H1.
//  - an api restart (tickets live in its memory): the page mints a new ticket and is live again.
//  - an api without the mint route (a rollback to a build before H1): the cookie stream, live.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw events-direct
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { type CanvasSession, expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { REPO_ROOT } from '../tests/support/stack.ts'
import type { TestUser } from '../tests/support/users.ts'
import { bell, commentsApi } from './comments-kit.ts'

test.use({ apiEnv: { DRAFTROOM_EVENTS_ORIGIN: API_URL } })

const STAGING_API = 'https://draftroom-staging-api.onrender.com'
/** Live means well inside the client's 40 s stale-stream reconnect (what delivered events before H1). */
const LIVE_MS = 5_000

interface RenderYaml {
  staticSiteHeaders(text: string): unknown
  expectedCsp(headers: unknown): { name: string; value: string } | null
}

/**
 * render.yaml's enforced CSP for the static site, with the staging api origin replaced by the local one
 * (or dropped, `withApi: false`). Everything else stays as staging serves it: locally the board socket and
 * the /api calls are same-origin ('self'), as /api is on staging.
 */
async function stagingCsp(withApi: boolean): Promise<string> {
  // A computed specifier: the smoke script's module has no type declarations.
  const mod = (await import(
    pathToFileURL(join(REPO_ROOT, 'scripts/smoke/render-yaml.mjs')).href
  )) as RenderYaml
  const csp = mod.expectedCsp(mod.staticSiteHeaders(readFileSync(join(REPO_ROOT, 'render.yaml'), 'utf8')))
  if (csp?.name.toLowerCase() !== 'content-security-policy') throw new Error('render.yaml enforces no CSP')
  expect(csp.value, 'render.yaml lists the api origin in connect-src').toContain(` ${STAGING_API} `)
  return csp.value.replace(` ${STAGING_API} `, withApi ? ` ${API_URL} ` : ' ')
}

interface Seen {
  url: string
  method: string
  type: string
  headers: Record<string, string>
}

interface Watched extends CanvasSession {
  /** Every request for the board's event stream or its ticket, in order. */
  seen: Seen[]
  /** Response headers of the direct streams (the api origin). */
  directResponses: Record<string, string>[]
  /** Everything the page printed to its console. */
  consoleLines: string[]
}

/**
 * Opens `board` as `user` with the page watched from the start (and, with `csp`, the board page served
 * under that Content-Security-Policy, as the static site serves it).
 */
async function openWatched(
  browser: Browser,
  board: string,
  user: TestUser,
  opts: { csp?: string; noMintRoute?: boolean } = {},
): Promise<Watched> {
  // A document Playwright fulfils (the CSP below) is not attributed to the loopback address space, so
  // Chromium's Local Network Access checks then refuse every request from it to 127.0.0.1 (the board socket,
  // the api): a harness artifact (staging's page and api are both public). The permission lifts exactly
  // that, never CORS or the CSP, which are what this file checks.
  const context = await browser.newContext(opts.csp ? { permissions: ['local-network-access'] } : {})
  const seen: Seen[] = []
  const directResponses: Record<string, string>[] = []
  const consoleLines: string[] = []
  if (opts.csp) {
    const csp = opts.csp
    await context.route(`${WEB_URL}/b/**`, async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const res = await route.fetch()
      await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp } })
    })
  }
  if (opts.noMintRoute)
    // What an api from before H1 answers (no such route): the same 404 as any unknown path.
    await context.route(`${WEB_URL}/api/boards/*/events/ticket`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } }),
      }),
    )
  await context.addInitScript(() => {
    const list: { directive: string; blocked: string }[] = []
    Object.defineProperty(window, '__h1Csp', { value: list })
    document.addEventListener('securitypolicyviolation', (e) =>
      list.push({ directive: e.effectiveDirective, blocked: e.blockedURI }),
    )
  })
  const page = await context.newPage()
  page.on('console', (m) => consoleLines.push(m.text()))
  page.on('request', (r) => {
    const url = r.url()
    if (!/\/api\/boards\/[^/?]+\/events(\/ticket)?(\?|$)/.test(url)) return
    const entry: Seen = { url, method: r.method(), type: r.resourceType(), headers: {} }
    seen.push(entry)
    void r.allHeaders().then(
      (h) => {
        entry.headers = h
      },
      () => {},
    )
  })
  page.on('response', (res) => {
    if (res.url().startsWith(`${API_URL}/api/boards/`) && res.request().method() === 'GET')
      void res.allHeaders().then(
        (h) => void directResponses.push(h),
        () => {},
      )
  })
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return {
    user: user.handle,
    name: user.name,
    id: user.id,
    context,
    page,
    seen,
    directResponses,
    consoleLines,
  }
}

const directUrl = (board: string) => `${API_URL}/api/boards/${board}/events`
const sameOriginUrl = (board: string) => `${WEB_URL}/api/boards/${board}/events`
const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __h1Csp: { directive: string; blocked: string }[] }).__h1Csp)

/** bob (a commenter) posts a thread; the open board's bell must show it live. */
async function expectLiveComment(
  w: Watched,
  bob: ReturnType<typeof commentsApi>,
  board: string,
  body: string,
  unread: string,
) {
  await bob.createThread(board, { kind: 'point', x: 200, y: 160 }, body)
  await expect(bell(w.page)).toHaveAttribute('data-unread', unread, { timeout: LIVE_MS })
}

test('direct: the stream goes to the api origin with the ticket in a header (never a URL), CORS for the page, no cookie; a new comment arrives live', async ({
  browser,
  board,
  users,
}) => {
  expect(new URL(API_URL).origin, 'the api is another origin than the page').not.toBe(new URL(WEB_URL).origin)
  const aliceComments = commentsApi(await users.api('alice'))
  await aliceComments.markAllNotificationsRead()
  await users.grant(board, 'bob', 'commenter')
  const bob = commentsApi(await users.api('bob'))
  const a = await openWatched(browser, board, await users.get('alice'))
  try {
    await expect.poll(() => a.seen.filter((s) => s.url === directUrl(board)).length).toBeGreaterThan(0)
    await expect.poll(() => a.directResponses.length).toBeGreaterThan(0)
    const mint = a.seen.find((s) => s.url === `${WEB_URL}/api/boards/${board}/events/ticket`)
    expect(mint?.method, 'the ticket is minted same-origin').toBe('POST')
    const stream = a.seen.find((s) => s.url === directUrl(board))
    await expect.poll(() => stream?.headers.authorization ?? '').toMatch(/^Bearer evt_[A-Za-z0-9_-]{43}$/)
    expect(stream?.method).toBe('GET')
    expect(stream?.url, 'no ticket in the URL').not.toContain('?')
    expect(stream?.headers.cookie, 'no cookie crosses origins').toBeUndefined()
    expect(stream?.headers.origin).toBe(WEB_URL)
    const res = a.directResponses[0] ?? {}
    expect(res['access-control-allow-origin']).toBe(WEB_URL)
    expect(res['access-control-allow-credentials']).toBeUndefined()
    expect(res['content-type']).toBe('text/event-stream; charset=utf-8')
    // The page never opened the same-origin stream.
    expect(
      a.seen.filter((s) => s.url.startsWith(sameOriginUrl(board)) && !s.url.endsWith('/ticket')),
    ).toEqual([])
    await expect(bell(a.page)).toHaveAttribute('data-unread', '0')
    await expectLiveComment(a, bob, board, 'Straight from the api origin?', '1')
    // No ticket ever appeared in any URL the page requested.
    expect(a.seen.filter((s) => /evt_/.test(s.url))).toEqual([])
  } finally {
    await a.context.close()
  }
})

test('under render.yaml’s CSP: with the api origin in connect-src the stream is direct; without it the browser blocks it and the page falls back to the same-origin stream, still live', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(180_000)
  const aliceComments = commentsApi(await users.api('alice'))
  await aliceComments.markAllNotificationsRead()
  await users.grant(board, 'bob', 'commenter')
  const bob = commentsApi(await users.api('bob'))
  const alice = await users.get('alice')

  await test.step('connect-src names the api origin: direct, no violation', async () => {
    const a = await openWatched(browser, board, alice, { csp: await stagingCsp(true) })
    try {
      await expect.poll(() => a.directResponses.length).toBeGreaterThan(0)
      await expectLiveComment(a, bob, board, 'Under the staging CSP', '1')
      expect((await cspViolations(a.page)).filter((v) => v.directive === 'connect-src')).toEqual([])
      expect(a.seen.filter((s) => s.url === sameOriginUrl(board))).toEqual([])
    } finally {
      await a.context.close()
    }
  })
  await aliceComments.markAllNotificationsRead()

  await test.step('connect-src without it: blocked three times, then the cookie stream, live', async () => {
    const a = await openWatched(browser, board, alice, { csp: await stagingCsp(false) })
    try {
      // The fallback comes after three blocked attempts (backoff 1 s + 2 s).
      await expect
        .poll(() => a.seen.filter((s) => s.url === sameOriginUrl(board)).length, { timeout: 20_000 })
        .toBeGreaterThan(0)
      const blocked = (await cspViolations(a.page)).filter(
        (v) => v.directive === 'connect-src' && v.blocked.startsWith(API_URL),
      )
      expect(blocked.length).toBe(3)
      expect(a.directResponses).toEqual([])
      expect(a.consoleLines.some((l) => l.includes("live board updates use the page's own origin"))).toBe(
        true,
      )
      const cookieStream = a.seen.find((s) => s.url === sameOriginUrl(board))
      expect(cookieStream?.type).toBe('eventsource')
      await expectLiveComment(a, bob, board, 'Fallen back, still live', '1')
    } finally {
      await a.context.close()
    }
  })
})

test('an api restart forgets every ticket: the page mints a new one and is live again', async ({
  browser,
  board,
  users,
  stack,
}) => {
  test.setTimeout(180_000)
  const aliceComments = commentsApi(await users.api('alice'))
  await aliceComments.markAllNotificationsRead()
  await users.grant(board, 'bob', 'commenter')
  const a = await openWatched(browser, board, await users.get('alice'))
  try {
    await expect.poll(() => a.directResponses.length).toBeGreaterThan(0)
    await stack.api.restart()
    // The page reconnects by itself: a second direct stream with a NEW ticket.
    await expect
      .poll(() => a.directResponses.length, { timeout: 60_000, message: 'a new direct stream' })
      .toBeGreaterThan(1)
    const tickets = a.seen.filter((s) => s.url === directUrl(board)).map((s) => s.headers.authorization)
    expect(new Set(tickets).size).toBe(tickets.length)
    // A fresh api request context: the earlier one's connection went with the old process.
    const bob = commentsApi(await users.api('bob'))
    await expectLiveComment(a, bob, board, 'After the restart', '1')
    expect(a.seen.filter((s) => s.url === sameOriginUrl(board))).toEqual([])
  } finally {
    await a.context.close()
  }
})

test('an api without the mint route (a rollback to a build before H1): the page uses the same-origin cookie stream, live', async ({
  browser,
  board,
  users,
}) => {
  const aliceComments = commentsApi(await users.api('alice'))
  await aliceComments.markAllNotificationsRead()
  await users.grant(board, 'bob', 'commenter')
  const bob = commentsApi(await users.api('bob'))
  const a = await openWatched(browser, board, await users.get('alice'), { noMintRoute: true })
  try {
    await expect.poll(() => a.seen.filter((s) => s.url === sameOriginUrl(board)).length).toBeGreaterThan(0)
    expect(a.seen.filter((s) => s.url === directUrl(board))).toEqual([])
    await expectLiveComment(a, bob, board, 'Rolled back, still live', '1')
    // Quietly: an older api is not a failure.
    expect(a.consoleLines.some((l) => l.includes("live board updates use the page's own origin"))).toBe(false)
  } finally {
    await a.context.close()
  }
})
