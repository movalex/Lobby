// Fixes from the facilitation review (docs/research/miro-ux-checklist.md, the review's PRI-*, RETRO-*
// and F* items), each driven through the real UI in real browsers:
//   comments: reply box takes the keyboard (PRI-01), phone popover (PRI-03), frame-aware locations
//   (PRI-06), hover preview + mention "View" (PRI-12), keyboard commenting (PRI-14), live access
//   requests in the bell (PRI-09a), resolve with Undo and dots when zoomed out (PRI-17, F24b);
//   workshops: keyboard voting (RETRO-06), hide note authors / cursors (RETRO-03a, RETRO-07a),
//   results card (RETRO-08), one stacked message region (RETRO-11), the vote-setup selects (RETRO-23a);
//   present-export: titled, uniform PDF pages (RETRO-05a, F13), presenter bar and focus (F21, RETRO-22b).
// The time's-up changes (RETRO-12) are in workshops.spec.ts › "time's up".
import type { Browser, Page } from '@playwright/test'
import { signInContext } from './support/api.ts'
import { edit, getShape, read, shapeBounds, toScreen, waitForBoard } from './support/board.ts'
import {
  bell,
  commentRow,
  commentsApi,
  commentToast,
  createNote,
  currentTool,
  type Ed,
  focusCanvas,
  openCommentsPanel,
  pin,
  threadPopover,
} from './support/comments.ts'
import { richText } from './support/editor.ts'
import {
  downloadFrom,
  pdfPageTexts,
  placeUploadedImage,
  readPdf,
  seedBoard,
} from './support/present-export.ts'
import type { TestUser } from './support/users.ts'
import {
  closeWorkshopPopover,
  expect,
  openWorkshopPopover,
  test,
  workshopState,
} from './support/workshops.ts'

const NOTE = 'shape:fr-note'

const zoomOf = (page: Page) =>
  read(page, (ed) => (ed as unknown as { getZoomLevel(): number }).getZoomLevel())
const shapeCount = (page: Page) => read(page, (ed) => ed.getCurrentPageShapes().length)

/** Waits until the camera and the canvas size have stopped changing (a reveal animates ~320 ms). */
async function cameraSettled(page: Page) {
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(
        await read(page, (ed) => [
          (ed as unknown as Ed).getCamera(),
          (ed as unknown as Ed).getViewportScreenBounds(),
        ]),
      )
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
  await waitForBoard(page)
  return { context, page }
}

// ---- comments ------------------------------------------------------------------------------------------

