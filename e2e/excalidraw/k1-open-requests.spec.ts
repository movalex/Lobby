// K1-4 (wave K): the api calls one board open makes. The board-open burst queues on staging's 0.1-CPU
// Postgres (export-policy ran about 4 times per open: 270 calls for 68 tickets), so this counts every
// /api request from the navigation until the board is live and then quiet, per path, and holds the export
// policy to one read per open: a shared, invalidatable resource that every gate reads
// (features/sharing/ported/export-policy.ts `exportPolicyResource`).
//
// The counts are attached to the test (`api-calls.json`) and printed, so the wave's evidence can quote the
// total before live and after, against the 648bd891 baseline. Other wave-K workstreams hold their own
// reads to a limit here too (OPEN_LIMITS): add a line, not a new spec.
import type { Page, TestInfo } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/fixtures.ts'

interface ApiCall {
  readonly method: string
  /** the path with board, workspace and other ids replaced by `:id` */
  readonly path: string
  /** ms since the navigation started (the page's own clock) */
  readonly at: number
}

/** Ids in api paths (b-…, ws-…, usr_…, and the other prefixed ids) become `:id`. */
const normalise = (pathname: string) =>
  pathname
    .split('/')
    .map((part) => (/^[a-z]{1,4}[-_][0-9a-z]{6,}$/i.test(part) ? ':id' : part))
    .join('/')

/**
 * Most calls of one kind a board open may make (whole open: navigation until quiet). K1-4: the export
 * policy once. Workstreams that bring a read down add theirs (K2-6 /threads, K3-6 /workshop and
 * /private-brainstorm, K7-4 no /ai before live).
 */
const OPEN_LIMITS: readonly { readonly test: RegExp; readonly max: number; readonly why: string }[] = [
  { test: /^GET \/api\/boards\/:id\/export-policy$/, max: 1, why: 'K1-4: one export-policy read per open' },
]

/** Records every /api request of `page` with the page's own clock, and when the board went live. */
async function recordOpen(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __k1Live?: number }
    const mark = () => {
      const board = document.querySelector('[data-testid="lobby-board"]')
      if (w.__k1Live === undefined && board?.getAttribute('data-phase') === 'ready')
        w.__k1Live = performance.now()
    }
    new MutationObserver(mark).observe(document, { subtree: true, attributes: true, childList: true })
  })
  const calls: ApiCall[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (!url.pathname.startsWith('/api/')) return
    // the page's clock: the request is recorded when the browser reports it (a few ms late at most)
    calls.push({ method: r.method(), path: normalise(url.pathname), at: Date.now() })
  })
  return calls
}

/** Waits until no /api request started for `quietMs` (at most `maxMs`). */
async function settle(page: Page, calls: ApiCall[], quietMs = 1_500, maxMs = 12_000) {
  const started = Date.now()
  let seen = calls.length
  let since = Date.now()
  while (Date.now() - started < maxMs) {
    await page.waitForTimeout(250)
    if (calls.length !== seen) {
      seen = calls.length
      since = Date.now()
    } else if (Date.now() - since >= quietMs) return
  }
}

function tally(calls: readonly ApiCall[]) {
  const by = new Map<string, number>()
  for (const c of calls) {
    const key = `${c.method} ${c.path}`
    by.set(key, (by.get(key) ?? 0) + 1)
  }
  return Object.fromEntries([...by.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

async function report(testInfo: TestInfo, label: string, calls: readonly ApiCall[], liveAt: number) {
  const beforeLive = calls.filter((c) => c.at <= liveAt)
  const body = {
    label,
    beforeLive: beforeLive.length,
    total: calls.length,
    byPathBeforeLive: tally(beforeLive),
    byPath: tally(calls),
  }
  await testInfo.attach(`api-calls-${label}.json`, {
    body: JSON.stringify(body, null, 2),
    contentType: 'application/json',
  })
  console.log(`[k1 api calls] ${label}: ${body.beforeLive} before live, ${body.total} in all`)
  for (const [k, n] of Object.entries(body.byPath)) console.log(`  ${n}  ${k}`)
  return body
}

for (const who of [
  { label: 'owner', handle: 'alice', role: null },
  { label: 'viewer', handle: 'bob', role: 'viewer' as const },
]) {
  test(`one board open as the ${who.label}: export-policy at most once, every api call counted`, async ({
    browser,
    board,
    users,
  }, testInfo) => {
    const user = who.role ? await users.grant(board, who.handle, who.role) : await users.get(who.handle)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await signInContext(context, user.handle, user.name)
      const calls = await recordOpen(page)
      const navAt = Date.now()
      await page.goto(`/b/${board}`)
      const lobbyBoard = page.getByTestId('lobby-board')
      await expect(lobbyBoard).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
      await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
      // the page's live mark, on the same clock as the requests (Date.now at navigation + page time)
      const livePageMs = await page.evaluate(
        () => (window as unknown as { __k1Live?: number }).__k1Live ?? null,
      )
      const liveAt = livePageMs === null ? Date.now() : navAt + livePageMs
      await settle(page, calls)
      const body = await report(testInfo, who.label, calls, liveAt)
      for (const limit of OPEN_LIMITS) {
        const n = calls.filter((c) => limit.test.test(`${c.method} ${c.path}`)).length
        expect(n, `${limit.why}: ${JSON.stringify(body.byPath)}`).toBeLessThanOrEqual(limit.max)
      }
      // positive control: the policy was read (the gates have an answer), and the board and ticket were asked
      expect(calls.filter((c) => c.path === '/api/boards/:id/export-policy').length).toBeGreaterThanOrEqual(1)
      expect(calls.some((c) => c.method === 'GET' && c.path === '/api/boards/:id')).toBe(true)
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/boards/:id/ticket')).toBe(true)
    } finally {
      await context.close()
    }
  })
}
