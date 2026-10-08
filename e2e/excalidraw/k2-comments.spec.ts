// K2-6 (wave K, F6, F8, PERF-10): comments one click away and quieter traffic. A right-click on a selected note
// offers "Comment", and the composer opens anchored to it; the empty Comments panel has an "Add a comment"
// button and no promise about email; the board's threads are fetched once per open. (The hidden-tab
// notifications poll and the touch copy are unit-tested: features/comments/ported/poll.test.ts and
// features/comments/copy.test.ts.)
import type { Page } from '@playwright/test'
import {
  clickItem,
  expect,
  itemBounds,
  sceneToScreen,
  test,
  tool,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import {
  commentsApi,
  newCommentPopover,
  noteAt,
  openCommentsPanel,
  ref,
  threadPopover,
} from './comments-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

async function screenBox(page: Page, id: string) {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`no bounds for ${id}`)
  const a = await sceneToScreen(page, { x: b.x, y: b.y })
  const z = await sceneToScreen(page, { x: b.x + b.width, y: b.y + b.height })
  return { left: a.x, top: a.y, right: z.x, bottom: z.y }
}

test('K2-6: right-click a selected note, choose Comment: the composer opens anchored to that note', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  const id = await noteAt(a.page, 0, 0, 'Launch plan')
  await zoomToFit(a.page)
  await clickItem(a.page, id)
  await clickItem(a.page, id, { button: 'right' })
  const entry = a.page.getByRole('menuitem', { name: 'Comment', exact: true })
  await expect(entry).toBeVisible()
  await entry.click()

  const composer = newCommentPopover(a.page)
  await expect(composer).toBeVisible()
  await expect(a.page.getByTestId('new-comment-where')).toContainText('note')
  await expect(composer.getByTestId('comment-composer')).toBeFocused()
  // drawn beside the note it is about (not in the middle of the view or a corner)
  const [note, box] = await Promise.all([screenBox(a.page, id), composer.boundingBox()])
  if (!box) throw new Error('no composer box')
  const gapX = Math.max(0, note.left - (box.x + box.width), box.x - note.right)
  const gapY = Math.max(0, note.top - (box.y + box.height), box.y - note.bottom)
  expect(Math.max(gapX, gapY)).toBeLessThan(80)

  await composer.getByTestId('comment-composer').fill('Ship it on Friday')
  await composer.getByTestId('comment-composer').press('Enter')
  await expect(newCommentPopover(a.page)).toHaveCount(0)
  const popover = threadPopover(a.page)
  await expect(popover).toBeVisible()
  const threadId = await popover.getAttribute('data-thread-id')
  const stored = await commentsApi(await users.api('alice')).thread(board, threadId as string)
  expect(stored?.anchor).toMatchObject({ kind: 'shape', shapeId: ref(id) })
})

test('K2-6: the empty Comments panel has "Add a comment" (one click to the tool) and no "not available yet"', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const panel = await openCommentsPanel(a.page)
  await expect(panel.getByTestId('comments-empty')).toHaveText(
    'No comments yet. Press C, then click an object or the board to add one.',
  )
  await expect(panel).not.toContainText('available yet')
  await panel.getByTestId('comments-add').click()
  await expect.poll(() => tool(a.page)).toBe('comment')
  // the bell's inbox makes no promise about email either
  await a.page.getByTestId('notifications-bell').click()
  await expect(a.page.getByTestId('notifications-panel')).toBeVisible()
  await expect(a.page.getByTestId('notifications-panel')).not.toContainText('available yet')
})

// K.1 (follow-up 12): the dashboard's bell, the board's bell and the Comments panel say the same thing about email
// (what the api does: notifications are in-app only, no email is sent).
test('K.1: the board bell, the Comments panel and the dashboard bell all say alerts are not sent by email', async ({
  canvasSession,
}) => {
  const NOT_EMAILED = 'They are not sent by email.'
  const a = await canvasSession('alice')
  const panel = await openCommentsPanel(a.page)
  await expect(panel.locator('.dr-cpanel__note')).toHaveText(
    `Mentions and replies show in the bell in the top bar. ${NOT_EMAILED}`,
  )
  await a.page.getByTestId('notifications-bell').click()
  const boardNote = a.page.getByTestId('notifications-panel').getByTestId('notifications-note')
  await expect(boardNote).toHaveText(`Alerts appear here in Lobby. ${NOT_EMAILED}`)
  const words = await boardNote.textContent()
  await a.page.goto('/')
  await a.page.getByTestId('dashboard-bell').click()
  await expect(a.page.getByTestId('dashboard-notifications').getByTestId('notifications-note')).toHaveText(
    words ?? '',
  )
})

for (const slowStream of [false, true])
  test(`K2-6 (PERF-10): a board open fetches its threads once${slowStream ? ' (the event stream says hello 2 s late)' : ''}`, async ({
    canvasSession,
    board,
  }) => {
    const a = await canvasSession('alice')
    const threadsPath = `/api/boards/${board}/threads`
    const seen: string[] = []
    a.page.on('request', (r) => {
      const u = new URL(r.url())
      if (r.method() === 'GET' && u.pathname === threadsPath) seen.push(u.search)
    })
    // a slow network or a busy api (the speed scout's 4G run saw two fetches): the board's event stream
    // (its ticket and the cookie stream alike) connects 2 s after the page asks for it
    if (slowStream)
      await a.page.route(`**/api/boards/${board}/events**`, async (route) => {
        await new Promise((r) => setTimeout(r, 2_000))
        await route.continue()
      })
    await a.page.reload()
    await waitForCanvas(a.page)
    await expect(a.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    // past the first load's wait and the old resync window, with the event stream up
    await a.page.waitForTimeout(4_000)
    expect(seen).toHaveLength(1)
  })