test('PRI-01: opening a thread puts the keyboard in its reply box — typing is a reply, never a board shortcut (from a pin, and from a bell notification as an editor)', async ({
  board,
  users,
  session,
}) => {
  const a = await session('alice')
  await createNote(a.page, NOTE, 0, 0, 'Hero shot')
  await edit(a.page, (ed) => ed.zoomToFit())
  const alice = commentsApi(await users.api('alice'))
  const t = await alice.createThread(board, { kind: 'shape', shapeId: NOTE, u: 0.5, v: 0.5 }, 'Looks good?')
  await expect(pin(a.page, t.id)).toBeVisible()

  await test.step('alice clicks the pin and types "Thanks! ": it lands in the reply box', async () => {
    await focusCanvas(a.page)
    const zoom = await zoomOf(a.page)
    await pin(a.page, t.id).click()
    const reply = threadPopover(a.page, t.id).getByTestId('comment-composer')
    await expect(reply).toBeFocused()
    await a.page.keyboard.type('Thanks! ')
    await expect(reply).toHaveValue('Thanks! ')
    // "h" = hand, "a" = arrow, "n" = note, "!" = zoom to fit, … none of them fired.
    expect(await currentTool(a.page)).toBe('select')
    expect(await zoomOf(a.page)).toBe(zoom)
    expect(await shapeCount(a.page)).toBe(1)
    await reply.press('Escape')
    await expect(threadPopover(a.page)).toHaveCount(0)
  })

  await test.step('bob (editor) opens a reply notification from the bell and types: a reply again', async () => {
    const bobApi = commentsApi(await users.api('bob'))
    await users.grant(board, 'bob', 'editor')
    await bobApi.markAllNotificationsRead()
    const mine = await bobApi.createThread(board, { kind: 'point', x: 600, y: 400 }, 'Is the logo too big?')
    await alice.reply(mine.id, 'A little, yes')
    const b = await session('bob')
    await expect.poll(async () => Number(await bell(b.page).getAttribute('data-unread'))).toBe(1)
    await bell(b.page).click()
    await b.page.locator('[data-testid="notification-item"][data-kind="reply"]').first().click()
    const reply = threadPopover(b.page, mine.id).getByTestId('comment-composer')
    await expect(reply).toBeFocused()
    await cameraSettled(b.page)
    const zoom = await zoomOf(b.page)
    const shapes = await shapeCount(b.page)
    await b.page.keyboard.type('Thanks! ')
    await expect(reply).toHaveValue('Thanks! ')
    expect(await currentTool(b.page)).toBe('select')
    expect(await zoomOf(b.page)).toBe(zoom)
    expect(await shapeCount(b.page)).toBe(shapes)
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
    await createNote(page, NOTE, 2000, 1500, 'Far away')
    await edit(page, (ed) => (ed as unknown as Ed).setCamera({ x: 0, y: 0, z: 1 }))
    const api = commentsApi(await users.api('alice'))
    const t = await api.createThread(board, { kind: 'shape', shapeId: NOTE, u: 0.5, v: 0.9 }, 'On my phone')
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
  session,
}) => {
  const a = await session('alice')
  await seedBoard(a.page, {
    frames: [
      { id: 'shape:fr-b', name: 'Concept B – Fresh Start', x: 0, y: 0, w: 700, h: 500 },
      { id: 'shape:fr-a', name: 'Concept A', x: 900, y: 0, w: 500, h: 500 },
    ],
    notes: [{ id: NOTE, parentId: 'shape:fr-b', x: 60, y: 60, text: 'Tagline' }],
  })
  await edit(a.page, (ed) => ed.zoomToFit())
  const api = commentsApi(await users.api('alice'))
  const onNote = await api.createThread(board, { kind: 'shape', shapeId: NOTE, u: 0.5, v: 0.5 }, 'Sharper?')
  const inA = await api.createThread(
    board,
    {
      kind: 'point',
      x: 1100,
      y: 300,
      pageId: await read(a.page, (ed) => (ed as unknown as Ed).getCurrentPageId()),
    },
    'Empty here',
  )
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
  const b = await shapeBounds(a.page, NOTE)
  const p = await toScreen(a.page, { x: (b?.x ?? 0) + 20, y: (b?.y ?? 0) + 20 })
  await a.page.mouse.click(p.x, p.y)
  await expect(a.page.getByTestId('new-comment-where')).toHaveText('Concept B – Fresh Start · note')
})

test('PRI-12: the hover preview shows the newest unread comment (never my own) as New; the mention toast has a View action; unread markers are bigger with a ring', async ({
  board,
  users,
  session,
}) => {
  const a = await session('alice')
  await createNote(a.page, NOTE, 0, 0, 'Poster')
  await edit(a.page, (ed) => ed.zoomToFit())
  const b = await session('bob')
  const alice = commentsApi(await users.api('alice'))
  const bob = commentsApi(await users.api('bob'))
  const t = await alice.createThread(
    board,
    { kind: 'shape', shapeId: NOTE, u: 0.3, v: 0.3 },
    'My own old comment',
  )
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

  await test.step('a mention toast whose View opens the thread where it is', async () => {
    const m = await bob.createThread(
      board,
      { kind: 'shape', shapeId: NOTE, u: 0.8, v: 0.8 },
      `Please check @[${a.name}](${a.id})`,
    )
    const toast = commentToast(a.page, `${b.name} mentioned you in a comment`)
    await expect(toast).toBeVisible()
    await edit(a.page, (ed) => (ed as unknown as Ed).setCamera({ x: 20_000, y: 20_000, z: 1 }))
    await expect(pin(a.page, m.id)).toHaveCount(0)
    await toast.getByRole('button', { name: 'View' }).click()
    await expect(threadPopover(a.page, m.id)).toBeVisible()
    await expect(pin(a.page, m.id)).toBeVisible()
  })
})

test('PRI-14: keyboard-only commenting — C, Tab to the note, Enter, type, Enter attaches a thread to it; with nothing selected, Enter pins one in the middle of the view', async ({
  board,
  users,
  session,
}) => {
  const a = await session('alice')
  await createNote(a.page, NOTE, 100, 100, 'Keyboard target')
  await edit(a.page, (ed) => (ed as unknown as Ed).setCamera({ x: 0, y: 0, z: 1 }))
  const api = commentsApi(await users.api('alice'))
  await expect(a.page.getByTestId('comment-tool')).toHaveAttribute('title', /Enter/)

  await focusCanvas(a.page)
  await a.page.keyboard.press('c')
  await expect.poll(() => currentTool(a.page)).toBe('comment')
  await a.page.keyboard.press('Tab')
  await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([NOTE])
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
  expect(onNote?.anchor).toMatchObject({ kind: 'shape', shapeId: NOTE })
  expect(await read(a.page, (ed) => ed.getEditingShapeId())).toBeNull()

  // Nothing selected: a point pin in the middle of the view.
  await a.page.keyboard.press('Escape')
  await expect(threadPopover(a.page)).toHaveCount(0)
  await edit(a.page, (ed) => ed.selectNone())
  await focusCanvas(a.page)
  if ((await currentTool(a.page)) !== 'comment') await a.page.keyboard.press('c')
  await a.page.keyboard.press('Enter')
  await expect(a.page.getByTestId('new-comment-where')).toHaveText('On the board')
  await expect(composer).toBeFocused()
  await a.page.keyboard.type('Middle of the view')
  await a.page.keyboard.press('Enter')
  await expect(threadPopover(a.page)).toBeVisible()
  const centre = await read(a.page, (ed) => {
    const b = (
      ed as unknown as { getViewportPageBounds(): { x: number; y: number; w: number; h: number } }
    ).getViewportPageBounds()
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  })
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
  session,
}) => {
  // Earlier tests notified alice: start from a clean inbox, before her page loads it.
  await commentsApi(await users.api('alice')).markAllNotificationsRead()
  const a = await session('alice')
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
  const item = a.page.locator('[data-testid="notification-item"][data-kind="access_request"]')
  await expect(item).toHaveCount(1)
  await expect(item.getByTestId('notification-request')).toContainText('Wants to edit')
  await expect(item.getByTestId('notification-request')).toContainText('I need to add the storyboard notes')
})

