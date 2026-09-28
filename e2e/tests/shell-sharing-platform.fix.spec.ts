// Fix batch "shell-sharing-platform" (board shell, sharing, dashboard): each test is the browser check
// for one fixed finding. The finding ids are in the test titles; the API/unit tests next to the code
// cover the server rules (apps/api/test/features/dashboard/workshop-links.test.ts, invitations,
// members, boards) and apps/sync (join-queue, touch).
import type { Browser, Page } from '@playwright/test'
import { displayName, signInContext } from './support/api.ts'
import { edit, getShape, shapeCenterOnScreen, waitForBoard } from './support/board.ts'
import { commentsApi, mentionToken } from './support/comments.ts'
import {
  closeShare,
  freshHandle,
  mainCard,
  memberRow,
  openShareFromButton,
  shareDialog,
  signedInContext,
} from './support/dashboard-share.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'

async function contextAt(
  browser: Browser,
  handle: string,
  vp: { width: number; height: number },
  touch = false,
) {
  const context = await browser.newContext({
    viewport: vp,
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: touch ? 3 : 1,
  })
  await signInContext(context, handle, displayName(handle))
  return { context, page: await context.newPage() }
}

/** Every visible control of the board top bar, with its box. */
const topBarBoxes = (page: Page) =>
  page.getByTestId('topbar').evaluate((bar) =>
    [...bar.querySelectorAll('button, a, select, input, [role="status"]')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => {
        const r = e.getBoundingClientRect()
        return {
          id: e.getAttribute('data-testid') ?? e.getAttribute('aria-label') ?? e.tagName,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        }
      }),
  )

const note = (id: string, text: string, x = 240, y = 200) =>
  ({ id, type: 'note', x, y, props: { richText: richText(text) } }) as const

// ---- PRI-02 ----------------------------------------------------------------------------------------

