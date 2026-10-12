// Wave M, M5-1 (S4, PWR-8, CAP-PG-OPEN): a board open asks for its panels' state ONCE (GET /api/boards/:id/open-state)
// instead of firing their eight reads together, and the features take their parts from it. Counted per path from the
// navigation until the board is live, its stream has said hello and the page is quiet (the k1-open-requests count).
//
// The parts' takers: export policy, the outside people and the threads (W5), W2's workshop, presentation and private
// brainstorm, W4's AI status (since the wave M integration), all held to no separate read. The share badge takes its
// part too. It used to refetch at the stream's first hello (its onResync bump); since wave N.1 its first read waits for
// that hello and is the open-state part (features/sharing/ported/badge-reads.ts): the owner makes no GET /sharing (held
// to 0), a viewer at most one (reported).
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/fixtures.ts'

interface ApiCall {
  readonly method: string
  readonly path: string
}

const normalise = (pathname: string) =>
  pathname
    .split('/')
    .map((part) => (/^[a-z]{1,4}[-_][0-9a-z]{6,}$/i.test(part) ? ':id' : part))
    .join('/')

/** The panel reads the open-state answers, by the part that replaces each. */
const TAKEN_HERE: Record<string, string> = {
  exportPolicy: 'GET /api/boards/:id/export-policy',
  outside: 'GET /api/boards/:id/sharing/outside',
  threads: 'GET /api/boards/:id/threads',
  workshop: 'GET /api/boards/:id/workshop',
  presentation: 'GET /api/boards/:id/presentation',
  privateBrainstorm: 'GET /api/boards/:id/private-brainstorm',
  ai: 'GET /api/boards/:id/ai',
}
/** The reads the 404 fallback must make again before the page is quiet (the AI status waits for an idle moment). */
const FALLBACK_READS = ['exportPolicy', 'outside', 'threads'] as const
/** Taken, with at most one read besides (the share badge: none for the owner since wave N.1). */
const TAKEN_ELSEWHERE: Record<string, string> = {
  sharing: 'GET /api/boards/:id/sharing',
}
const OPEN_STATE = 'GET /api/boards/:id/open-state'

function record(page: Page) {
  const calls: ApiCall[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.pathname.startsWith('/api/')) calls.push({ method: r.method(), path: normalise(url.pathname) })
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

const count = (calls: readonly ApiCall[], key: string) =>
  calls.filter((c) => `${c.method} ${c.path}` === key).length

for (const who of [
  // maxElsewhere: the most reads of a TAKEN_ELSEWHERE part (GET /sharing) the open may make
  { label: 'owner', handle: 'alice', role: null, maxElsewhere: 0 },
  { label: 'viewer', handle: 'bob', role: 'viewer' as const, maxElsewhere: 1 },
]) {
  test(`M5-1: a board open as the ${who.label} makes one open-state request and none of the reads it replaces`, async ({
    browser,
    board,
    users,
  }, testInfo) => {
    const user = who.role ? await users.grant(board, who.handle, who.role) : await users.get(who.handle)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await signInContext(context, user.handle, user.name)
      const calls = record(page)
      await page.goto(`/b/${board}`)
      await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', {
        timeout: 60_000,
      })
      await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
      // past the threads' first load (it waits for the stream's hello, at most 2.5 s) and the export gates' wait
      await page.waitForTimeout(3_000)
      await settle(page, calls)
      const byPath = Object.fromEntries(
        [...new Set(calls.map((c) => `${c.method} ${c.path}`))].sort().map((k) => [k, count(calls, k)]),
      )
      await testInfo.attach(`api-calls-${who.label}.json`, {
        body: JSON.stringify(byPath, null, 2),
        contentType: 'application/json',
      })
      expect(count(calls, OPEN_STATE), JSON.stringify(byPath)).toBe(1)
      for (const [part, key] of Object.entries(TAKEN_HERE))
        expect(count(calls, key), `${part}: ${JSON.stringify(byPath)}`).toBe(0)
      for (const [part, key] of Object.entries(TAKEN_ELSEWHERE)) {
        expect(count(calls, key), `${part}: ${JSON.stringify(byPath)}`).toBeLessThanOrEqual(who.maxElsewhere)
        testInfo.annotations.push({
          type: 'taken elsewhere',
          description: `${part}: ${count(calls, key)} × ${key}`,
        })
      }
      // the parts were used: the export gates have an answer (a viewer's Export entries follow the policy) and the
      // comments panel loaded (its status is ready, not loading)
      await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready')
    } finally {
      await context.close()
    }
  })
}

test('M5-1: an api without the route (404) falls back to the separate reads, and the board works', async ({
  browser,
  board,
  users,
}) => {
  const user = await users.get('alice')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, user.handle, user.name)
    await page.route('**/api/boards/*/open-state', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } }),
      }),
    )
    const calls = record(page)
    await page.goto(`/b/${board}`)
    await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 })
    await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    await page.waitForTimeout(3_000)
    await settle(page, calls)
    const byPath = JSON.stringify(calls.map((c) => `${c.method} ${c.path}`))
    expect(count(calls, OPEN_STATE), byPath).toBe(1)
    for (const part of FALLBACK_READS)
      expect(
        count(calls, TAKEN_HERE[part] as string),
        `${part} (the fallback read): ${byPath}`,
      ).toBeGreaterThanOrEqual(1)
  } finally {
    await context.close()
  }
})