test('PRI-17 + F24b: resolving offers Undo, which reopens the thread; below 25% zoom markers are dots that expand on hover', async ({
  board,
  users,
  session,
}) => {
  const a = await session('alice')
  await createNote(a.page, NOTE, 0, 0, 'Resolve me')
  await edit(a.page, (ed) => ed.zoomToFit())
  const api = commentsApi(await users.api('alice'))
  const t = await api.createThread(board, { kind: 'shape', shapeId: NOTE, u: 0.5, v: 0.5 }, 'Done?')
  await pin(a.page, t.id).click()
  await threadPopover(a.page, t.id).getByTestId('thread-resolve').click()
  await expect(pin(a.page, t.id)).toHaveCount(0)
  const toast = commentToast(a.page, 'Thread resolved')
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(pin(a.page, t.id)).toBeVisible()
  await expect.poll(async () => (await api.thread(board, t.id))?.status).toBe('open')

  await edit(a.page, (ed) => {
    const e = ed as unknown as Ed
    const b = e.getShapePageBounds('shape:fr-note')
    const vp = e.getViewportScreenBounds()
    const z = 0.2
    if (b) e.setCamera({ x: -(b.x + b.w / 2) + vp.w / 2 / z, y: -(b.y + b.h / 2) + vp.h / 2 / z, z })
  })
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

// ---- workshops -----------------------------------------------------------------------------------------

const NOTES = ['shape:fr-v1', 'shape:fr-v2', 'shape:fr-v3']

async function addVoteNotes(page: Page) {
  await edit(
    page,
    (ed, list) =>
      ed.createShapes(
        list.map((n, i) => ({ id: n.id, type: 'note', x: i * 260, y: 0, props: { richText: n.rich } })),
      ),
    NOTES.map((id, i) => ({ id, rich: richText(['Alpha', 'Beta', 'Gamma'][i] ?? '') })),
  )
  await edit(page, (ed) => ed.zoomToFit())
}

async function startVote(
  api: { fetch(m: string, p: string, d?: unknown): Promise<{ status(): number; json(): Promise<unknown> }> },
  board: string,
) {
  const res = await api.fetch('POST', `/api/boards/${board}/votes`, {
    title: 'Pick a direction',
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.status()).toBeLessThan(300)
  return ((await res.json()) as { session: { id: string } }).session.id
}

test('RETRO-06: a keyboard-only participant votes: Tab to an object’s +, Enter/Space, Tab to the next object, until 0 of 3 left', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'viewer')
  await addVoteNotes(a.page)
  await expect.poll(() => getShape(b.page, NOTES[2] as string)).not.toBeNull()
  await edit(b.page, (ed) => ed.zoomToFit())
  await startVote(a.api, board)

  const prompt = b.page.getByTestId('vote-join-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.getByTestId('vote-keys-hint')).toContainText('Tab')
  await prompt.getByTestId('vote-join').press('Enter')
  await expect(b.page.getByTestId('vote-remaining')).toHaveText('3 of 3 left')

  const announce = b.page.getByTestId('vote-announce')
  const focused = () => b.page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
  await focusCanvas(b.page)
  await b.page.keyboard.press('Tab')
  await expect.poll(() => read(b.page, (ed) => ed.getSelectedShapeIds())).toEqual([NOTES[0]])
  await expect.poll(focused).toBe('vote-plus')
  await b.page.keyboard.press('Enter')
  await expect(announce).toHaveText('Voted. 2 of 3 left')
  await b.page.keyboard.press(' ')
  await expect(announce).toHaveText('Voted. 1 of 3 left')
  await b.page.keyboard.press('Tab')
  await expect.poll(() => read(b.page, (ed) => ed.getSelectedShapeIds())).toEqual([NOTES[1]])
  await expect.poll(focused).toBe('vote-plus')
  await b.page.keyboard.press('Enter')
  await expect(announce).toHaveText('Voted. 0 of 3 left')
  await expect(b.page.getByTestId('vote-remaining')).toHaveText('0 of 3 left')
  // The keyboard is still in the stepper (the + cannot act now, but keeps the focus).
  expect(await focused()).toBe('vote-plus')
  await b.page.keyboard.press('Escape')
  await expect
    .poll(() => read(b.page, (ed) => document.activeElement === (ed as unknown as Ed).getContainer()))
    .toBe(true)

  const mine = await workshopState(b.api, board)
  expect(mine.vote?.myRemaining).toBe(0)
  expect(mine.vote?.myVotes).toEqual({ [NOTES[0] as string]: 2, [NOTES[1] as string]: 1 })
  // Enter and Space never started editing a note or changed the board.
  expect(await read(b.page, (ed) => ed.getEditingShapeId())).toBeNull()
  expect(await shapeCount(b.page)).toBe(3)
})

test('RETRO-03a + RETRO-07a: a facilitator hides note authors and cursors for everyone: on the board, in Present and in exports', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await edit(
    a.page,
    (ed, arg) => {
      ed.createShape({
        id: 'shape:fr-frame',
        type: 'frame',
        x: -40,
        y: -40,
        props: { w: 600, h: 320, name: 'Ideas' },
      })
      ed.createShape({
        id: 'shape:fr-authored',
        type: 'note',
        x: 0,
        y: 0,
        parentId: 'shape:fr-frame',
        props: { richText: arg.rich, textLastEditedBy: arg.uid },
      })
    },
    { rich: richText('Anonymous idea'), uid: a.id },
  )
  await expect.poll(() => getShape(b.page, 'shape:fr-authored')).not.toBeNull()
  for (const s of [a, b]) await edit(s.page, (ed) => ed.zoomToFit())
  const authorLabel = (page: Page) => page.locator('.tl-note__attribution')
  const cursors = (page: Page) => page.locator('.tl-cursor')

  // Record every SVG the page rasterizes (what a PNG export is made from).
  await b.page.evaluate(() => {
    const w = window as unknown as { __svgSources: string[] }
    w.__svgSources = []
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get() {
        return desc?.get?.call(this)
      },
      set(v: string) {
        if (typeof v === 'string' && v.startsWith('data:image/svg+xml')) w.__svgSources.push(v)
        desc?.set?.call(this, v)
      },
    })
  })
  const svgSources = () =>
    b.page.evaluate(() =>
      (window as unknown as { __svgSources: string[] }).__svgSources.map((u) => {
        const data = u.slice(u.indexOf(',') + 1)
        return u.includes(';base64,') ? atob(data) : decodeURIComponent(data)
      }),
    )
  const exportDialog = b.page.getByTestId('export-dialog')

  await test.step('before: bob sees alice’s name on her note and her cursor; his SVG export carries the name', async () => {
    await expect(authorLabel(b.page)).toHaveText(a.name.split(' ')[0] ?? a.name)
    await expect(authorLabel(b.page)).toBeVisible()
    await a.page.mouse.move(300, 300)
    await a.page.mouse.move(320, 330)
    await expect(cursors(b.page)).toHaveCount(1)
    await b.page.getByTestId('export-button').click()
    await exportDialog.getByTestId('export-area-board').check()
    const svg = await downloadFrom(b.page, () => exportDialog.getByTestId('export-svg').click())
    expect(svg.bytes.toString('utf8')).toContain('tl-note__attribution')
    await b.page.keyboard.press('Escape')
  })

  await test.step('alice switches both on in the workshop popover', async () => {
    const pop = await openWorkshopPopover(a.page)
    await expect(pop.getByTestId('session-settings')).toContainText('still records who last edited')
    await pop.getByTestId('session-hide-authors').check()
    await pop.getByTestId('session-hide-cursors').check()
    await closeWorkshopPopover(a.page)
  })

  await test.step('bob: no author label on the board, no cursor from alice; alice sees no cursor from bob', async () => {
    await expect(authorLabel(b.page)).toBeHidden()
    await a.page.mouse.move(400, 300)
    await a.page.mouse.move(420, 340)
    await b.page.mouse.move(300, 300)
    await b.page.mouse.move(330, 310)
    await expect(cursors(b.page)).toHaveCount(0)
    await expect(cursors(a.page)).toHaveCount(0)
    // The settings are the board's (synced): bob, an editor, sees them on; the note still records
    // its last editor (the copy says so).
    const pop = await openWorkshopPopover(b.page)
    await expect(pop.getByTestId('session-hide-authors')).toBeChecked()
    await expect(pop.getByTestId('session-hide-cursors')).toBeChecked()
    await closeWorkshopPopover(b.page)
    expect((await getShape(b.page, 'shape:fr-authored'))?.props.textLastEditedBy).toBe(a.id)
    // A viewer (who cannot change it) is told what is in effect.
    const c = await join('carol', 'viewer')
    await expect.poll(() => getShape(c.page, 'shape:fr-authored')).not.toBeNull()
    await expect(authorLabel(c.page)).toBeHidden()
    const cpop = await openWorkshopPopover(c.page)
    await expect(cpop.getByTestId('session-settings')).toContainText('hidden the names on sticky notes')
    await expect(cpop.getByTestId('session-hide-authors')).toHaveCount(0)
    await closeWorkshopPopover(c.page)
  })

  await test.step('bob presents: no author label on the slide', async () => {
    await b.page.getByTestId('present-button').click()
    await expect(b.page.getByTestId('present-overlay')).toBeVisible()
    await expect(authorLabel(b.page)).toBeHidden()
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
  })

  await test.step('bob exports: the PNG’s SVG source and the SVG file carry no author', async () => {
    await b.page.getByTestId('export-button').click()
    await exportDialog.getByTestId('export-area-board').check()
    const before = (await svgSources()).length
    const png = await downloadFrom(b.page, () => exportDialog.getByTestId('export-png').click())
    expect(png.bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
    const sources = (await svgSources()).slice(before)
    expect(sources.length).toBeGreaterThan(0)
    for (const svg of sources) {
      expect(svg).toContain('Anonymous idea')
      expect(svg).not.toContain('tl-note__attribution')
    }
    const svg = await downloadFrom(b.page, () => exportDialog.getByTestId('export-svg').click())
    expect(svg.bytes.toString('utf8')).not.toContain('tl-note__attribution')
    await b.page.keyboard.press('Escape')
  })
})