for (const [label, vp, touch] of [
  ['390×844 (touch)', { width: 390, height: 844 }, true],
  ['768×1024', { width: 768, height: 1024 }, false],
] as const) {
  test(`PRI-02: at ${label} every top-bar control is inside the viewport, the title keeps 96 px, and the bell, Share and the ⋯ menu open`, async ({
    board,
    session,
    browser,
  }) => {
    const a = await session('alice')
    await edit(a.page, (ed, s) => ed.createShape(s), note('shape:pri02', 'Hero shot'))
    await a.page.getByTestId('board-title').click()
    await a.page
      .getByTestId('board-title-input')
      .fill('Spring campaign storyboard and moodboard review, round two')
    await a.page.keyboard.press('Enter')
    const { context, page } = await contextAt(browser, 'alice', vp, touch)
    try {
      await page.goto(`/b/${board}`)
      await waitForBoard(page)
      await expect(page.getByTestId('topbar')).toHaveAttribute(
        'data-width',
        vp.width <= 480 ? 'phone' : 'tablet',
      )
      const boxes = await topBarBoxes(page)
      expect(boxes.map((b) => b.id)).toEqual(
        expect.arrayContaining(['board-title', 'notifications-bell', 'topbar-overflow', 'share-button']),
      )
      const outside = boxes.filter(
        (b) => b.left < 0 || b.right > vp.width || b.top < 0 || b.bottom > vp.height,
      )
      expect(outside).toEqual([])
      const account = await page
        .getByTestId(vp.width <= 480 ? 'topbar-overflow' : 'dev-identity-badge')
        .boundingBox()
      expect((account?.x ?? -1) + (account?.width ?? 0)).toBeLessThanOrEqual(vp.width)
      const title = await page.getByTestId('board-title').boundingBox()
      expect(title?.width ?? 0).toBeGreaterThanOrEqual(96)
      // Present, Export, the timer and the sharing badge are in the menu, not the bar.
      for (const id of ['present-button', 'export-button', 'timer-pill', 'share-badge'])
        expect(
          boxes.map((b) => b.id),
          id,
        ).not.toContain(id)

      await page.getByTestId('notifications-bell').click()
      await expect(page.getByTestId('notifications-panel')).toBeVisible()
      await page.keyboard.press('Escape')

      await page.getByTestId('topbar-overflow').click()
      const menu = page.getByTestId('topbar-overflow-panel')
      await expect(menu).toHaveAttribute('data-open', 'true')
      await expect(menu.getByTestId('present-button')).toBeVisible()
      await expect(menu.getByTestId('export-button')).toBeVisible()
      await expect(menu.getByTestId('share-badge')).toBeVisible()
      const m = await menu.boundingBox()
      expect((m?.x ?? -1) >= 0 && (m?.x ?? 0) + (m?.width ?? 0) <= vp.width).toBe(true)
      // A control in the menu works as it does in the bar: Export opens its dialog.
      await menu.getByTestId('export-button').click()
      await expect(page.getByTestId('export-dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveAttribute('data-open', 'false')

      await page.getByTestId('share-button').click()
      await expect(shareDialog(page)).toBeVisible()
      const d = await shareDialog(page).locator('.dr-dialog__panel').boundingBox()
      expect((d?.x ?? -1) >= 0 && (d?.x ?? 0) + (d?.width ?? 0) <= vp.width).toBe(true)
    } finally {
      await context.close()
    }
  })
}

// ---- RETRO-22a -------------------------------------------------------------------------------------

test('RETRO-22a: Tab from the top of the page reaches the breadcrumb, title, feature controls and Share first; the DEV badge comes after the canvas controls', async ({
  session,
}) => {
  const a = await session('alice')
  await a.page.reload()
  await waitForBoard(a.page)
  await a.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const stops: { id: string; inTopBar: boolean }[] = []
  for (let i = 0; i < 40; i++) {
    await a.page.keyboard.press('Tab')
    stops.push(
      await a.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        return {
          id: el?.getAttribute('data-testid') ?? el?.getAttribute('aria-label') ?? el?.tagName ?? '',
          inTopBar: !!el?.closest('.dr-topbar'),
        }
      }),
    )
  }
  const ids = stops.map((s) => s.id)
  expect(stops[0]).toEqual({ id: 'Back to Dev Studio', inTopBar: true })
  expect(ids.indexOf('board-title')).toBeLessThan(4)
  const share = ids.indexOf('share-button')
  expect(share).toBeGreaterThan(0)
  expect(share).toBeLessThan(15)
  expect(stops.slice(0, share + 1).every((s) => s.inTopBar)).toBe(true)
  // The account badge is drawn in the bar but tabbed to last, after the dock and tldraw's toolbar.
  const badge = ids.indexOf('dev-identity-badge')
  expect(badge).toBeGreaterThan(ids.indexOf('tools.select'))
  expect(ids.indexOf('tools.select')).toBeGreaterThan(share)
  const bar = await a.page.getByTestId('topbar').boundingBox()
  const b = await a.page.getByTestId('dev-identity-badge').boundingBox()
  expect((b?.y ?? 99) + (b?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0))
})

// ---- PRI-08 + PRI-09b ------------------------------------------------------------------------------

