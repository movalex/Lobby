// Wave J5: the "Send feedback" button, in a real browser against the real api (migration 0026).
//   - from a board: Menu -> Send feedback; the dialog lists what is attached (page, board, browser, window,
//     build, time) BEFORE sending; the keys typed into it never reach the canvas; the message arrives with
//     its context and its author taken from the session;
//   - from the dashboard: the account menu has it too;
//   - a name-only guest sends from the board menu and shows as a guest;
//   - the inbox (/feedback) opens only for the person named in DRAFTROOM_FEEDBACK_ADMINS: they see the
//     messages newest first, mark one done and reopen it; everybody else (a member, a guest) gets the page
//     a mistyped address gets, no menu entry, and a 404 from the api.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw feedback
import type { Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { expect, items, test, tool } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { guestOn, ORIGIN, tokenOf } from './guests-kit.ts'

// alice is the first dev user, the Dev Studio owner, and the only inbox reader: her dev address is the
// default <handle>@dev.invalid (apps/api/src/auth/dev.ts).
test.use({ apiEnv: { DRAFTROOM_FEEDBACK_ADMINS: 'alice@dev.invalid' } })
test.use({ viewport: { width: 1280, height: 820 } })

const unique = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Menu -> Send feedback on the board page. */
async function openFromBoardMenu(page: Page) {
  await page.getByTestId('main-menu.button').click()
  await page.getByTestId('main-menu.feedback').click()
  await expect(page.getByTestId('feedback-dialog')).toBeVisible()
}

/** The account menu's button on the dashboard (the dev badge in a dev-auth build). */
const accountMenu = (page: Page) => page.getByTestId('dev-identity-badge')

test('from a board: the dialog lists what is attached before sending, the keys typed never reach the canvas, and the message arrives with its context and its author', async ({
  canvasSession,
  board,
  users,
}) => {
  const bob = await canvasSession('bob')
  const p = bob.page
  const problems: string[] = []
  p.on('pageerror', (e) => problems.push(e.message))
  const toolBefore = await tool(p)
  const countBefore = (await items(p)).length
  const marker = unique('board')

  await openFromBoardMenu(p)
  const dialog = p.getByTestId('feedback-dialog')
  await expect(dialog.getByRole('heading', { name: 'Send feedback' })).toBeVisible()
  await expect(dialog.getByText('What happened?')).toBeVisible()
  await expect(dialog.getByText('What did you expect?')).toBeVisible()

  await test.step('the context block is listed before anything is sent', async () => {
    const ctx = p.getByTestId('feedback-context')
    await expect(ctx).toBeVisible()
    await expect(p.getByTestId('feedback-context-page')).toContainText(`/b/${board}`)
    await expect(p.getByTestId('feedback-context-page')).not.toContainText('?')
    const row = p.getByTestId('feedback-context-board')
    await expect(row).toContainText(board)
    await expect(row).toContainText('From a board') // the board's title (the test title up to ':')
    const ua = await p.evaluate(() => navigator.userAgent)
    await expect(p.getByTestId('feedback-context-browser')).toContainText(ua)
    const size = await p.evaluate(() => `${window.innerWidth} × ${window.innerHeight}`)
    await expect(p.getByTestId('feedback-context-viewport')).toContainText(size)
    await expect(p.getByTestId('feedback-context-build')).toContainText(/[0-9a-f]{7,12}|dev|unknown/)
    await expect(p.getByTestId('feedback-context-time')).toBeVisible()
  })

  await test.step('nothing to send yet; typing shortcut letters, digits and Delete goes into the text, never to the canvas', async () => {
    const submit = p.getByTestId('feedback-submit')
    await expect(submit).toBeDisabled()
    const text = p.getByTestId('feedback-text')
    await expect(text).toBeFocused()
    await text.pressSequentially(`${marker}: r e d l p o n t 1 2 3 and Delete`)
    await text.press('Delete')
    await expect(text).toHaveValue(new RegExp(`^${marker}: r e d l p o n t 1 2 3 and Delete`))
    await expect(p.getByTestId('feedback-count')).toContainText('/ 4,000')
    await p.getByTestId('feedback-expected').fill('It should have stayed put')
    await expect(submit).toBeEnabled()
    expect(await tool(p)).toBe(toolBefore)
    expect((await items(p)).length).toBe(countBefore)
  })

  await test.step('send: thanks, and the dialog goes', async () => {
    await p.getByTestId('feedback-submit').click()
    await expect(p.getByTestId('feedback-sent')).toBeVisible()
    await expect(p.getByTestId('feedback-close')).toBeFocused()
    await p.getByTestId('feedback-close').click()
    await expect(p.getByTestId('feedback-dialog')).toHaveCount(0)
    // the keyboard is back on the board (a dialog that closed must not strand it on the page body)
    await expect.poll(() => p.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
    expect(problems).toEqual([])
  })

  await test.step('it arrived with the context and bob as its author (the api, as the inbox reader)', async () => {
    const alice = await users.api('alice')
    const res = await alice.request.get(`${WEB_URL}/api/feedback?status=all&limit=200`)
    expect(res.status(), await res.text()).toBe(200)
    const list = (await res.json()) as {
      items: {
        userId: string
        name: string
        kind: string
        text: string
        expected: string | null
        status: string
        context: Record<string, unknown>
      }[]
    }
    const sent = list.items.find((i) => i.text.startsWith(marker))
    expect(sent).toMatchObject({
      userId: bob.id,
      name: bob.name,
      kind: 'account',
      expected: 'It should have stayed put',
      status: 'open',
    })
    expect(sent?.context).toMatchObject({ path: `/b/${board}`, boardId: board })
    expect(sent?.context.userAgent).toEqual(expect.stringContaining('Mozilla'))
    expect(sent?.context.viewport).toMatchObject({ width: 1280 })
  })
})

test('from the dashboard: the account menu has Send feedback (and no inbox for a member); it fits a phone', async ({
  browser,
  users,
}) => {
  const bob = await users.get('bob')
  const context = await browser.newContext({ viewport: { width: 375, height: 700 } })
  try {
    await signInContext(context, bob.handle, bob.name)
    const p = await context.newPage()
    await p.goto('/')
    await expect(p.getByTestId('dashboard')).toBeVisible()
    await accountMenu(p).click()
    await expect(p.getByTestId('feedback-send')).toBeVisible()
    await expect(p.getByTestId('feedback-inbox-link')).toHaveCount(0)
    await p.getByTestId('feedback-send').click()
    const dialog = p.getByTestId('feedback-dialog')
    await expect(dialog).toBeVisible()
    // on the dashboard: a page, no board
    await expect(p.getByTestId('feedback-context-page')).toContainText('/w/')
    await expect(p.getByTestId('feedback-context-board')).toHaveCount(0)
    // fits a phone: inside the screen, and the page does not scroll sideways
    const box = await dialog.boundingBox()
    expect(box?.x).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375)
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    const marker = unique('dashboard')
    await p.getByTestId('feedback-text').fill(marker)
    await p.getByTestId('feedback-submit').click()
    await expect(p.getByTestId('feedback-sent')).toBeVisible()
    await p.getByTestId('feedback-close').click()
    await expect(p.getByTestId('feedback-dialog')).toHaveCount(0)
    // Escape closes an open dialog without sending anything
    await accountMenu(p).click()
    await p.getByTestId('feedback-send').click()
    await p.getByTestId('feedback-text').fill('never sent')
    await p.keyboard.press('Escape')
    await expect(p.getByTestId('feedback-dialog')).toHaveCount(0)

    const alice = await users.api('alice')
    const list = (await (await alice.request.get(`${WEB_URL}/api/feedback?status=all&limit=200`)).json()) as {
      items: { text: string }[]
    }
    expect(list.items.some((i) => i.text === marker)).toBe(true)
    expect(list.items.some((i) => i.text === 'never sent')).toBe(false)
  } finally {
    await context.close()
  }
})

test('a name-only guest sends from the board menu, and the inbox shows them as a guest', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const link = await alice.request.post(`${WEB_URL}/api/boards/${board}/review-links`, {
    headers: ORIGIN,
    data: { allowGuests: true },
  })
  expect(link.status(), await link.text()).toBe(201)
  const token = tokenOf(((await link.json()) as { url: string }).url)
  const context = await browser.newContext()
  try {
    const guest = await guestOn(context, token, 'Sam Client')
    const marker = unique('guest')
    await openFromBoardMenu(guest.page)
    await guest.page.getByTestId('feedback-text').fill(marker)
    await guest.page.getByTestId('feedback-submit').click()
    await expect(guest.page.getByTestId('feedback-sent')).toBeVisible()

    const list = (await (await alice.request.get(`${WEB_URL}/api/feedback?status=all&limit=200`)).json()) as {
      items: { text: string; kind: string; name: string; userId: string }[]
    }
    const sent = list.items.find((i) => i.text === marker)
    expect(sent).toMatchObject({ kind: 'guest', userId: guest.id })
    expect(sent?.name).toContain('Sam Client')
    // a guest is not an inbox reader
    const probe = await context.request.get(`${WEB_URL}/api/feedback`)
    expect(probe.status()).toBe(404)
  } finally {
    await context.close()
  }
})