test('RETRO-08 + RETRO-23a: when Maya ends the vote, bob sees the top-3 card within 2 s, and "See all results" opens the Voting panel', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await addVoteNotes(a.page)
  await expect.poll(() => getShape(b.page, NOTES[2] as string)).not.toBeNull()

  await test.step('the vote-setup selects have room around their text', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('vote-start').click()
    const dialog = a.page.getByTestId('vote-setup-dialog')
    for (const id of ['vote-scope', 'vote-types', 'vote-duration']) {
      const pad = await dialog.getByTestId(id).evaluate((el) => {
        const cs = getComputedStyle(el)
        return { left: Number.parseFloat(cs.paddingLeft), right: Number.parseFloat(cs.paddingRight) }
      })
      expect(pad.left).toBeGreaterThanOrEqual(10)
      expect(pad.right).toBeGreaterThanOrEqual(24) // the arrow sits there
    }
    await dialog.getByTestId('vote-setup-submit').click()
    await expect(dialog).toHaveCount(0)
  })

  const sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
  for (const [id, n] of [
    [NOTES[1], 2],
    [NOTES[0], 1],
  ] as const) {
    for (let i = 0; i < n; i++)
      expect((await b.api.fetch('POST', `/api/votes/${sid}/cast`, { shapeId: id, delta: 1 })).status()).toBe(
        200,
      )
  }
  await expect(a.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
  const started = Date.now()
  await a.page.getByTestId('vote-reveal').click()
  const card = b.page.getByTestId('vote-results-card')
  await expect(card).toBeVisible({ timeout: 2_000 })
  expect(Date.now() - started).toBeLessThan(2_000)
  await expect(card).toContainText('Results are in')
  const rows = card.getByTestId('vote-results-card-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Beta')
  await expect(rows.nth(0)).toContainText('2')
  await expect(rows.nth(1)).toContainText('Alpha')
  await card.getByTestId('vote-results-card-all').click()
  await expect(b.page.getByTestId('dock-panel-voting')).toBeVisible()
  await expect(b.page.getByTestId('vote-results')).toBeVisible()
  await expect(card).toHaveCount(0)
})

