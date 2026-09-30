// DANA-02 on the Excalidraw board page (ported from tests/notify-comments.spec.ts): the board owner hears
// about new comment threads, in-app only.
// - A name-only guest (a client on a review link) comments; the owner, sitting on the dashboard, sees
//   the bell count and "1 new comment" on the board card without reloading, and the bell item reads
//   "Priya Shah (guest) commented on <board>". Opening it opens the thread, which clears both.
// - On the board, a commenter's new thread raises the owner's bell live; opening the thread clears it.
import type { BrowserContext } from '@playwright/test'
import { displayName } from '../tests/support/api.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { mainCard, openDashboard, signedInContext } from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { bell, commentsApi, pin, threadPopover } from './comments-kit.ts'

const ORIGIN = { origin: WEB_URL }
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/** A browser without an account that joined `token` as a name-only guest (API only). */
async function joinAsGuest(context: BrowserContext, token: string, name: string) {
  const res = await context.request.post(`/api/invitations/${token}/guest`, {
    headers: ORIGIN,
    data: { name },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { user: { id: string } }).user.id
}

test('DANA-02 guest comment: the owner’s dashboard bell and board card show it without a reload; opening it opens the thread and clears both', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const aliceComments = commentsApi(alice)
  await aliceComments.markAllNotificationsRead()
  const title = ((await alice.getBoard(board)) as { board: { title: string } }).board.title
  const link = (await (
    await alice.fetch('POST', `/api/boards/${board}/review-links`, { role: 'commenter', allowGuests: true })
  ).json()) as { url: string }

  const guest = await browser.newContext()
  const owner = await signedInContext(browser, 'alice')
  try {
    const guestId = await joinAsGuest(guest, tokenOf(link.url), 'Priya Shah')
    await openDashboard(owner.page, users.devStudioId, 'all')
    const card = mainCard(owner.page, board)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('board-card-news')).toHaveCount(0)

    // The client comments from her own browser.
    const posted = await guest.request.post(`/api/boards/${board}/threads`, {
      headers: ORIGIN,
      data: {
        anchor: { kind: 'point', x: 120, y: 80 },
        body: 'Love the palette. Can we see a darker key art?',
      },
    })
    expect(posted.status(), await posted.text()).toBe(201)
    const threadId = ((await posted.json()) as { thread: { id: string } }).thread.id

    // No reload: the dashboard's inbox refresh picks it up.
    const dbell = owner.page.getByTestId('dashboard-bell')
    await expect(dbell).toHaveAttribute('data-unread', '1', { timeout: 30_000 })
    await expect(owner.page.getByTestId('dashboard-bell-count')).toHaveText('1')
    await expect(card.getByTestId('board-card-news')).toHaveText('1 new comment')

    await dbell.click()
    const item = owner.page.getByTestId('dashboard-notification-item').filter({ hasText: title })
    await expect(item).toHaveCount(1)
    await expect(item).toHaveAttribute('data-kind', 'new_comment')
    await expect(item).toHaveAttribute('data-unread', 'true')
    await expect(item).toContainText(`Priya Shah (guest) commented on ${title}`)
    await expect(item).toContainText('Love the palette. Can we see a darker key art?')
    const stored = (await aliceComments.notifications()).notifications.find((n) => n.threadId === threadId)
    expect(stored).toMatchObject({ kind: 'new_comment', boardId: board })
    expect(guestId).toMatch(/^usr_/)

    // Opening it opens the board at the thread, which reads it.
    await item.click()
    await expect(owner.page).toHaveURL(new RegExp(`/b/${board}`))
    await waitForCanvas(owner.page)
    await expect(threadPopover(owner.page, threadId)).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await aliceComments.notifications()).unreadCount).toBe(0)
    await expect(bell(owner.page)).toHaveAttribute('data-unread', '0')

    // Back on the dashboard, nothing is new any more.
    await openDashboard(owner.page, users.devStudioId, 'all')
    await expect(mainCard(owner.page, board)).toBeVisible()
    await expect(mainCard(owner.page, board).getByTestId('board-card-news')).toHaveCount(0)
    await expect(owner.page.getByTestId('dashboard-bell')).toHaveAttribute('data-unread', '0')
  } finally {
    await guest.close()
    await owner.context.close()
  }
})

test('DANA-02 on the board: a commenter’s new thread raises the owner’s bell live; opening the thread clears it; the author hears nothing', async ({
  board,
  users,
  canvasSession,
}) => {
  const aliceComments = commentsApi(await users.api('alice'))
  await aliceComments.markAllNotificationsRead()
  await users.grant(board, 'bob', 'commenter')
  const bobComments = commentsApi(await users.api('bob'))
  await bobComments.markAllNotificationsRead()
  const a = await canvasSession('alice')
  await expect(bell(a.page)).toHaveAttribute('data-unread', '0')

  const thread = await bobComments.createThread(
    board,
    { kind: 'point', x: 200, y: 160 },
    'Is the logo final?',
  )
  await expect(bell(a.page)).toHaveAttribute('data-unread', '1')
  await bell(a.page).click()
  const item = a.page.getByTestId('notification-item').filter({ hasText: 'Is the logo final?' })
  await expect(item).toHaveAttribute('data-kind', 'new_comment')
  // On its own board the item needs no board name.
  await expect(item).toContainText(`${displayName('bob')} commented`)
  await a.page.keyboard.press('Escape')

  // Opening the thread from its pin reads it.
  await pin(a.page, thread.id).click()
  await expect(threadPopover(a.page, thread.id)).toBeVisible()
  await expect(bell(a.page)).toHaveAttribute('data-unread', '0')
  await expect.poll(async () => (await aliceComments.notifications()).unreadCount).toBe(0)
  // Never the author.
  expect((await bobComments.notifications()).unreadCount).toBe(0)
})