test('PRI-08/PRI-09b: a commenter’s drag shows one hint with Request; the role pill opens the same form; role changes are announced and the pill follows', async ({
  session,
  users,
  board,
}) => {
  const a = await session('alice')
  await edit(a.page, (ed, s) => ed.createShape(s), note('shape:hint', 'Try to move me'))
  const c = await session('carol', { role: 'commenter' })
  await expect.poll(() => getShape(c.page, 'shape:hint').then((s) => s !== null)).toBe(true)
  const start = await shapeCenterOnScreen(c.page, 'shape:hint')
  const before = await getShape(c.page, 'shape:hint')

  await test.step('the first blocked drag explains, once, and names who to ask', async () => {
    await c.page.mouse.move(start.x, start.y)
    await c.page.mouse.down()
    await c.page.mouse.move(start.x + 80, start.y + 50, { steps: 8 })
    await c.page.mouse.up()
    const hint = c.page.getByTestId('blocked-edit-hint')
    await expect(hint).toContainText(
      `You can comment on this board. Ask ${displayName('alice')} for edit access.`,
    )
    await hint.getByTestId('blocked-edit-request').click()
    await expect(shareDialog(c.page).getByTestId('share-ask-section')).toBeVisible()
    await expect(shareDialog(c.page).getByTestId('access-request-role')).toBeFocused()
    await closeShare(c.page)
    expect((await getShape(c.page, 'shape:hint'))?.x).toBe(before?.x) // nothing moved
    // Double-click on the note: no second hint.
    await c.page.mouse.dblclick(start.x, start.y)
    await c.page.waitForTimeout(500)
    await expect(c.page.getByTestId('blocked-edit-hint')).toHaveCount(0)
  })

  await test.step('the role pill is a button to the same request form', async () => {
    await c.page.getByTestId('readonly-pill').click()
    await expect(shareDialog(c.page).getByTestId('share-ask-section')).toBeVisible()
    await shareDialog(c.page).getByTestId('access-request-button').click()
    await expect(shareDialog(c.page).getByTestId('access-request-status')).toContainText(
      'Edit access requested just now',
    )
    await closeShare(c.page)
  })

  await test.step('alice gives edit access: carol is told, and the pill goes away', async () => {
    await users.grant(board, 'carol', 'editor')
    await expect(c.page.getByTestId('role-change-toast')).toHaveText('You can edit this board now', {
      timeout: 20_000,
    })
    await expect(c.page.getByTestId('readonly-pill')).toHaveCount(0)
  })

  await test.step('and back to viewer: "Your access changed to Can view", the pill says so', async () => {
    await users.grant(board, 'carol', 'viewer')
    await expect(c.page.getByTestId('role-change-toast')).toHaveText('Your access changed to Can view', {
      timeout: 20_000,
    })
    await expect(c.page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')
  })
})

// ---- RETRO-04a --------------------------------------------------------------------------------------

test('RETRO-04a: a workshop link lets an outsider edit after signing in; +1 h extends it; revoking with removal ends the edit access at once; a viewer cannot make one', async ({
  users,
  browser,
}) => {
  const aliceUser = await users.get('alice')
  const aliceApi = await users.api('alice')
  const boardId = (await aliceApi.createBoard(aliceUser.personalWorkspaceId, 'Workshop board')).id
  const alice = await signedInContext(browser, 'alice')
  const contexts = [alice.context]
  try {
    const a = alice.page
    await a.goto(`/b/${boardId}`)
    await waitForBoard(a)
    await openShareFromButton(a)
    const section = shareDialog(a).getByTestId('workshop-links')
    await expect(section).toContainText('anyone with the link can edit, after signing in')
    await expect(section.getByTestId('workshop-link-expiry')).toHaveValue('3')
    await section.getByTestId('workshop-link-create').click()
    const row = section.getByTestId('workshop-link-row')
    await expect(row).toContainText('Can edit · until')
    const link = await row.getByTestId('review-link-url').inputValue()
    const firstEnd = Date.parse((await row.getAttribute('data-expires-at')) ?? '')
    expect(firstEnd - Date.now()).toBeGreaterThan(3 * 3600_000 - 120_000)
    expect(firstEnd - Date.now()).toBeLessThan(3 * 3600_000 + 60_000)
    await closeShare(a)
    await expect(a.getByTestId('share-badge')).toHaveText(/^Link: edit · until /)

    // An outsider opens it, signs in, and lands on the board as an editor (no second click).
    const outsider = await browser.newContext()
    contexts.push(outsider)
    const o = await outsider.newPage()
    await o.goto(link)
    await expect(o.getByTestId('invite-role-label')).toHaveText('Can edit')
    await o.getByTestId('invite-signin').click()
    const who = { handle: freshHandle('wren'), name: 'Wren Adler' }
    await o.getByTestId('signin-handle').fill(who.handle)
    await o.getByTestId('signin-name').fill(who.name)
    await o.getByTestId('signin-submit').click()
    await expect(o).toHaveURL(new RegExp(`/b/${boardId}$`))
    await waitForBoard(o)
    await expect(o.getByTestId('readonly-pill')).toHaveCount(0)
    await edit(o, (ed, s) => ed.createShape(s), note('shape:from-workshop', 'Idea from the workshop'))
    await expect.poll(() => getShape(a, 'shape:from-workshop').then((s) => s !== null)).toBe(true)

    // +1 h
    await openShareFromButton(a)
    const again = shareDialog(a).getByTestId('workshop-link-row')
    await expect(again).toContainText('1 person joined')
    await again.getByTestId('workshop-link-extend').click()
    await expect
      .poll(async () => Date.parse((await again.getAttribute('data-expires-at')) ?? '') - firstEnd)
      .toBe(3600_000)

    // Revoke, removing the access it gave: the outsider's open board closes.
    const started = Date.now()
    await again.getByTestId('review-link-revoke').click()
    await expect(again.getByTestId('review-link-remove-access')).toBeChecked()
    await again.getByTestId('review-link-revoke-confirm').click()
    await expect(o.getByTestId('no-access')).toBeVisible({ timeout: 15_000 })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect((await o.request.get(`/api/boards/${boardId}`)).status()).toBe(404)

    // A viewer of the board: no workshop section, and the API refuses (403).
    const viewerBoard = await users.createBoard('Viewer cannot share')
    await users.grant(viewerBoard, 'bob', 'viewer')
    const bobCtx = await signedInContext(browser, 'bob')
    contexts.push(bobCtx.context)
    await bobCtx.page.goto(`/b/${viewerBoard}`)
    await waitForBoard(bobCtx.page)
    await openShareFromButton(bobCtx.page)
    await expect(shareDialog(bobCtx.page).getByTestId('workshop-links')).toHaveCount(0)
    const refused = await bobCtx.context.request.post(`${WEB_URL}/api/boards/${viewerBoard}/review-links`, {
      headers: { origin: WEB_URL },
      data: { role: 'editor' },
    })
    expect(refused.status()).toBe(403)
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

// ---- PRI-05a -----------------------------------------------------------------------------------------

test('PRI-05a: alice mentions Priya; Priya’s dashboard shows the bell count and “1 new · mentioned you” on the card without opening the board; the item opens the thread', async ({
  board,
  users,
  session,
  browser,
}) => {
  const priya = await users.grant(board, 'priya', 'commenter')
  const priyaApi = await users.api('priya')
  await commentsApi(priyaApi).markAllNotificationsRead()
  const a = await session('alice')
  await edit(a.page, (ed, s) => ed.createShape(s), note('shape:mention', 'Hero shot'))
  const thread = await commentsApi(await users.api('alice')).createThread(
    board,
    { kind: 'point', x: 400, y: 300 },
    `${mentionToken(priya.name, priya.id)} can you check the colour grade?`,
  )
  const p = await signedInContext(browser, 'priya')
  try {
    await p.page.goto(`/w/${users.devStudioId}/all`)
    const bell = p.page.getByTestId('dashboard-bell')
    await expect(bell).toHaveAttribute('data-unread', '1')
    await expect(p.page.getByTestId('dashboard-bell-count')).toHaveText('1')
    const card = mainCard(p.page, board)
    await expect(card.getByTestId('board-card-news')).toHaveText('1 new · mentioned you')
    await bell.click()
    const item = p.page.getByTestId('dashboard-notification-item')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText(`${displayName('alice')} mentioned you on`)
    await expect(item).toHaveAttribute('data-unread', 'true')
    await item.click()
    // The board opens at the thread (the comments feature consumes ?thread= and opens it).
    await expect(p.page).toHaveURL(new RegExp(`/b/${board}`))
    await waitForBoard(p.page)
    await expect(p.page.getByTestId('thread-popover')).toBeVisible({ timeout: 15_000 })
    expect(thread.id).toMatch(/^thr_/)
    await expect.poll(async () => (await commentsApi(priyaApi).notifications()).unreadCount).toBe(0)
    // Back on the dashboard, the card has nothing new any more.
    await p.page.goto(`/w/${users.devStudioId}/all`)
    await expect(mainCard(p.page, board)).toBeVisible()
    await expect(mainCard(p.page, board).getByTestId('board-card-news')).toHaveCount(0)
    await expect(p.page.getByTestId('dashboard-bell')).toHaveAttribute('data-unread', '0')
  } finally {
    await p.context.close()
  }
})

// ---- RETRO-19 ----------------------------------------------------------------------------------------

test('RETRO-19: a note edit on the canvas makes its card say “Edited just now” and lead “Last edited”', async ({
  users,
  session,
  board,
}) => {
  // `board` was created first; `later` after it, so it leads "Last edited" until the canvas edit.
  const later = await users.createBoard('Created later, never edited')
  const aliceApi = await users.api('alice')
  const updated = async (id: string) =>
    Date.parse(
      ((await (await aliceApi.fetch('GET', `/api/boards/${id}`)).json()) as { board: { updatedAt: string } })
        .board.updatedAt,
    )
  const before = await updated(board)
  expect(before).toBeLessThan(await updated(later))
  const a = await session('alice')
  await edit(a.page, (ed, s) => ed.createShape(s), note('shape:edited', 'An edit on the canvas'))
  await expect.poll(() => updated(board), { timeout: 15_000 }).toBeGreaterThan(await updated(later))
  await a.page.goto(`/w/${users.devStudioId}/all`)
  await a.page.getByTestId('dashboard-sort').selectOption('edited')
  // The cards arrive after the sort control (evaluateAll below does not wait for them).
  await expect(mainCard(a.page, board)).toBeVisible()
  await expect(mainCard(a.page, later)).toBeVisible()
  const ids = await a.page
    .getByTestId('board-grid')
    .getByTestId('board-card')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-board-id')))
  expect(ids.indexOf(board)).toBeLessThan(ids.indexOf(later))
  await expect(mainCard(a.page, board)).toContainText('Edited just now')
})

// ---- PRI-11 ------------------------------------------------------------------------------------------

test('PRI-11: the card title and body open the board; the ☆ and ⋯ keep their own actions', async ({
  users,
  session,
  board,
}) => {
  const a = await session('alice')
  await a.page.goto(`/w/${users.devStudioId}/all`)
  const card = mainCard(a.page, board)
  await card.getByTestId('board-star').click()
  await expect(card).toHaveAttribute('data-starred', 'true')
  await expect(a.page).toHaveURL(/\/w\//)
  await card.getByTestId('board-card-menu').click()
  await expect(a.page.getByRole('menu')).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(a.page).toHaveURL(/\/w\//)
  // A person clicks where they see the title: the card's one link (stretched over the card) takes it.
  const clickOn = async (target: ReturnType<Page['locator']>) => {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box) throw new Error('not on screen')
    await a.page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + box.height / 2)
  }
  await clickOn(card.getByTestId('board-card-title'))
  await expect(a.page).toHaveURL(new RegExp(`/b/${board}$`))
  await waitForBoard(a.page)
  await a.page.goto(`/w/${users.devStudioId}/all`)
  // the body below the title (the "Edited …" line) opens it too
  await clickOn(mainCard(a.page, board).locator('.dr-bcard__meta'))
  await expect(a.page).toHaveURL(new RegExp(`/b/${board}$`))
  // still one link per card (keyboard: one stop)
  await a.page.goto(`/w/${users.devStudioId}/all`)
  await expect(mainCard(a.page, board).getByRole('link')).toHaveCount(1)
})

// ---- RETRO-17 + PRI-07 --------------------------------------------------------------------------------

test('RETRO-17/PRI-07: a review-link guest’s Share dialog says the link lets people comment (not just “Private”) and shows no @handles', async ({
  users,
  browser,
}) => {
  const aliceUser = await users.get('alice')
  const aliceApi = await users.api('alice')
  const boardId = (await aliceApi.createBoard(aliceUser.personalWorkspaceId, 'Client review, cut 2')).id
  const created = await aliceApi.fetch('POST', `/api/boards/${boardId}/review-links`, { role: 'commenter' })
  const { url } = (await created.json()) as { url: string }
  const guest = await browser.newContext()
  try {
    const g = await guest.newPage()
    await signInContext(guest, freshHandle('gia'), 'Gia Rossi')
    await g.goto(url)
    await g.getByTestId('invite-accept').click()
    await expect(g).toHaveURL(new RegExp(`/b/${boardId}$`))
    await waitForBoard(g)
    await openShareFromButton(g)
    const dialog = shareDialog(g)
    await expect(dialog.getByTestId('visibility-select')).toHaveValue('private')
    await expect(dialog.getByTestId('share-link-note')).toHaveText(
      /^Anyone with the review link can comment until /,
    )
    await expect(memberRow(g, aliceUser.id)).toBeVisible()
    await expect(memberRow(g, aliceUser.id).getByTestId('member-source')).not.toContainText('@alice')
  } finally {
    await guest.close()
  }
})
