// Name-only guests (docs/WAVE3-CONTRACTS.md §2 guests). The guest always browses in a FRESH context
// with no dev sign-in: they open alice's link, type a name and land on the board. Checked in both
// browsers and through the guest's own API calls: the marker on their name for alice, commenting as
// a commenter guest, editing as a workshop guest, their dashboard and menu, the server-side refusals,
// and that revoking the link ends the guest's view within seconds (then their session).
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { edit, read, toScreen, waitForBoard } from './support/board.ts'
import {
  commentAtScreenPoint,
  emptyCanvasPoint,
  pin,
  pressCommentTool,
  threadPopover,
} from './support/comments.ts'
import {
  closeShare,
  memberRow,
  openShareFromButton,
  shareDialog,
  signedInContext,
} from './support/dashboard-share.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'

const ORIGIN = { origin: WEB_URL }

/** alice opens `board` and creates a guest-enabled link from the Share dialog; returns its URL. */
async function createGuestLink(page: Page, board: string, kind: 'review' | 'workshop'): Promise<string> {
  await page.goto(`/b/${board}`)
  await waitForBoard(page)
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  const guests = dialog.getByTestId(kind === 'review' ? 'review-link-guests' : 'workshop-link-guests')
  // Off by default; the label says what it does.
  await expect(guests).not.toBeChecked()
  await expect(guests).toHaveAccessibleName('Anyone with the link can join with just a name (no account)')
  await guests.check()
  if (kind === 'review') await dialog.getByTestId('review-link-role').selectOption('commenter')
  await dialog.getByTestId(kind === 'review' ? 'review-link-create' : 'workshop-link-create').click()
  const row = dialog.getByTestId(kind === 'review' ? 'review-link-row' : 'workshop-link-row')
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-allow-guests', 'true')
  await expect(row.getByTestId('link-guests-allowed')).toBeVisible()
  const url = await row.getByTestId('review-link-url').inputValue()
  expect(url).toMatch(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
  await closeShare(page)
  return url
}

/** A fresh browser context (no sign-in at all) that joins `link` as a guest called `name`. */
async function joinAsGuest(
  browser: Browser,
  link: string,
  name: string,
  opts: { viewport?: { width: number; height: number }; colorScheme?: 'light' | 'dark' } = {},
): Promise<{ context: BrowserContext; page: Page; id: string }> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 820 },
    colorScheme: opts.colorScheme ?? 'light',
  })
  expect(await context.cookies()).toEqual([])
  const page = await context.newPage()
  await page.goto(link)
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
  await expect(page.getByTestId('invite-signin')).toHaveText('Sign in instead')
  const input = page.getByTestId('invite-guest-name')
  await expect(input).toHaveAccessibleName('Your name')
  // An empty name is refused here (the API refuses it too), with the reason next to the field.
  await page.getByTestId('invite-guest-join').click()
  await expect(page.getByTestId('invite-guest-name-error')).toHaveText('Enter your name.')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await input.fill(name)
  await expect(page.getByTestId('invite-guest-form')).toContainText(`“${name} (guest)”`)
  await page.getByTestId('invite-guest-join').click()
  // A guest lands straight on the board.
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  const menu = page.getByTestId('user-menu')
  await expect(menu).toHaveAttribute('data-kind', 'guest')
  await expect(menu.getByTestId('guest-tag')).toHaveText('Guest')
  const id = (await menu.getAttribute('data-user-id')) ?? ''
  expect(id).toMatch(/^usr_/)
  return { context, page, id }
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('a commenter guest joins with just a name (phone width), shows as "(guest)" to alice, comments, and revoking the link ends their view within seconds', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await signedInContext(browser, 'alice')
  const aliceApi = await users.api('alice')
  const contexts: BrowserContext[] = [alice.context]
  try {
    const a = alice.page
    const link = await createGuestLink(a, board, 'review')

    // The guest, on a phone-sized screen.
    const phone = { width: 390, height: 844 }
    const guest = await joinAsGuest(browser, link, 'Sam Rivera', { viewport: phone })
    contexts.push(guest.context)
    const g = guest.page
    expect(await noHorizontalScroll(g)).toBe(true)
    await expect(g.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'commenter')
    await testInfo.attach('guest-board-390.png', { body: await g.screenshot(), contentType: 'image/png' })

    // The server knows who this is: a guest with the marker on their name, and nothing else.
    const me = await g.request.get('/api/me')
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({
      kind: 'guest',
      user: { id: guest.id, name: 'Sam Rivera (guest)', handle: null },
      workspaces: [{ name: 'Dev Studio', role: 'guest' }],
    })
    const devStudio = users.devStudioId
    for (const [method, path, data] of [
      ['POST', `/api/workspaces/${devStudio}/boards`, { title: 'Mine' }],
      ['POST', `/api/boards/${board}/review-links`, { role: 'viewer' }],
      ['POST', `/api/boards/${board}/access-requests`, { role: 'editor' }],
      ['GET', `/api/workspaces/${devStudio}/members`, undefined],
    ] as const) {
      const res = await g.request.fetch(path, { method, headers: ORIGIN, ...(data ? { data } : {}) })
      expect(res.status(), `${method} ${path}`).toBe(403)
      expect((await res.json()).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    }

    // alice sees the marker: the people list (from the sync ticket) and the Share dialog's members.
    const person = a.locator(`[data-testid="presence-user"][data-user-id="${guest.id}"] button`)
    await expect(person).toHaveAttribute('title', 'Sam Rivera (guest)', { timeout: 20_000 })
    await expect(person).toHaveText('SR')
    await openShareFromButton(a)
    const row0 = memberRow(a, guest.id)
    await expect(row0).toContainText('Sam Rivera (guest)')
    await expect(row0).toHaveAttribute('data-role', 'commenter')
    // A guest is never offered ownership (the server refuses it too).
    await expect(row0).toHaveAttribute('data-guest', 'true')
    await expect(row0.getByTestId('member-transfer')).toHaveCount(0)
    await expect(row0.locator('[data-testid="member-role"] option[value="owner"]')).toHaveCount(0)
    await closeShare(a)

    // The guest comments (the canvas stays read-only for them); alice sees "(guest)" on it.
    await pressCommentTool(g)
    const threadId = await commentAtScreenPoint(g, await emptyCanvasPoint(g), 'Love the direction')
    await expect(pin(a, threadId)).toBeVisible({ timeout: 20_000 })
    await pin(a, threadId).click()
    await expect(threadPopover(a, threadId)).toContainText('Sam Rivera (guest)')
    await expect(threadPopover(a, threadId)).toContainText('Love the direction')
    const threads = (await (await aliceApi.fetch('GET', `/api/boards/${board}/threads`)).json()) as {
      threads: { id: string; comments: { author: { id: string; name: string } }[] }[]
    }
    expect(threads.threads.find((t) => t.id === threadId)?.comments[0]?.author).toEqual(
      expect.objectContaining({ id: guest.id, name: 'Sam Rivera (guest)' }),
    )
    await a.keyboard.press('Escape')

    // Revoking the link with "remove access": the guest's board closes within seconds...
    await openShareFromButton(a)
    const row = shareDialog(a).getByTestId('review-link-row')
    await expect(row).toContainText('1 person joined')
    const started = Date.now()
    await row.getByTestId('review-link-revoke').click()
    await expect(row.getByTestId('review-link-remove-access')).toBeChecked()
    await row.getByTestId('review-link-revoke-confirm').click()
    await expect(g.getByTestId('no-access').or(g.getByTestId('guest-ended'))).toBeVisible({ timeout: 15_000 })
    const ms = Date.now() - started
    testInfo.annotations.push({ type: 'guest revocation', description: `${ms} ms (target < 15000 ms)` })
    expect(ms).toBeLessThan(15_000)
    expect([401, 404]).toContain((await g.request.get(`/api/boards/${board}`)).status())
    await expect(memberRow(a, guest.id)).toHaveCount(0)
    // ...then the guest session itself ends (no board left), and the tab says so instead of
    // offering a sign-in form the guest has no account for.
    await expect.poll(async () => (await g.request.get('/api/me')).status(), { timeout: 15_000 }).toBe(401)
    await expect(g.getByTestId('guest-ended')).toBeVisible({ timeout: 20_000 })
    await expect(g.getByTestId('guest-ended')).toContainText('Your guest access has ended')
    expect(await noHorizontalScroll(g)).toBe(true)
    // The link itself is dead for newcomers.
    const again = await browser.newContext()
    contexts.push(again)
    const late = await again.newPage()
    await late.goto(link)
    await expect(late.getByTestId('invite-invalid')).toBeVisible()
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('a workshop guest (dark theme) can edit, sees only their boards with the guest note, and signing out ends their access', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await signedInContext(browser, 'alice')
  const aliceApi = await users.api('alice')
  // Another Dev Studio board shared with the whole workspace: guests must not see it.
  const other = await aliceApi.createBoard(users.devStudioId, 'Team board')
  await aliceApi.patchBoard(other.id, { visibility: 'workspace_edit' })
  const contexts: BrowserContext[] = [alice.context]
  try {
    const a = alice.page
    const link = await createGuestLink(a, board, 'workshop')
    const guest = await joinAsGuest(browser, link, 'Wes', { colorScheme: 'dark' })
    contexts.push(guest.context)
    const g = guest.page
    // Editors get no read-only pill; the guest's note shows up for alice.
    await expect(g.getByTestId('readonly-pill')).toHaveCount(0)
    await edit(g, (ed) => ed.createShape({ id: 'shape:guest-note', type: 'note', x: 120, y: 80, props: {} }))
    await expect
      .poll(() => read(a, (ed) => ed.getShape('shape:guest-note') !== undefined), { timeout: 20_000 })
      .toBe(true)
    // A single-word name keeps its initials (the marker is not one).
    await expect(a.locator(`[data-testid="presence-user"][data-user-id="${guest.id}"] button`)).toHaveText(
      'WE',
      { timeout: 20_000 },
    )

    // The guest's dashboard: only the board of their link, and a note saying they are a guest.
    await g.goto('/')
    await expect(g.getByTestId('dashboard')).toBeVisible()
    await expect(g.getByTestId('guest-banner')).toContainText(
      "You're a guest. Sign in with an account to keep access.",
    )
    const cards = g.getByTestId('board-grid').locator('[data-testid="board-card"]')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toHaveAttribute('data-board-id', board)
    await expect(g.getByTestId('create-board')).toHaveCount(0)
    await testInfo.attach('guest-dashboard-dark.png', {
      body: await g.screenshot(),
      contentType: 'image/png',
    })

    // The menu says "Guest" and that signing out needs the link again; no "sign out everywhere".
    await g.getByTestId('user-menu').click()
    const menu = g.getByRole('dialog', { name: 'Your guest access' })
    await expect(menu.getByTestId('guest-menu-note')).toContainText("you'll need the link again")
    await expect(menu.getByTestId('sign-out-everywhere')).toHaveCount(0)
    await menu.getByTestId('sign-out').click()
    await expect(g).toHaveURL(/\/signin/)
    expect((await g.request.get('/api/me')).status()).toBe(401)
    // Signed out, the guest can never come back as the same guest: their grant goes too.
    await expect
      .poll(
        async () => {
          const res = await aliceApi.fetch('GET', `/api/boards/${board}/members`)
          const body = (await res.json()) as { members: { user: { id: string } }[] }
          return body.members.some((m) => m.user.id === guest.id)
        },
        { timeout: 15_000 },
      )
      .toBe(false)
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('a long guest name keeps its "(guest)" marker: on the cursor label and in the Share dialog on a phone', async ({
  browser,
  board,
}, testInfo) => {
  const alice = await signedInContext(browser, 'alice')
  const contexts: BrowserContext[] = [alice.context]
  try {
    const a = alice.page
    const link = await createGuestLink(a, board, 'review')
    const name = 'Alexandra Richardson-Wells'
    const guest = await joinAsGuest(browser, link, name)
    contexts.push(guest.context)
    const g = guest.page

    // The guest moves their pointer over the canvas: alice sees the cursor label, whose text is
    // shortened in front of the marker so the label (at most 120 px wide) never cuts "(guest)".
    await waitForBoard(a)
    const label = a.locator('.tl-collaborator__cursor .tl-nametag').filter({ hasText: '(guest)' })
    await expect
      .poll(
        async () => {
          const p = await toScreen(g, { x: 300, y: 250 })
          await g.mouse.move(p.x - 30, p.y - 30)
          await g.mouse.move(p.x, p.y, { steps: 4 })
          return label.count()
        },
        { timeout: 20_000 },
      )
      .toBe(1)
    // Nothing of the label is cut off (tldraw would cut the end: the marker)...
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    // ...because the name in front of the marker is the shortened one.
    await expect(label).toHaveText('Alexandr… (guest)')
    // The people list's name (from the same ticket) says so too; the full name shows elsewhere.
    await expect(
      a.locator(`[data-testid="presence-user"][data-user-id="${guest.id}"] button`),
    ).toHaveAttribute('title', 'Alexandr… (guest)')

    // On a phone, alice's Share dialog cuts the long name, never the marker.
    await a.setViewportSize({ width: 390, height: 844 })
    await openShareFromButton(a)
    const row = memberRow(a, guest.id)
    await expect(row).toContainText(`${name} (guest)`)
    const marker = row.getByTestId('member-guest-marker')
    await expect(marker).toBeVisible()
    const fits = await marker.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const parent = (el.parentElement as HTMLElement).getBoundingClientRect()
      return box.width > 0 && box.right <= parent.right + 0.5 && box.left >= parent.left
    })
    expect(fits).toBe(true)
    expect(await noHorizontalScroll(a)).toBe(true)
    await testInfo.attach('share-long-guest-390.png', {
      body: await a.screenshot(),
      contentType: 'image/png',
    })
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})
