// The comments fixes of the facilitation review on the Excalidraw board page (ported from the comments part
// of tests/facilitation-review.fix.spec.ts): the reply box takes the keyboard (PRI-01), the phone sheet
// (PRI-03), frame-aware locations (PRI-06), the hover preview and the mention's View (PRI-12), keyboard
// commenting (PRI-14), live access requests in the bell (PRI-09a), resolve with Undo and dots when zoomed
// out (PRI-17, F24b). The workshops and present-export parts of that spec are 3f's and 3e's.
import type { Browser, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  createItem,
  createNote,
  editingId,
  expect,
  expectSaved,
  items,
  select,
  selection,
  selectNone,
  setViewport,
  test,
  updateItem,
  viewport,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import type { TestUser } from '../tests/support/users.ts'
import {
  bell,
  centerOn,
  commentRow,
  commentsApi,
  commentToast,
  currentTool,
  focusCanvas,
  noteAt,
  openCommentsPanel,
  pin,
  screenPointOnElement,
  shapeAnchor,
  threadPopover,
} from './comments-kit.ts'

const zoomOf = async (page: Page) => (await viewport(page)).zoom
const contentCount = async (page: Page) =>
  (await items(page)).filter((e) => !e.isDeleted && !(e.type === 'text' && e.containerId)).length

/** Waits until the camera has stopped changing (a reveal animates ~320 ms). */
async function cameraSettled(page: Page) {
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await viewport(page))
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
}

/** A board page in a context of our own (phone viewport, touch…). */
async function openWith(
  browser: Browser,
  board: string,
  user: TestUser,
  opts: Parameters<Browser['newContext']>[0],
) {
  const context = await browser.newContext(opts)
  await signInContext(context, user.handle, user.name)
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return { context, page }
}

test('PRI-01: opening a thread puts the keyboard in its reply box — typing is a reply, never a board shortcut (from a pin, and from a bell notification as an editor)', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Hero shot')
  await zoomToFit(a.page)
  const alice = commentsApi(await users.api('alice'))
  const t = await alice.createThread(board, shapeAnchor(note), 'Looks good?')
  await expect(pin(a.page, t.id)).toBeVisible()

  await test.step('alice clicks the pin and types "Thanks! ": it lands in the reply box', async () => {
    await focusCanvas(a.page)
    const zoom = await zoomOf(a.page)
    await pin(a.page, t.id).click()
    const reply = threadPopover(a.page, t.id).getByTestId('comment-composer')
    await expect(reply).toBeFocused()
    await a.page.keyboard.type('Thanks! ')
    await expect(reply).toHaveValue('Thanks! ')
    // "h" = hand, "a" = arrow, "n" = note, … none of them fired.
    expect(await currentTool(a.page)).toBe('select')
    expect(await zoomOf(a.page)).toBe(zoom)
    expect(await contentCount(a.page)).toBe(1)
    await reply.press('Escape')
    await expect(threadPopover(a.page)).toHaveCount(0)
  })

  await test.step('bob (editor) opens a reply notification from the bell and types: a reply again', async () => {
    const bobApi = commentsApi(await users.api('bob'))
    await users.grant(board, 'bob', 'editor')
    await bobApi.markAllNotificationsRead()
    const mine = await bobApi.createThread(board, { kind: 'point', x: 600, y: 400 }, 'Is the logo too big?')
    await alice.reply(mine.id, 'A little, yes')
    const b = await canvasSession('bob')
    await expect.poll(async () => Number(await bell(b.page).getAttribute('data-unread'))).toBe(1)
    await bell(b.page).click()
    await b.page.locator('[data-testid="notification-item"][data-kind="reply"]').first().click()
    const reply = threadPopover(b.page, mine.id).getByTestId('comment-composer')
    await expect(reply).toBeFocused()
    await cameraSettled(b.page)
    const zoom = await zoomOf(b.page)
    const shapes = await contentCount(b.page)
    await b.page.keyboard.type('Thanks! ')
    await expect(reply).toHaveValue('Thanks! ')
    expect(await currentTool(b.page)).toBe('select')
    expect(await zoomOf(b.page)).toBe(zoom)
    expect(await contentCount(b.page)).toBe(shapes)
  })
})