test('the inbox: the reader sees the messages newest first and marks one done and open again; a member and a guest get the page a mistyped address gets', async ({
  browser,
  users,
}) => {
  const aliceUser = await users.get('alice')
  const bob = await users.api('bob')
  const first = unique('first')
  const second = unique('second')
  for (const text of [first, second]) {
    const res = await bob.request.post(`${WEB_URL}/api/feedback`, {
      headers: ORIGIN,
      data: { text, expected: `${text} expected\nwith a second line`, context: { path: '/w/x?y=1' } },
    })
    expect(res.status(), await res.text()).toBe(201)
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    await signInContext(context, aliceUser.handle, aliceUser.name)
    const p = await context.newPage()
    await p.goto('/')
    await expect(p.getByTestId('dashboard')).toBeVisible()

    await test.step('the account menu has the inbox for its reader, and it opens', async () => {
      await accountMenu(p).click()
      await expect(p.getByTestId('feedback-inbox-link')).toBeVisible()
      await p.getByTestId('feedback-inbox-link').click()
      await expect(p).toHaveURL(`${WEB_URL}/feedback`)
      await expect(p.getByTestId('feedback-page')).toBeVisible()
    })

    const item = (marker: string) => p.getByTestId('feedback-item').filter({ hasText: marker })
    await test.step('newest first, as text, with where it was sent from', async () => {
      await expect(item(second)).toBeVisible()
      await expect(item(first)).toBeVisible()
      const order = await p.getByTestId('feedback-item-text').allTextContents()
      expect(order.indexOf(second)).toBeLessThan(order.indexOf(first))
      await expect(item(second).getByTestId('feedback-who')).toHaveText('Bob Chen')
      await expect(item(second).getByTestId('feedback-item-expected')).toContainText('with a second line')
      await item(second).locator('summary').click()
      // the path was stored without its query string
      await expect(item(second).getByTestId('feedback-item-context')).toContainText('/w/x')
      await expect(item(second).getByTestId('feedback-item-context')).not.toContainText('y=1')
    })

    await test.step('mark done: it leaves Open and shows under Done; reopen brings it back; the state is the server’s', async () => {
      await item(first).getByTestId('feedback-done').click()
      await expect(item(first)).toHaveCount(0)
      await expect(item(second)).toBeVisible()
      await p.getByTestId('feedback-filter-done').click()
      await expect(item(first)).toHaveAttribute('data-status', 'done')
      await expect(item(second)).toHaveCount(0)
      await p.reload()
      await p.getByTestId('feedback-filter-done').click()
      await expect(item(first)).toBeVisible()
      await item(first).getByTestId('feedback-reopen').click()
      await expect(item(first)).toHaveCount(0)
      await p.getByTestId('feedback-filter-open').click()
      await expect(item(first)).toBeVisible()
      await p.getByTestId('feedback-filter-all').click()
      await expect(item(first)).toBeVisible()
      await expect(item(second)).toBeVisible()
    })
  } finally {
    await context.close()
  }

  await test.step('a member: the page of a mistyped address, no inbox in the menu, a 404 from the api', async () => {
    const bobUser = await users.get('bob')
    const bobContext = await browser.newContext()
    try {
      await signInContext(bobContext, bobUser.handle, bobUser.name)
      const p = await bobContext.newPage()
      await p.goto('/feedback')
      await expect(p.getByTestId('feedback-denied')).toBeVisible()
      await expect(p.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(p.getByTestId('feedback-page')).toHaveCount(0)
      await p.goto('/definitely-not-a-page')
      await expect(p.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await p.goto('/')
      await accountMenu(p).click()
      await expect(p.getByTestId('feedback-send')).toBeVisible()
      await expect(p.getByTestId('feedback-inbox-link')).toHaveCount(0)
      for (const [method, url] of [
        ['GET', `${WEB_URL}/api/feedback`],
        ['PATCH', `${WEB_URL}/api/feedback/fbk_aaaaaaaaaaaaaaaaaaaa`],
      ] as const) {
        const res = await bobContext.request.fetch(url, {
          method,
          headers: ORIGIN,
          ...(method === 'PATCH' ? { data: { status: 'done' } } : {}),
        })
        expect({ method, status: res.status() }).toEqual({ method, status: 404 })
      }
    } finally {
      await bobContext.close()
    }
  })

  await test.step('signed out: /feedback goes to sign-in', async () => {
    const anon = await browser.newContext()
    try {
      const p = await anon.newPage()
      await p.goto('/feedback')
      await expect(p).toHaveURL(/\/signin/)
    } finally {
      await anon.close()
    }
  })
})

test('when sending fails the text stays in the dialog, the reason is shown, and a second try goes through', async ({
  browser,
  users,
}) => {
  const bob = await users.get('bob')
  const context = await browser.newContext()
  try {
    await signInContext(context, bob.handle, bob.name)
    const p = await context.newPage()
    let failures = 2
    await p.route('**/api/feedback', async (route) => {
      if (route.request().method() !== 'POST' || failures-- <= 0) return route.fallback()
      // the first: Lobby has a problem; the second: too many messages (what the api says is shown as it is)
      return failures === 1
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL', message: 'Something went wrong. Try again.' },
            }),
          })
        : route.fulfill({
            status: 429,
            contentType: 'application/json',
            headers: { 'retry-after': '60' },
            body: JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'You have sent a lot of feedback in the last hour. Try again a bit later.',
              },
            }),
          })
    })
    await p.goto('/')
    await expect(p.getByTestId('dashboard')).toBeVisible()
    await accountMenu(p).click()
    await p.getByTestId('feedback-send').click()
    const marker = unique('retry')
    const message = `${marker}\nsecond line`
    await p.getByTestId('feedback-text').fill(message)
    await p.getByTestId('feedback-submit').click()
    await expect(p.getByTestId('feedback-error')).toContainText('problem')
    await expect(p.getByTestId('feedback-text')).toHaveValue(message)
    await p.getByTestId('feedback-submit').click()
    await expect(p.getByTestId('feedback-error')).toContainText('a lot of feedback')
    await expect(p.getByTestId('feedback-text')).toHaveValue(message)
    await p.getByTestId('feedback-submit').click()
    await expect(p.getByTestId('feedback-sent')).toBeVisible()
    const alice = await users.api('alice')
    const list = (await (await alice.request.get(`${WEB_URL}/api/feedback?status=all&limit=200`)).json()) as {
      items: { text: string }[]
    }
    // exactly once, with its line break
    expect(list.items.filter((i) => i.text === message)).toHaveLength(1)
  } finally {
    await context.close()
  }
})

