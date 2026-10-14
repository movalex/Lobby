// PORTED from e2e/tests/guests.spec.ts (the tldraw spec keeps running on the default build) to the Excalidraw
// board page (owner 2C). Name-only guests (docs/WAVE3-CONTRACTS.md §2 guests): the guest always browses in a
// FRESH context with no dev sign-in, opens alice's link, types a name and lands on the board. Checked in both
// browsers and through the guest's own API calls: the marker on their name for alice, commenting as a
// commenter guest, editing as a workshop guest, their dashboard and menu, the server-side refusals, and that
// revoking the link ends the guest's view within seconds (then their session). Plus the phone guest's own view
// from e2e/tests/workshop-copy.spec.ts (F14, R2-11, DANA2-07; not ported by 3f: sharing and 3c).
//
// Differences from the tldraw spec: the board waits on the facade (`waitForLobbyBoard`); the workshop guest's
// note is made through the facade (`createNote`) and alice reads it with `item`; the comment steps use the
// ported comments kit (3c's comment tool on this page); the cursor label is the board page's overlay cursor
// (`[data-testid="cursor"] .lobby-cursor__name`, chrome.tsx) instead of tldraw's `.tl-nametag`, with the same
// 120 px cap and the same "never cut the marker" check.
import type { BrowserContext } from '@playwright/test'
import { createNote, expect, item, sceneToScreen, test } from '../tests/support/canvas.ts'
import {
  closeShare,
  memberRow,
  openShareFromButton,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import {
  commentAtScreenPoint,
  commentsApi,
  emptyCanvasPoint,
  pin,
  pressCommentTool,
  threadPopover,
} from './comments-kit.ts'
import {
  avatarButton,
  createGuestLink,
  cursorOf,
  guestOn,
  joinAsGuest,
  noHorizontalScroll,
  ORIGIN,
  tokenOf,
  waitForLobbyBoard,
} from './guests-kit.ts'

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

    // alice sees the marker: the people list (from the roster) and the Share dialog's members.
    const person = avatarButton(a, guest.id)
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
    const noteId = await createNote(g, { x: 120, y: 80 })
    await expect.poll(async () => (await item(a, noteId)) !== null, { timeout: 20_000 }).toBe(true)
    // The server stamps the note with the guest's own identity ("(guest)" and all).
    const stored = await item(a, noteId)
    expect(
      (stored?.customData as { lobbyServer?: { createdBy?: unknown } } | undefined)?.lobbyServer?.createdBy,
    ).toEqual({ uid: guest.id, name: 'Wes (guest)', guest: true })
    // A single-word name keeps its initials (the marker is not one).
    await expect(avatarButton(a, guest.id)).toHaveText('WE', { timeout: 20_000 })

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
    await g.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Back on the board (its card), the board page's own account menu is the same, and signs out from
    // there (the tldraw spec signs out from the dashboard).
    await cards.first().click()
    await waitForLobbyBoard(g)
    await g.getByTestId('user-menu').click()
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
    // ...and alice's board no longer lists them.
    await expect(avatarButton(a, guest.id)).toHaveCount(0, { timeout: 20_000 })
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
    await waitForLobbyBoard(a)
    const label = cursorOf(a, guest.id).locator('.lobby-cursor__name')
    await expect
      .poll(
        async () => {
          const p = await sceneToScreen(g, { x: 300, y: 250 })
          await g.mouse.move(p.x - 30, p.y - 30)
          await g.mouse.move(p.x, p.y, { steps: 4 })
          return label.filter({ hasText: '(guest)' }).count()
        },
        { timeout: 20_000 },
      )
      .toBe(1)
    // Nothing of the label is cut off, and it keeps the cap a long account name is cut at...
    const fit = await label.evaluate((el) => ({
      whole: el.scrollWidth <= el.clientWidth,
      width: el.getBoundingClientRect().width,
      cap: getComputedStyle(el).maxWidth,
    }))
    expect(fit.whole).toBe(true)
    expect(fit.cap).toBe('120px')
    expect(fit.width).toBeLessThanOrEqual(120)
    // ...because the name in front of the marker is the shortened one.
    await expect(label).toHaveText('Alexandr… (guest)')
    // The people list's name (from the same ticket) says so too; the full name shows elsewhere.
    await expect(avatarButton(a, guest.id)).toHaveAttribute('title', 'Alexandr… (guest)')

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

// PORTED from e2e/tests/workshop-copy.spec.ts (its second test): a phone guest's own view of the board page.
test('F14, R2-11, DANA2-07: a commenting phone guest: no link badge, "(guest, you)", no key hints; revoked, one message', async ({
  browser,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  expect(
    (
      await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, { role: 'editor', expiresInHours: 3 })
    ).status(),
  ).toBe(201)
  const review = (await (
    await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'commenter',
      expiresInDays: 14,
      allowGuests: true,
    })
  ).json()) as { id: string; url: string }
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  try {
    const { page } = await guestOn(ctx, tokenOf(review.url), 'Dana Whitfield')
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

    // R2-11: the workshop link's "Link: edit · until …" is not this commenter's access.
    await page.getByTestId('topbar-overflow').click()
    const menu = page.getByTestId('topbar-overflow-panel')
    await expect(menu).toHaveAttribute('data-open', 'true')
    await expect(menu).toContainText('Your account')
    await expect(page.getByTestId('share-badge')).toHaveCount(0)
    await expect(menu.locator('[data-feature="sharing"]')).toBeHidden() // no empty "Sharing" row either
    await expect(menu).not.toContainText('Link:', { useInnerText: true })
    await page.keyboard.press('Escape')

    // F14: her own comment reads "(guest, you)"; no keyboard hints on a phone.
    const guestApi = {
      fetch: (method: string, path: string, data?: unknown) =>
        ctx.request.fetch(path, { method, data, headers: ORIGIN }),
    }
    await commentsApi(guestApi as never).createThread(
      board,
      { kind: 'point', x: 200, y: 200 },
      'This ember one is the mood for the cups.',
    )
    // On a phone the rail is folded behind one button (R13).
    const railToggle = page.getByTestId('dock-rail-toggle')
    if (await railToggle.isVisible()) await railToggle.click()
    await page.getByTestId('dock-tab-comments').click()
    const panel = page.getByTestId('comments-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.dr-cpanel__check kbd')).toBeHidden()
    await panel.getByTestId('comment-row').first().click()
    const item = page.getByTestId('comment-item').first()
    await expect(item).toContainText('Dana Whitfield (guest, you)')
    await expect(item).not.toContainText('(guest) (you)')
    await expect(page.locator('.dr-ccomposer__hint')).toBeHidden()
    await expect(page.getByTestId('comment-submit')).toBeVisible()

    // DANA2-07: revoked, one message on both screens, and no button that leads nowhere.
    expect(
      (await aliceApi.fetch('POST', `/api/boards/${board}/review-links/${review.id}/revoke`)).status(),
    ).toBeLessThan(300)
    const first = page.getByTestId('guest-no-access').or(page.getByTestId('guest-ended'))
    await expect(first).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('lobby-board')).toHaveCount(0)
    const main = page.locator('main')
    const expectOneMessage = async () => {
      await expect(main.getByRole('heading', { level: 1 })).toHaveText('Your guest access has ended')
      await expect(main).toContainText('ask whoever shared the link with you for a new one')
      await expect(main.getByRole('link', { name: 'Back to your boards' })).toHaveCount(0)
      await expect(main.getByRole('button', { name: /Back to your boards|request/i })).toHaveCount(0)
      await expect(main.locator('.dr-btn')).toHaveCount(0) // only the quiet "Sign in" link
      await expect(main.getByRole('button', { name: 'Sign in' })).toBeVisible()
    }
    await expectOneMessage()
    await expect(page.getByTestId('guest-ended')).toBeVisible({ timeout: 20_000 })
    await expectOneMessage()
    expect(await noHorizontalScroll(page)).toBe(true)
  } finally {
    await ctx.close()
  }
})