test('PRI-03: on a phone, tapping a thread in the Comments panel opens a full-width sheet with its marker in view', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const { context, page } = await openWith(browser, board, alice, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  try {
    const note = await createNote(page, { x: 2000, y: 1500, text: 'Far away' })
    await expectSaved(page)
    await setViewport(page, { x: 0, y: 0, zoom: 1 })
    const api = commentsApi(await users.api('alice'))
    const t = await api.createThread(board, shapeAnchor(note, 0.5, 0.9), 'On my phone')
    await page.getByTestId('dock-rail-toggle').tap() // the phone rail is folded (R13)
    await page.getByTestId('dock-tab-comments').tap()
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    await commentRow(page, t.id).tap()

    const popover = threadPopover(page, t.id)
    await expect(popover).toBeVisible()
    await expect(popover).toHaveAttribute('data-docked', 'true')
    // The panel made room for it.
    await expect(page.getByTestId('comments-panel')).toHaveCount(0)
    await cameraSettled(page)
    const box = await popover.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(300)
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844)
    // The marker is on screen, above the sheet, and not covered by anything.
    const marker = await pin(page, t.id).boundingBox()
    expect(marker).not.toBeNull()
    expect(marker?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((marker?.x ?? 0) + (marker?.width ?? 0)).toBeLessThanOrEqual(390)
    expect(marker?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect((marker?.y ?? 0) + (marker?.height ?? 0)).toBeLessThanOrEqual(box?.y ?? 0)
    const onTop = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-testid="comment-pin"]')
          ?.getAttribute('data-thread-id'),
      { x: (marker?.x ?? 0) + 15, y: (marker?.y ?? 0) + 15 },
    )
    expect(onTop).toBe(t.id)
  } finally {
    await context.close()
  }
})

test('PRI-06: comment locations name the frame and the kind of object, in the panel, the popover and the composer', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await createItem(a.page, 'frame', { x: 0, y: 0, width: 700, height: 500, name: 'Concept B – Fresh Start' })
  await expectSaved(a.page)
  const frameB = (await items(a.page)).find((e) => e.type === 'frame')?.id ?? ''
  await createItem(a.page, 'frame', { x: 900, y: 0, width: 500, height: 500, name: 'Concept A' })
  await expectSaved(a.page)
  const note = await noteAt(a.page, 60, 60, 'Tagline')
  await updateItem(a.page, note, { frameId: frameB })
  await expectSaved(a.page)
  await zoomToFit(a.page)
  const api = commentsApi(await users.api('alice'))
  const onNote = await api.createThread(board, shapeAnchor(note), 'Sharper?')
  const inA = await api.createThread(board, { kind: 'point', x: 1100, y: 300 }, 'Empty here')
  const outside = await api.createThread(board, { kind: 'point', x: 1600, y: 900 }, 'Out here')

  const panel = await openCommentsPanel(a.page)
  await expect(commentRow(a.page, onNote.id)).toContainText('Concept B – Fresh Start · note')
  await expect(commentRow(a.page, inA.id)).toContainText('In Concept A')
  await expect(commentRow(a.page, outside.id)).toContainText('On the board')
  await commentRow(a.page, onNote.id).click()
  await expect(threadPopover(a.page, onNote.id).locator('.dr-cthread__where')).toHaveText(
    'Concept B – Fresh Start · note',
  )
  await a.page.keyboard.press('Escape')
  await expect(panel).toBeVisible()
  await a.page.getByRole('button', { name: 'Close Comments' }).click()
  await expect(panel).toHaveCount(0)
  await cameraSettled(a.page)

  // The composer names where a new comment goes before it is posted.
  await focusCanvas(a.page)
  await a.page.keyboard.press('c')
  await expect.poll(() => currentTool(a.page)).toBe('comment')
  const p = await screenPointOnElement(a.page, note, 0.1, 0.1)
  await a.page.mouse.click(p.x, p.y)
  await expect(a.page.getByTestId('new-comment-where')).toHaveText('Concept B – Fresh Start · note')
})