test('the inbox: a "Load more" that is still on its way when the filter changes never lands in the other list', async ({
  browser,
  users,
}) => {
  const aliceUser = await users.get('alice')
  const base = {
    userId: 'u-sender',
    name: 'Sender',
    kind: 'account' as const,
    expected: null,
    statusAt: null,
    context: {
      path: '/w/x',
      boardId: null,
      boardTitle: null,
      userAgent: 'Mozilla/5.0',
      viewport: { width: 1280, height: 800 },
      build: 'test',
      at: '2026-10-05T10:00:00.000Z',
    },
  }
  const item = (id: string, status: 'open' | 'done', text: string) => ({
    ...base,
    id: `fbk_${id.padEnd(12, 'x')}`,
    createdAt: '2026-10-05T10:00:00.000Z',
    status,
    text,
  })
  // Open: one message and a next page that is held; Done: one message and a next page of one more.
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const pages = (status: string | null, cursor: string | null) => {
    if (status === 'open')
      return cursor
        ? { items: [item('openlate', 'open', 'OPEN-LATE')], next: null }
        : { items: [item('openfirst', 'open', 'OPEN-FIRST')], next: 'cursor-open' }
    return cursor
      ? { items: [item('donemore', 'done', 'DONE-MORE')], next: null }
      : { items: [item('donefirst', 'done', 'DONE-FIRST')], next: 'cursor-done' }
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    await signInContext(context, aliceUser.handle, aliceUser.name)
    const p = await context.newPage()
    let openCursorRequests = 0
    await p.route(/\/api\/feedback\?/, async (route) => {
      const url = new URL(route.request().url())
      const status = url.searchParams.get('status')
      const cursor = url.searchParams.get('cursor')
      if (status === 'open' && cursor) {
        openCursorRequests++
        await held
      }
      // by then the page may have dropped the request: nothing is left to answer
      await route.fulfill({ json: pages(status, cursor) }).catch(() => {})
    })
    await p.goto('/feedback')
    await expect(p.getByTestId('feedback-item')).toHaveCount(1)
    await expect(p.getByText('OPEN-FIRST')).toBeVisible()

    await test.step('Load more on Open, then Done before the page arrives', async () => {
      await p.getByTestId('feedback-more').click()
      await expect.poll(() => openCursorRequests).toBe(1)
      await expect(p.getByTestId('feedback-more')).toBeDisabled()
      await p.getByTestId('feedback-filter-done').click()
      await expect(p.getByText('DONE-FIRST')).toBeVisible()
      // the button belongs to the Done list now: not stuck on the Open request
      await expect(p.getByTestId('feedback-more')).toBeEnabled()
    })

    await test.step('the late Open page never shows up under Done; paging goes on from Done’s own cursor', async () => {
      release()
      // give the held answer time to arrive and be (wrongly) applied
      await p.waitForTimeout(500)
      await expect(p.getByText('OPEN-LATE')).toHaveCount(0)
      await expect(p.getByTestId('feedback-item')).toHaveCount(1)
      await p.getByTestId('feedback-more').click()
      await expect(p.getByText('DONE-MORE')).toBeVisible()
      await expect(p.getByTestId('feedback-item')).toHaveCount(2)
      const statuses = await p
        .getByTestId('feedback-item')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-status')))
      expect(statuses).toEqual(['done', 'done'])
      await expect(p.getByTestId('feedback-more')).toHaveCount(0)
      await expect(p.getByText('OPEN-LATE')).toHaveCount(0)
    })
  } finally {
    await context.close()
  }
})