test('RETRO-11: the "Following" notice sits above the vote prompt, and followers get one Stop following button', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await addVoteNotes(a.page)
  await expect.poll(() => getShape(b.page, NOTES[2] as string)).not.toBeNull()
  await startVote(a.api, board)
  await expect(b.page.getByTestId('vote-join-prompt')).toBeVisible()
  expect((await a.api.fetch('POST', `/api/boards/${board}/summon`, {})).status()).toBe(202)
  const notice = b.page.getByTestId('follow-toast')
  await expect(notice).toBeVisible()
  const n = await notice.boundingBox()
  const p = await b.page.getByTestId('vote-join-prompt').boundingBox()
  expect((n?.y ?? 0) + (n?.height ?? 0)).toBeLessThanOrEqual(p?.y ?? 0)
  await expect(b.page.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(1)
  await b.page.getByRole('button', { name: 'Stop following', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(b.page.getByTestId('vote-join-prompt')).toBeVisible()
})

// ---- present-export ------------------------------------------------------------------------------------

test('RETRO-05a + F13: a 16:9 PDF has pages of one size, each with its frame title in the header and the text layer (not the text hidden under a photo)', async ({
  session,
}) => {
  const a = await session('alice')
  await seedBoard(a.page, {
    frames: [
      { id: 'shape:fr-p1', name: 'Kickoff', x: 0, y: 0, w: 1600, h: 900, index: 0 },
      { id: 'shape:fr-p2', name: 'Portrait moodboard', x: 1800, y: 0, w: 600, h: 1100, index: 1 },
      { id: 'shape:fr-p3', name: 'Tiny strip', x: 2600, y: 0, w: 400, h: 80, index: 2 },
    ],
    notes: [
      { id: 'shape:fr-p1-note', parentId: 'shape:fr-p1', x: 40, y: 40, text: 'Agenda' },
      { id: 'shape:fr-p1-covered', parentId: 'shape:fr-p1', x: 600, y: 300, text: 'Covered caption' },
    ],
  })
  // A photo placed over the second note: its words are not on the page, so not in the text layer.
  await placeUploadedImage(a.page, 'shape:fr-p1', { x: 560, y: 260, w: 480, h: 270 })
  await a.page.getByTestId('export-button').click()
  const dialog = a.page.getByTestId('export-dialog')
  await expect(dialog.getByTestId('export-pdf-page-size')).toHaveValue('fit')
  await dialog.getByTestId('export-pdf-page-size').selectOption('16:9')
  const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
  const info = await readPdf(pdf.bytes)
  expect(info.pages).toHaveLength(3)
  for (const page of info.pages) expect([page.width, page.height]).toEqual([960, 540])
  expect(info.outline.map((o) => o.title)).toEqual(['Kickoff', 'Portrait moodboard', 'Tiny strip'])
  const texts = await pdfPageTexts(pdf.bytes)
  expect(texts[0]).toContain('Kickoff')
  expect(texts[0]).toContain('Agenda')
  expect(texts[0]).not.toContain('Covered caption')
  expect(texts[1]).toContain('Portrait moodboard')
  expect(texts[2]).toContain('Tiny strip')

  // The choice is remembered; "Fit each frame" keeps frame-shaped pages (plus the band).
  await dialog.getByTestId('export-pdf-page-size').selectOption('fit')
  const fit = await readPdf(
    (await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())).bytes,
  )
  expect(fit.pages[1]?.width).toBe(450)
  expect(fit.pages[1]?.height).toBeGreaterThan(825)
})

test('F21 + RETRO-22b: the presenter bar hides after ~2 s even after a click, returns on pointer movement or a key; leaving returns the focus and never strands the board full screen', async ({
  session,
}) => {
  const a = await session('alice')
  await seedBoard(a.page, {
    frames: [
      { id: 'shape:fr-s1', name: 'Portrait', x: 0, y: 0, w: 600, h: 1000 },
      { id: 'shape:fr-s2', name: 'Landscape', x: 800, y: 0, w: 1000, h: 600 },
    ],
  })
  const overlay = a.page.getByTestId('present-overlay')
  const bar = a.page.getByTestId('present-controls')
  const opacity = () => bar.evaluate((el) => Number(getComputedStyle(el).opacity))
  const focused = () => a.page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

  await a.page.getByTestId('present-button').click()
  await expect(overlay).toBeVisible()
  await a.page.getByTestId('present-next').click()
  await expect(a.page.getByTestId('present-counter')).toHaveText('2 / 2')
  // The clicked button keeps the focus, but the bar still gets out of the slide's way.
  await expect.poll(opacity, { timeout: 5_000 }).toBe(0)
  await a.page.mouse.move(400, 300)
  await a.page.mouse.move(420, 320)
  await expect.poll(opacity).toBe(1)
  await expect.poll(opacity, { timeout: 5_000 }).toBe(0)
  await a.page.keyboard.press('Shift')
  await expect.poll(opacity).toBe(1)

  await a.page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await expect.poll(focused).toBe('present-button')

  // Esc before the browser has entered fullscreen: the board must not stay stranded full screen
  // (the fullscreen request is slowed down here to make that moment long enough to hit).
  await a.page.evaluate(() => {
    const original = Element.prototype.requestFullscreen
    Element.prototype.requestFullscreen = function (this: Element, opts?: FullscreenOptions) {
      return new Promise<void>((resolve, reject) =>
        setTimeout(() => original.call(this, opts).then(resolve, reject), 300),
      )
    }
  })
  await a.page.getByTestId('present-button').click()
  await a.page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await a.page.waitForTimeout(700) // the slowed request has landed by now
  await expect.poll(() => a.page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await expect(a.page.getByTestId('present-button')).toBeVisible()

  // Started from the board with the keyboard: the board gets the keyboard back.
  await focusCanvas(a.page)
  await a.page.keyboard.press('Control+Alt+Enter')
  await expect(overlay).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await expect
    .poll(() => read(a.page, (ed) => document.activeElement === (ed as unknown as Ed).getContainer()))
    .toBe(true)
})