test('PRI-12: the hover preview shows the newest unread comment (never my own) as New; the mention notice has a View action; unread markers are bigger with a ring', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Poster')
  await zoomToFit(a.page)
  const b = await canvasSession('bob')
  const alice = commentsApi(await users.api('alice'))
  const bob = commentsApi(await users.api('bob'))
  const t = await alice.createThread(board, shapeAnchor(note, 0.3, 0.3), 'My own old comment')
  await expect(pin(a.page, t.id)).toBeVisible()
  await bob.reply(t.id, 'Fresh reply from Bob')
  await expect(pin(a.page, t.id)).toHaveAttribute('data-state', 'unread')

  await test.step('hover: Bob’s new reply, marked New; not alice’s own comment', async () => {
    await pin(a.page, t.id).hover()
    const preview = a.page.getByTestId('comment-preview')
    await expect(preview).toContainText('Fresh reply from Bob')
    await expect(preview).toContainText('New')
    await expect(preview).toContainText(b.name)
    await expect(preview).not.toContainText('My own old comment')
    // The unread dot: larger than before (12 px), with a contrasting outline.
    const dot = pin(a.page, t.id).locator('.dr-cpin__badge--dot')
    const size = await dot.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { w: el.getBoundingClientRect().width, ring: cs.boxShadow }
    })
    expect(size.w).toBeGreaterThanOrEqual(14)
    expect(size.ring).not.toBe('none')
    await a.page.mouse.move(5, 400)
  })

  await test.step('a mention notice whose View opens the thread where it is', async () => {
    const m = await bob.createThread(board, shapeAnchor(note, 0.8, 0.8), `Please check @[${a.name}](${a.id})`)
    const toast = commentToast(a.page, `${b.name} mentioned you in a comment`)
    await expect(toast).toBeVisible()
    await setViewport(a.page, { x: 20_000, y: 20_000, zoom: 1 })
    await expect(pin(a.page, m.id)).toHaveCount(0)
    await toast.getByRole('button', { name: 'View' }).click()
    await expect(threadPopover(a.page, m.id)).toBeVisible()
    await expect(pin(a.page, m.id)).toBeVisible()
  })
})

test('PRI-14: keyboard-only commenting — C, Tab to the note, Enter, type, Enter attaches a thread to it; with nothing selected, Enter pins one in the middle of the view', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 100, 100, 'Keyboard target')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const api = commentsApi(await users.api('alice'))
  await expect(a.page.getByTestId('comment-tool')).toHaveAttribute('title', /Enter/)

  await focusCanvas(a.page)
  await a.page.keyboard.press('c')
  await expect.poll(() => currentTool(a.page)).toBe('comment')
  await a.page.keyboard.press('Tab')
  await expect.poll(() => selection(a.page)).toEqual([note])
  await a.page.keyboard.press('Enter')
  const composer = a.page.getByTestId('new-comment-popover').getByTestId('comment-composer')
  await expect(composer).toBeFocused()
  await expect(a.page.getByTestId('new-comment-where')).toHaveText('On a note')
  await a.page.keyboard.type('Typed without a mouse')
  await a.page.keyboard.press('Enter')
  await expect(threadPopover(a.page)).toBeVisible()
  const onNote = (await api.threads(board)).threads.find(
    (t) => t.comments[0]?.body === 'Typed without a mouse',
  )
  expect(onNote?.anchor).toMatchObject({ kind: 'shape', shapeId: `shape:${note}` })
  expect(await editingId(a.page)).toBeNull()

  // Nothing selected: a point pin in the middle of the view.
  await a.page.keyboard.press('Escape')
  await expect(threadPopover(a.page)).toHaveCount(0)
  await selectNone(a.page)
  await focusCanvas(a.page)
  if ((await currentTool(a.page)) !== 'comment') await a.page.keyboard.press('c')
  await a.page.keyboard.press('Enter')
  await expect(a.page.getByTestId('new-comment-where')).toHaveText('On the board')
  await expect(composer).toBeFocused()
  await a.page.keyboard.type('Middle of the view')
  await a.page.keyboard.press('Enter')
  await expect(threadPopover(a.page)).toBeVisible()
  const v = await viewport(a.page)
  const centre = { x: v.x + v.width / 2, y: v.y + v.height / 2 }
  const point = (await api.threads(board)).threads.find((t) => t.comments[0]?.body === 'Middle of the view')
  expect(point?.anchor.kind).toBe('point')
  if (point?.anchor.kind === 'point') {
    expect(Math.abs(point.anchor.x - centre.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(point.anchor.y - centre.y)).toBeLessThanOrEqual(1)
  }
})

test('PRI-09a: an access request reaches the owner’s bell live, with the role and the message', async ({
  board,
  users,
  canvasSession,
}) => {
  // Earlier tests notified alice: start from a clean inbox, before her page loads it.
  await commentsApi(await users.api('alice')).markAllNotificationsRead()
  const a = await canvasSession('alice')
  await expect.poll(async () => Number(await bell(a.page).getAttribute('data-unread'))).toBe(0)
  await users.get('dave') // a Dev Studio member without access to this board
  const dave = await users.api('dave')
  const res = await dave.fetch('POST', `/api/boards/${board}/access-requests`, {
    role: 'editor',
    message: 'I need to add the storyboard notes',
  })
  expect(res.status()).toBe(202)
  // Live: well before the bell's 60 s poll.
  await expect
    .poll(async () => Number(await bell(a.page).getAttribute('data-unread')), { timeout: 5_000 })
    .toBe(1)
  await bell(a.page).click()
  const entry = a.page.locator('[data-testid="notification-item"][data-kind="access_request"]')
  await expect(entry).toHaveCount(1)
  await expect(entry.getByTestId('notification-request')).toContainText('Wants to edit')
  await expect(entry.getByTestId('notification-request')).toContainText('I need to add the storyboard notes')
})

test('PRI-17 + F24b: resolving offers Undo, which reopens the thread; below 25% zoom markers are dots that expand on hover', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Resolve me')
  await zoomToFit(a.page)
  const api = commentsApi(await users.api('alice'))
  const t = await api.createThread(board, shapeAnchor(note), 'Done?')
  await pin(a.page, t.id).click()
  await threadPopover(a.page, t.id).getByTestId('thread-resolve').click()
  await expect(pin(a.page, t.id)).toHaveCount(0)
  const toast = commentToast(a.page, 'Thread resolved')
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(pin(a.page, t.id)).toBeVisible()
  await expect.poll(async () => (await api.thread(board, t.id))?.status).toBe('open')

  await centerOn(a.page, note, 0.2)
  await a.page.mouse.move(5, 400)
  const marker = pin(a.page, t.id)
  await expect.poll(async () => (await marker.boundingBox())?.width).toBeLessThanOrEqual(16)
  const small = await marker.boundingBox()
  await marker.hover()
  await expect.poll(async () => (await marker.boundingBox())?.width).toBe(30)
  const big = await marker.boundingBox()
  // The pointed corner stays on the anchor.
  expect(Math.abs((big?.x ?? 0) - (small?.x ?? 0))).toBeLessThanOrEqual(1)
  expect(
    Math.abs((big?.y ?? 0) + (big?.height ?? 0) - ((small?.y ?? 0) + (small?.height ?? 0))),
  ).toBeLessThanOrEqual(1)
})

/** A frame "Retro" with a note inside, and a note outside (tests/keyboard-safety.spec.ts setUp). */
async function retroBoard(page: Page) {
  const frame = await createItem(page, 'frame', { x: 0, y: 0, width: 600, height: 400, name: 'Retro' })
  await expectSaved(page)
  const inner = await noteAt(page, 100, 100, 'Inside')
  await updateItem(page, inner, { frameId: frame })
  await expectSaved(page)
  await noteAt(page, 800, 0, 'Outside')
  await setViewport(page, { x: -50, y: -50, zoom: 1 })
  return { frame, inner }
}

test('A11Y2-04: with the keyboard only, a note inside a frame gets a comment: the comment tool goes inside the frame (ported from keyboard-safety.spec.ts)', async ({
  canvasSession,
}) => {
  const { page } = await canvasSession('alice')
  const { frame, inner } = await retroBoard(page)
  const composer = page.getByTestId('new-comment-popover')

  await focusCanvas(page)
  await page.keyboard.press('c')
  await expect.poll(() => currentTool(page)).toBe('comment')
  // Tab walks the top level in reading order until the frame is selected.
  for (let i = 0; i < 3; i++) {
    const sel = await selection(page)
    if (sel.length === 1 && sel[0] === frame) break
    await page.keyboard.press('Tab')
  }
  expect(await selection(page)).toEqual([frame])
  await page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
  await expect.poll(() => selection(page)).toEqual([inner])
  expect(await currentTool(page)).toBe('comment')
  await page.keyboard.press('Enter')
  await expect(composer).toBeVisible()
  await expect(page.getByTestId('new-comment-where')).toHaveText('Retro · note')
  await page.keyboard.type('Keyboard comment')
  await page.keyboard.press('Enter')
  await expect(composer).toHaveCount(0)
  await expect(page.getByTestId('comment-pin')).toHaveCount(1)

  // Ctrl+Shift+Up goes back out to the frame.
  await page.keyboard.press('Escape')
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+Shift+ArrowUp')
  await expect.poll(() => selection(page)).toEqual([frame])
})

test('A11Y2-04: the context menu’s "Comment" on the selection opens the composer on it (3a: the context-menu shell)', async ({
  canvasSession,
}) => {
  // The entry is 3c's (the contextMenu registry, group "collaborate"); the menu that renders it is 3a's
  // context-menu host slot (both on the page since the wave-3 integration).
  const { page } = await canvasSession('alice')
  const { inner } = await retroBoard(page)
  await select(page, [inner])
  await focusCanvas(page)
  await page.keyboard.press('Shift+F10')
  const entry = page.getByRole('menuitem', { name: 'Comment', exact: true })
  await expect(entry).toBeVisible({ timeout: 5_000 })
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('new-comment-popover')).toBeVisible()
  await expect(page.getByTestId('new-comment-where')).toHaveText('Retro · note')
  await expect(page.getByTestId('new-comment-popover').locator('textarea')).toBeFocused()
})
