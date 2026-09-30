// Comments on the Excalidraw board page (ported from tests/comments.spec.ts; REV-01..06,
// docs/EXCALIDRAW-MIGRATION.md §4.3): the comment tool on an element and on the board, pins that follow
// their element, replies, edit/delete, resolve/reopen, per-person pin states, @mentions and the
// notifications bell (also across boards), role limits (commenters comment on a read-only canvas, viewers
// only read), orphans that re-attach on undo, Shift+C, drafts, hover preview and deep links, Esc/focus
// handling, and legacy point anchors on the one page. Collaborative behaviour is checked in a second
// browser context, and what the server stored (or refused) through the API as the user in question.
//
// Differences from the tldraw spec, by design (docs/PROGRESS.md, wave 3C): element ids are the
// canvas's own (anchors name them `shape:<id>`); a new point anchor carries no page id (one page, plan
// §5.8); the comment toasts are the board page's notices; "restore from Recently deleted" is its own test,
// expected to fail until the room's server write (CR 2F-2) lands.
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  itemCenterOnScreen,
  items,
  itemText,
  openCanvasSession,
  readOnly,
  select,
  selection,
  startTextEditingWithKeyboard,
  stopTextEditing,
  test,
  typeText,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  bell,
  canvasHasFocus,
  canvasRect,
  centerOn,
  commentItem,
  commentOnElement,
  commentRow,
  commentsApi,
  commentToast,
  currentTool,
  emptyCanvasPoint,
  expectPinOnAnchor,
  focusCanvas,
  mentionToken,
  newCommentPopover,
  noteAt,
  openCommentsPanel,
  panAway,
  pin,
  pins,
  pressCommentTool,
  ref,
  reloadBoard,
  screenPointOnElement,
  shapeAnchor,
  type Thread,
  threadPopover,
  uvOf,
} from './comments-kit.ts'

const unreadCount = async (page: Page) => Number((await bell(page).getAttribute('data-unread')) ?? 'NaN')
const composerIn = (page: Page, scope: 'new' | string) =>
  (scope === 'new' ? newCommentPopover(page) : threadPopover(page, scope)).getByTestId('comment-composer')
/** Elements that are not a bound label (a note and its label are one item). */
const contentCount = async (page: Page) =>
  (await items(page)).filter((e) => !e.isDeleted && !(e.type === 'text' && e.containerId)).length

test('commenter on a read-only canvas: C, click a note, Enter posts; the owner sees the pin live and the server stored it', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Hero shot')
  const c = await canvasSession('carol', { role: 'commenter' })
  await waitForItem(c.page, note)
  await expect.poll(() => itemText(c.page, note)).toBe('Hero shot')
  expect(await readOnly(c.page)).toBe(true)
  const alice = commentsApi(await users.api('alice'))

  let threadId = ''
  await test.step('carol presses C and comments on the note', async () => {
    await pressCommentTool(c.page)
    await expect(c.page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true')
    threadId = await commentOnElement(c.page, note, 'Can we warm up the grade here?', { u: 0.25, v: 0.75 })
    const list = threadPopover(c.page, threadId).getByTestId('comment-item')
    await expect(list).toHaveCount(1)
    await expect(list).toContainText('Can we warm up the grade here?')
  })

  await test.step('alice sees the pin appear live; the server stored a shape thread by carol', async () => {
    await expect(pin(a.page, threadId)).toBeVisible()
    const stored = await alice.thread(board, threadId)
    expect(stored).toMatchObject({
      status: 'open',
      anchor: { kind: 'shape', shapeId: ref(note) },
      createdBy: { id: c.id },
      comments: [{ author: { id: c.id }, body: 'Can we warm up the grade here?' }],
    })
    const anchor = uvOf(stored)
    expect(anchor.u).toBeCloseTo(0.25, 1)
    expect(anchor.v).toBeCloseTo(0.75, 1)
    await expectPinOnAnchor(a.page, threadId, note, anchor.u, anchor.v)
  })

  await test.step('a click on the empty board pins a point comment there (Shift+Enter adds a line)', async () => {
    await c.page.keyboard.press('Escape')
    await expect(threadPopover(c.page)).toHaveCount(0)
    expect(await currentTool(c.page)).toBe('comment')
    const spot = await emptyCanvasPoint(c.page)
    await c.page.mouse.click(spot.x, spot.y)
    const composer = composerIn(c.page, 'new')
    await expect(composer).toBeFocused()
    await composer.pressSequentially('Room for the logo')
    await composer.press('Shift+Enter')
    await composer.pressSequentially('top right?')
    await expect(composer).toHaveValue('Room for the logo\ntop right?')
    await composer.press('Enter')
    await expect(newCommentPopover(c.page)).toHaveCount(0)
    const pointId = (await threadPopover(c.page).getAttribute('data-thread-id')) ?? ''
    await expect(pin(a.page, pointId)).toBeVisible()
    await expect(pins(a.page)).toHaveCount(2)
    // The pin's pointed corner sits where carol clicked.
    const box = await pin(c.page, pointId).boundingBox()
    expect(Math.abs((box?.x ?? 0) - spot.x)).toBeLessThanOrEqual(2)
    expect(Math.abs((box ? box.y + box.height : 0) - spot.y)).toBeLessThanOrEqual(2)
    const stored = await alice.thread(board, pointId)
    // one page: a new point anchor carries no page id (plan §5.8)
    expect(stored?.anchor).toEqual({ kind: 'point', x: expect.any(Number), y: expect.any(Number) })
    expect(stored?.comments[0]?.body).toBe('Room for the logo\ntop right?')
  })

  // Commenting never wrote to the (read-only) canvas document.
  expect(await itemText(a.page, note)).toBe('Hero shot')
  expect(await contentCount(a.page)).toBe(1)
})

test('pin follows its element: after bob drags the note and both zoom to 1.7, the pin sits on its anchor on both clients', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Scene 4')
  const b = await canvasSession('bob')
  await waitForItem(b.page, note)

  await pressCommentTool(a.page)
  const threadId = await commentOnElement(a.page, note, 'Pin me to the corner', { u: 0.8, v: 0.2 })
  await a.page.keyboard.press('Escape')
  const stored = await commentsApi(await users.api('alice')).thread(board, threadId)
  const { u, v } = uvOf(stored)
  await expect(pin(b.page, threadId)).toBeVisible()
  await expectPinOnAnchor(a.page, threadId, note, u, v)
  await expectPinOnAnchor(b.page, threadId, note, u, v)

  await test.step('bob drags the note with the mouse', async () => {
    const before = (await items(a.page)).find((e) => e.id === note)
    const from = await itemCenterOnScreen(b.page, note)
    await b.page.mouse.move(from.x, from.y)
    await b.page.mouse.down()
    await b.page.mouse.move(from.x + 120, from.y + 60, { steps: 8 })
    await b.page.mouse.move(from.x + 240, from.y + 120, { steps: 8 })
    await b.page.mouse.up()
    // alice's copy moved too (so the pin below follows a real, synced move).
    await expect
      .poll(async () => {
        const s = (await items(a.page)).find((e) => e.id === note)
        return s && before ? Math.round(s.x - before.x) > 100 && Math.round(s.y - before.y) > 50 : false
      })
      .toBe(true)
  })

  await test.step('both zoom to 1.7 on the note; the pin corner is on (x+u·w, y+v·h) within 2 px', async () => {
    await centerOn(a.page, note, 1.7)
    await centerOn(b.page, note, 1.7)
    await expectPinOnAnchor(a.page, threadId, note, u, v)
    await expectPinOnAnchor(b.page, threadId, note, u, v)
  })
})

test('mention: @ suggests only people with access; the owner gets a mentioned pin and a bell count; the notification brings the thread into view, opens it and marks it read; an @name in a sticky note notifies nobody', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const aliceApi = commentsApi(await users.api('alice'))
  await aliceApi.markAllNotificationsRead()
  const note = await noteAt(a.page, 0, 0, 'Poster draft')
  const b = await canvasSession('bob')
  const dave = await users.get('dave') // Dev Studio member without access to this private board
  await waitForItem(b.page, note)

  let threadId = ''
  await test.step('bob types @Dav (no access: no suggestion), then @Ali and picks alice', async () => {
    await pressCommentTool(b.page)
    const at = await screenPointOnElement(b.page, note, 0.5, 0.5)
    await b.page.mouse.click(at.x, at.y)
    const composer = composerIn(b.page, 'new')
    await expect(composer).toBeFocused()
    await composer.pressSequentially('Thoughts @Dav')
    await expect(b.page.getByTestId('mention-no-match')).toBeVisible()
    await expect(b.page.locator(`[data-testid="mention-option"][data-user-id="${dave.id}"]`)).toHaveCount(0)
    for (let i = 0; i < 'Dav'.length; i++) await composer.press('Backspace')
    await composer.pressSequentially('Ali')
    const option = b.page.locator(`[data-testid="mention-option"][data-user-id="${a.id}"]`)
    await expect(option).toBeVisible()
    await expect(b.page.getByTestId('mention-option')).toHaveCount(1)
    await option.click()
    await expect(composer).toHaveValue(/^Thoughts @Alice Park\s?$/)
    await composer.pressSequentially('on the title?')
    await composer.press('Enter')
    await expect(threadPopover(b.page)).toBeVisible()
    threadId = (await threadPopover(b.page).getAttribute('data-thread-id')) ?? ''
    await expect(threadPopover(b.page).locator('.dr-cmention')).toHaveText('@Alice Park')
    const stored = await aliceApi.thread(board, threadId)
    expect(stored?.comments[0]).toMatchObject({
      body: `Thoughts ${mentionToken('Alice Park', a.id)} on the title?`,
      mentions: [a.id],
    })
  })

  await test.step('alice: a "mentioned" pin, a notice with View, and an unread bell', async () => {
    await expect(pin(a.page, threadId)).toHaveAttribute('data-state', 'mentioned')
    const toast = commentToast(a.page, 'Bob Chen mentioned you')
    await expect(toast).toBeVisible()
    await expect(toast.getByRole('button', { name: 'View' })).toBeVisible()
    await expect.poll(() => unreadCount(a.page)).toBe(1)
    await expect(a.page.getByTestId('notifications-count')).toBeVisible()
  })

  await test.step('the mention notification brings the thread into view, opens it, and marks it read', async () => {
    await panAway(a.page)
    await expect(pin(a.page, threadId)).toHaveCount(0)
    await bell(a.page).click()
    const entry = a.page.locator('[data-testid="notification-item"][data-kind="mention"][data-unread="true"]')
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('Bob Chen mentioned you')
    await entry.click()
    await expect(threadPopover(a.page, threadId)).toBeVisible()
    await expect(pin(a.page, threadId)).toHaveAttribute('data-state', 'read')
    // The camera glides to centre the thread's anchor.
    const { u, v } = uvOf(await aliceApi.thread(board, threadId))
    await expect
      .poll(async () => {
        const at = await screenPointOnElement(a.page, note, u, v)
        const vp = await canvasRect(a.page)
        return Math.round(Math.hypot(at.x - (vp.x + vp.width / 2), at.y - (vp.y + vp.height / 2)))
      })
      .toBeLessThanOrEqual(2)
    await expect(pin(a.page, threadId)).toBeInViewport()
    await expect.poll(() => unreadCount(a.page)).toBe(0)
    // Server: the read mark and the notification's read state are alice's, stored.
    await expect.poll(async () => (await aliceApi.threads(board)).reads[threadId] ?? null).not.toBeNull()
    await expect.poll(async () => (await aliceApi.notifications()).unreadCount).toBe(0)
  })

  await test.step('bob types "@Alice Park" into a sticky note: no notification', async () => {
    // Esc closes his thread, Esc leaves the comment tool.
    await b.page.keyboard.press('Escape')
    await expect(threadPopover(b.page)).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(b.page)).toBe('select')
    const sticky = await createNote(b.page, { x: 400, y: 0 })
    await startTextEditingWithKeyboard(b.page, sticky)
    await typeText(b.page, '@Alice Park take a look')
    await stopTextEditing(b.page)
    await expect.poll(() => itemText(a.page, sticky)).toBe('@Alice Park take a look')
    const inbox = await aliceApi.notifications()
    expect(inbox.unreadCount).toBe(0)
    expect(inbox.notifications.filter((n) => n.boardId === board)).toHaveLength(1)
  })
})

test('mention without access: "@zzz" finds nobody and "Invite with Share" opens the Share dialog; forged mention tokens posted through the API render as plain text and notify nobody', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const dave = await users.get('dave')
  const daveApi = commentsApi(await users.api('dave'))
  await daveApi.markAllNotificationsRead()
  await users.grant(board, 'bob', 'editor')
  const bobApi = commentsApi(await users.api('bob'))

  await test.step('"@zzz" shows the no-match hint; "Invite with Share" opens the Share dialog', async () => {
    await pressCommentTool(a.page)
    const spot = await emptyCanvasPoint(a.page)
    await a.page.mouse.click(spot.x, spot.y)
    const composer = composerIn(a.page, 'new')
    await composer.pressSequentially('Ask @zzz')
    const hint = a.page.getByTestId('mention-no-match')
    await expect(hint).toContainText('Nobody with access matches')
    await hint.getByRole('button', { name: 'Invite with Share' }).click()
    await expect(a.page.getByTestId('share-dialog')).toBeVisible()
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('share-dialog')).toHaveCount(0)
  })

  await test.step('bob posts forged tokens: the server keeps only a real mention of someone with access', async () => {
    const body = [
      'Forged:',
      mentionToken('X', 'usr_0000000000forged'),
      mentionToken('Dave Okafor', dave.id), // no access to the board
      mentionToken('The CEO', a.id), // real person with access, fake name
    ].join(' ')
    const thread = await bobApi.createThread(board, { kind: 'point', x: 60, y: 60 }, body)
    expect(thread.comments[0]).toMatchObject({
      body: `Forged: @X @Dave Okafor ${mentionToken('Alice Park', a.id)}`,
      mentions: [a.id],
    })
    const only = await bobApi.createThread(
      board,
      { kind: 'point', x: 60, y: 160 },
      `Hi ${mentionToken('X', dave.id)}`,
    )
    expect(only.comments[0]).toMatchObject({ body: 'Hi @X', mentions: [] })

    // alice's UI: plain "@X" / "@Dave Okafor", one real mention chip (her own, normalised name).
    await a.page.keyboard.press('Escape')
    await pin(a.page, thread.id).click()
    const entry = threadPopover(a.page, thread.id).getByTestId('comment-item')
    await expect(entry).toContainText('Forged: @X @Dave Okafor @Alice Park')
    await expect(entry.locator('.dr-cmention')).toHaveCount(1)
    await expect(entry.locator('.dr-cmention')).toHaveAttribute('data-user-id', a.id)
    await pin(a.page, only.id).click()
    await expect(threadPopover(a.page, only.id).getByTestId('comment-item')).toContainText('Hi @X')
    await expect(threadPopover(a.page, only.id).locator('.dr-cmention')).toHaveCount(0)
    expect((await daveApi.notifications()).unreadCount).toBe(0)
  })
})

test('resolve and reopen: resolving removes the pin for everyone live; the Resolved filter lists it; "show resolved" brings it back for me only; reopen restores it for everyone', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Colour pass')
  const aliceApi = commentsApi(await users.api('alice'))
  const thread = await aliceApi.createThread(board, shapeAnchor(note), 'Ready for review?')
  const b = await canvasSession('bob')
  await expect(pin(a.page, thread.id)).toBeVisible()
  await expect(pin(b.page, thread.id)).toBeVisible()

  await test.step('bob resolves: the pin leaves both boards live, the server says resolved by bob', async () => {
    await pin(b.page, thread.id).click()
    await threadPopover(b.page, thread.id).getByTestId('thread-resolve').click()
    await expect(pin(b.page, thread.id)).toHaveCount(0)
    await expect(pin(a.page, thread.id)).toHaveCount(0)
    await expect(commentToast(b.page, 'Thread resolved').getByRole('button', { name: 'Undo' })).toBeVisible()
    await expect
      .poll(async () => {
        const t = await aliceApi.thread(board, thread.id)
        return t ? { status: t.status, by: t.resolvedBy?.id } : null
      })
      .toEqual({ status: 'resolved', by: b.id })
  })

  await test.step('alice: Resolved filter lists it; "show resolved" shows its pin to her only', async () => {
    const panel = await openCommentsPanel(a.page)
    await panel.getByTestId('comments-filter').selectOption('resolved')
    await expect(commentRow(a.page, thread.id)).toHaveAttribute('data-state', 'resolved')
    await panel.getByTestId('comments-show-resolved').check()
    await expect(pin(a.page, thread.id)).toHaveAttribute('data-state', 'resolved')
    await expect(pin(b.page, thread.id)).toHaveCount(0)
    await panel.getByTestId('comments-show-resolved').uncheck()
    await expect(pin(a.page, thread.id)).toHaveCount(0)
  })

  await test.step('alice opens it from the panel and reopens: the pin is back for both', async () => {
    await commentRow(a.page, thread.id).click()
    const popover = threadPopover(a.page, thread.id)
    await expect(popover).toHaveAttribute('data-status', 'resolved')
    await expect(popover).toContainText('Resolved by Bob Chen')
    await popover.getByTestId('thread-reopen').click()
    await expect(popover).toHaveAttribute('data-status', 'open')
    await expect(pin(b.page, thread.id)).toBeVisible()
    await expect(pin(b.page, thread.id)).not.toHaveAttribute('data-state', 'resolved')
    await a.page.keyboard.press('Escape')
    await expect(pin(a.page, thread.id)).not.toHaveAttribute('data-state', 'resolved')
    expect((await aliceApi.thread(board, thread.id))?.status).toBe('open')
  })
})

test('edit and delete: only the author can edit, "(edited)" shows live elsewhere; a commenter cannot delete other people’s comments; the owner deletes a reply and it disappears live', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Trailer cut')
  const b = await canvasSession('bob')
  const c = await canvasSession('carol', { role: 'commenter' })
  await waitForItem(c.page, note)
  const aliceApi = commentsApi(await users.api('alice'))

  let threadId = ''
  let bobsId = ''
  let carolsId = ''
  await test.step('bob comments, carol replies from the thread popover', async () => {
    await pressCommentTool(b.page)
    threadId = await commentOnElement(b.page, note, 'First cut is up')
    await b.page.keyboard.press('Escape')
    await pin(c.page, threadId).click()
    const reply = composerIn(c.page, threadId)
    await reply.fill('Love the pacing')
    await reply.press('Enter')
    await expect(threadPopover(c.page, threadId).getByTestId('comment-item')).toHaveCount(2)
    await expect(reply).toHaveValue('')
    const stored = await aliceApi.thread(board, threadId)
    expect(stored?.comments.map((x) => [x.author.id, x.body])).toEqual([
      [b.id, 'First cut is up'],
      [c.id, 'Love the pacing'],
    ])
    bobsId = stored?.comments[0]?.id ?? ''
    carolsId = stored?.comments[1]?.id ?? ''
  })

  await test.step('carol (commenter) may edit/delete only her own comment', async () => {
    const popover = threadPopover(c.page, threadId)
    await expect(commentItem(popover, carolsId).getByTestId('comment-edit')).toBeVisible()
    await expect(commentItem(popover, carolsId).getByTestId('comment-delete')).toBeVisible()
    await expect(commentItem(popover, bobsId).getByTestId('comment-edit')).toHaveCount(0)
    await expect(commentItem(popover, bobsId).getByTestId('comment-delete')).toHaveCount(0)
    // ... and the server agrees.
    const carolHttp = await users.api('carol')
    expect((await carolHttp.fetch('PATCH', `/api/comments/${bobsId}`, { body: 'hijacked' })).status()).toBe(
      403,
    )
    expect((await carolHttp.fetch('DELETE', `/api/comments/${bobsId}`)).status()).toBe(403)
  })

  await test.step('bob edits his comment; carol sees the new text and "(edited)" live', async () => {
    await pin(b.page, threadId).click()
    const mine = commentItem(threadPopover(b.page, threadId), bobsId)
    await expect(
      commentItem(threadPopover(b.page, threadId), carolsId).getByTestId('comment-edit'),
    ).toHaveCount(0)
    await mine.getByTestId('comment-edit').click()
    const box = mine.getByTestId('comment-composer')
    await expect(box).toHaveValue('First cut is up')
    await box.fill('First cut is up (v2 with music)')
    await box.press('Enter')
    await expect(mine).toContainText('(edited)')
    const carolsView = commentItem(threadPopover(c.page, threadId), bobsId)
    await expect(carolsView).toContainText('First cut is up (v2 with music)')
    await expect(carolsView).toContainText('(edited)')
    const stored = await aliceApi.thread(board, threadId)
    expect(stored?.comments[0]?.body).toBe('First cut is up (v2 with music)')
    expect(stored?.comments[0]?.editedAt).not.toBeNull()
  })

  await test.step('alice (owner) deletes carol’s reply; it disappears for bob and carol live', async () => {
    await pin(a.page, threadId).click()
    const target = commentItem(threadPopover(a.page, threadId), carolsId)
    await expect(target.getByTestId('comment-edit')).toHaveCount(0)
    await target.getByTestId('comment-delete').click()
    await target.getByTestId('comment-delete-confirm').click()
    await expect(threadPopover(a.page, threadId).getByTestId('comment-item')).toHaveCount(1)
    await expect(commentItem(threadPopover(b.page, threadId), carolsId)).toHaveCount(0)
    await expect(commentItem(threadPopover(c.page, threadId), carolsId)).toHaveCount(0)
    await expect(threadPopover(c.page, threadId).getByTestId('comment-item')).toHaveCount(1)
    expect((await aliceApi.thread(board, threadId))?.comments.map((x) => x.id)).toEqual([bobsId])
  })
})

test('drafts: a reply draft survives closing the thread; a new-comment draft survives Esc (the tool stays comment) and a reload', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Moodboard')
  const thread = await commentsApi(await users.api('alice')).createThread(
    board,
    shapeAnchor(note),
    'Palette?',
  )

  await test.step('a reply draft survives "Close thread"', async () => {
    await pin(a.page, thread.id).click()
    await composerIn(a.page, thread.id).fill('Warmer, maybe')
    await threadPopover(a.page, thread.id).getByRole('button', { name: 'Close thread' }).click()
    await expect(threadPopover(a.page)).toHaveCount(0)
    await pin(a.page, thread.id).click()
    await expect(composerIn(a.page, thread.id)).toHaveValue('Warmer, maybe')
    await a.page.keyboard.press('Escape')
    await expect(threadPopover(a.page)).toHaveCount(0)
  })

  const spot = await emptyCanvasPoint(a.page)
  await test.step('a new-comment draft survives Esc; the tool stays comment until the next Esc', async () => {
    await pressCommentTool(a.page)
    await a.page.mouse.click(spot.x, spot.y)
    await composerIn(a.page, 'new').fill('Try a split screen')
    await composerIn(a.page, 'new').press('Escape')
    await expect(newCommentPopover(a.page)).toHaveCount(0)
    expect(await currentTool(a.page)).toBe('comment')
    await expect.poll(() => canvasHasFocus(a.page)).toBe(true)
    await a.page.mouse.click(spot.x, spot.y)
    await expect(composerIn(a.page, 'new')).toHaveValue('Try a split screen')
    await composerIn(a.page, 'new').press('Escape')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(a.page)).toBe('select')
  })

  await test.step('both drafts survive a reload', async () => {
    await reloadBoard(a.page)
    await expect(pin(a.page, thread.id)).toBeVisible()
    await pressCommentTool(a.page)
    await a.page.mouse.click(spot.x, spot.y)
    await expect(composerIn(a.page, 'new')).toHaveValue('Try a split screen')
    await composerIn(a.page, 'new').press('Escape')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(a.page)).toBe('select')
    await pin(a.page, thread.id).click()
    await expect(composerIn(a.page, thread.id)).toHaveValue('Warmer, maybe')
  })
  // Nothing was posted from a draft.
  expect((await commentsApi(await users.api('alice')).threads(board)).threads).toHaveLength(1)
})

test('Shift+C hides comment pins for me only, survives a reload, and Shift+C shows them again', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Titles')
  const thread = await commentsApi(await users.api('alice')).createThread(board, shapeAnchor(note), 'Kerning')
  const b = await canvasSession('bob')
  await expect(pin(a.page, thread.id)).toBeVisible()
  await expect(pin(b.page, thread.id)).toBeVisible()
  const panel = await openCommentsPanel(a.page)

  await focusCanvas(a.page)
  await a.page.keyboard.press('Shift+C')
  await expect(pins(a.page)).toHaveCount(0)
  await expect(panel.getByTestId('comments-hide-pins')).toBeChecked()
  await expect(pin(b.page, thread.id)).toBeVisible()

  await reloadBoard(a.page)
  const again = await openCommentsPanel(a.page)
  // The threads are loaded (the row is listed), and still no pin.
  await expect(commentRow(a.page, thread.id)).toBeVisible()
  await expect(again.getByTestId('comments-hide-pins')).toBeChecked()
  await expect(pins(a.page)).toHaveCount(0)

  await focusCanvas(a.page)
  await a.page.keyboard.press('Shift+C')
  await expect(pin(a.page, thread.id)).toBeVisible()
  await expect(again.getByTestId('comments-hide-pins')).not.toBeChecked()
  await expect(pin(b.page, thread.id)).toBeVisible()
})

/** bob deletes the note with Delete: alice's pin goes, and her panel row says "On a deleted object". */
async function bobDeletesNote(a: Page, b: Page, note: string, threadId: string) {
  await select(b, [note])
  await focusCanvas(b)
  await b.keyboard.press('Delete')
  await expect.poll(async () => (await items(a)).some((e) => e.id === note && !e.isDeleted)).toBe(false)
  await expect(pin(a, threadId)).toHaveCount(0)
  await expect(pin(b, threadId)).toHaveCount(0)
  const row = commentRow(a, threadId)
  await expect(row).toHaveAttribute('data-orphan', 'true')
  await expect(row).toContainText('On a deleted object')
}

test('orphaned thread: deleting the note removes the pin and lists it "On a deleted object"; undo re-attaches it', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Keyframe')
  const aliceApi = commentsApi(await users.api('alice'))
  const thread = await aliceApi.createThread(board, shapeAnchor(note, 0.3, 0.6), 'Hold this frame longer')
  const b = await canvasSession('bob')
  await expect(pin(b.page, thread.id)).toBeVisible()
  await openCommentsPanel(a.page)
  const row = commentRow(a.page, thread.id)
  await expect(row).toHaveAttribute('data-orphan', 'false')

  await test.step('bob deletes the note: orphan', () => bobDeletesNote(a.page, b.page, note, thread.id))

  await test.step('bob undoes: the pin is back on both, attached again', async () => {
    await focusCanvas(b.page)
    await b.page.keyboard.press('ControlOrMeta+z')
    await expect(pin(a.page, thread.id)).toBeVisible()
    await expect(pin(b.page, thread.id)).toBeVisible()
    await expect(row).toHaveAttribute('data-orphan', 'false')
    await expectPinOnAnchor(b.page, thread.id, note, 0.3, 0.6)
  })
  // The thread itself was never touched on the server.
  expect(await aliceApi.thread(board, thread.id)).toMatchObject({
    status: 'open',
    anchor: { kind: 'shape', shapeId: ref(note), u: 0.3, v: 0.6 },
  })
})

test('orphaned thread: restoring the note from Recently deleted re-attaches it (CR 2F-2)', async ({
  board,
  users,
  canvasSession,
}) => {
  // CR 2F-2: "Recently deleted" restore answers 503 on an open board until the room's serverWrite lands
  // (docs/research/excalidraw/WAVE-2.md §5); the history panel is 3h's port. Remove the mark then.
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Keyframe')
  const thread = await commentsApi(await users.api('alice')).createThread(
    board,
    shapeAnchor(note, 0.3, 0.6),
    'Hold this frame longer',
  )
  const b = await canvasSession('bob')
  await expect(pin(b.page, thread.id)).toBeVisible()
  await openCommentsPanel(a.page)
  await bobDeletesNote(a.page, b.page, note, thread.id)
  await a.page.getByTestId('dock-tab-history').click({ timeout: 5_000 })
  const deleted = a.page.locator(`[data-testid="deleted-row"][data-shape-id="${ref(note)}"]`)
  await expect(deleted).toBeVisible({ timeout: 5_000 })
  await deleted.getByTestId('deleted-restore').click()
  await expect.poll(() => itemText(b.page, note), { timeout: 10_000 }).toBe('Keyframe')
  await expect(pin(b.page, thread.id)).toBeVisible()
  await expect(pin(a.page, thread.id)).toBeVisible()
  await expectPinOnAnchor(b.page, thread.id, note, 0.3, 0.6)
})

test('viewer: C shows the read-only notice and keeps the select tool; the viewer can open a thread but not reply; the API refuses the viewer’s comment writes', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Brief')
  const aliceApi = commentsApi(await users.api('alice'))
  const thread = await aliceApi.createThread(board, shapeAnchor(note), 'Is the brief final?')
  const d = await canvasSession('dave', { role: 'viewer' })

  await focusCanvas(d.page)
  await d.page.keyboard.press('c')
  await expect(d.page.getByTestId('comments-readonly-notice')).toBeVisible()
  expect(await currentTool(d.page)).toBe('select')
  await expect(d.page.getByTestId('comment-tool')).toHaveAttribute('aria-disabled', 'true')

  await pin(d.page, thread.id).click()
  const popover = threadPopover(d.page, thread.id)
  await expect(popover.getByTestId('comment-item')).toContainText('Is the brief final?')
  await expect(popover.getByTestId('comment-composer')).toHaveCount(0)
  await expect(popover.getByTestId('thread-resolve')).toHaveCount(0)
  await expect(popover.getByTestId('comment-edit')).toHaveCount(0)
  await expect(popover.getByTestId('comment-delete')).toHaveCount(0)
  await expect(popover).toContainText('You can read comments here')

  const daveHttp = await users.api('dave')
  const commentId = thread.comments[0]?.id
  const refused = await Promise.all([
    daveHttp.fetch('POST', `/api/boards/${board}/threads`, {
      anchor: { kind: 'point', x: 1, y: 1 },
      body: 'x',
    }),
    daveHttp.fetch('POST', `/api/threads/${thread.id}/comments`, { body: 'x' }),
    daveHttp.fetch('POST', `/api/threads/${thread.id}/resolve`),
    daveHttp.fetch('PATCH', `/api/comments/${commentId}`, { body: 'x' }),
    daveHttp.fetch('DELETE', `/api/comments/${commentId}`),
  ])
  expect(refused.map((r) => r.status())).toEqual([403, 403, 403, 403, 403])
  // Reading is allowed, and nothing changed.
  const stored = await commentsApi(daveHttp).threads(board)
  expect(stored.threads.map((t: Thread) => [t.id, t.status, t.comments.length])).toEqual([
    [thread.id, 'open', 1],
  ])
})

test('hover preview and deep link: hovering a pin previews its thread; ?thread= opens it and removes the param; an unknown id says it is gone', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Hero image')
  const thread = await commentsApi(await users.api('alice')).createThread(
    board,
    shapeAnchor(note),
    'Swap the hero image',
  )
  await commentsApi(await users.api('alice')).reply(thread.id, 'Or crop it tighter')
  const b = await canvasSession('bob')

  await test.step('hover shows the preview; leaving hides it', async () => {
    await pin(b.page, thread.id).hover()
    const preview = b.page.getByTestId('comment-preview')
    await expect(preview).toContainText('Alice Park')
    // Both comments are unread for bob: the preview shows the newest one, marked New (PRI-12).
    await expect(preview).toContainText('Or crop it tighter')
    await expect(preview).toContainText('New')
    await expect(preview).toContainText('1 reply')
    await b.page.mouse.move(5, 400)
    await expect(preview).toHaveCount(0)
  })

  await test.step('/b/<id>?thread=<id> opens the thread and removes the param', async () => {
    await b.page.goto(`/b/${board}?thread=${thread.id}`)
    await waitForCanvas(b.page)
    await expect(threadPopover(b.page, thread.id)).toBeVisible()
    await expect(b.page).toHaveURL(new RegExp(`/b/${board}$`))
  })

  await test.step('an unknown thread id says the comment is gone', async () => {
    await b.page.goto(`/b/${board}?thread=thr_000000000000000unknown`)
    await waitForCanvas(b.page)
    await expect(b.page.getByTestId('comments-gone')).toBeVisible()
    await expect(threadPopover(b.page)).toHaveCount(0)
    await expect(b.page).toHaveURL(new RegExp(`/b/${board}$`))
  })
})

test('notifications across boards: a mention on board A shows in the bell on board B; clicking it opens board A with the thread; "Mark all as read" clears the count', async ({
  browser,
  board,
  users,
}) => {
  const aliceUser = await users.get('alice')
  const aliceApi = commentsApi(await users.api('alice'))
  await aliceApi.markAllNotificationsRead()
  await users.grant(board, 'bob', 'editor')
  const bobApi = commentsApi(await users.api('bob'))
  const boardA = (await (await users.api('alice')).getBoard(board)).board
  const boardB = await users.createBoard('Moodboard B')
  const first = await bobApi.createThread(
    board,
    { kind: 'point', x: 80, y: 80 },
    `Look ${mentionToken('Alice Park', aliceUser.id)}`,
  )
  const second = await bobApi.createThread(
    board,
    { kind: 'point', x: 300, y: 80 },
    `And ${mentionToken('Alice Park', aliceUser.id)}`,
  )

  const a = await openCanvasSession(browser, boardB, aliceUser)
  try {
    await expect.poll(() => unreadCount(a.page)).toBe(2)
    await bell(a.page).click()
    // (The inbox also lists earlier tests' read notifications on other boards.)
    const list = a.page
      .locator('[data-testid="notification-item"][data-kind="mention"][data-unread="true"]')
      .filter({ hasText: `Bob Chen mentioned you on ${boardA.title}` })
    await expect(list).toHaveCount(2)
    // The snippet is the comment's plain text; open the first mention.
    const target = list.filter({ hasText: 'Look @Alice Park' })
    await expect(target).toHaveCount(1)
    await target.click()
    await expect(a.page).toHaveURL(new RegExp(`/b/${board}$`))
    await waitForCanvas(a.page)
    await expect(threadPopover(a.page, first.id)).toBeVisible()
    await expect.poll(() => unreadCount(a.page)).toBe(1)

    await bell(a.page).click()
    await a.page.getByTestId('notifications-mark-all').click()
    await expect(a.page.getByTestId('notifications-count')).toHaveCount(0)
    await expect(bell(a.page)).toHaveAttribute('data-unread', '0')
    const inbox = await aliceApi.notifications()
    expect(inbox.unreadCount).toBe(0)
    expect(
      inbox.notifications
        .filter((n) => n.boardId === board)
        .map((n) => n.threadId)
        .sort(),
    ).toEqual([first.id, second.id].sort())
  } finally {
    await a.context.close()
  }
})

test('pin states are per person: unread for others, read once opened (and after a reload), mentioned when a reply mentions me', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Logo lockup')
  const b = await canvasSession('bob')
  const c = await canvasSession('carol', { role: 'commenter' })
  await waitForItem(b.page, note)

  await pressCommentTool(b.page)
  const threadId = await commentOnElement(b.page, note, 'Tighter spacing?')
  await b.page.keyboard.press('Escape')
  await expect(pin(b.page, threadId)).toHaveAttribute('data-state', 'read')
  await expect(pin(a.page, threadId)).toHaveAttribute('data-state', 'unread')
  await expect(pin(c.page, threadId)).toHaveAttribute('data-state', 'unread')

  await test.step('alice opens it: read for her (also after a reload), still unread for carol', async () => {
    await pin(a.page, threadId).click()
    await expect(pin(a.page, threadId)).toHaveAttribute('data-state', 'read')
    await a.page.keyboard.press('Escape')
    // The read mark is alice's, on the server (the pin turned "read" optimistically).
    const aliceApi = commentsApi(await users.api('alice'))
    await expect.poll(async () => (await aliceApi.threads(board)).reads[threadId] ?? null).not.toBeNull()
    expect((await commentsApi(await users.api('carol')).threads(board)).reads[threadId]).toBeUndefined()
    await reloadBoard(a.page)
    await expect(pin(a.page, threadId)).toHaveAttribute('data-state', 'read')
    await c.page.reload()
    await waitForCanvas(c.page)
    await expect(pin(c.page, threadId)).toHaveAttribute('data-state', 'unread')
  })

  await test.step('bob replies mentioning carol: mentioned for carol, unread again for alice', async () => {
    await pin(b.page, threadId).click()
    const reply = composerIn(b.page, threadId)
    await reply.click()
    await reply.pressSequentially('@Car')
    await b.page.locator(`[data-testid="mention-option"][data-user-id="${c.id}"]`).click()
    await reply.pressSequentially('what do you think?')
    await reply.press('Enter')
    await expect(threadPopover(b.page, threadId).getByTestId('comment-item')).toHaveCount(2)
    await expect(pin(c.page, threadId)).toHaveAttribute('data-state', 'mentioned')
    await expect(pin(a.page, threadId)).toHaveAttribute('data-state', 'unread')
    await expect(pin(b.page, threadId)).toHaveAttribute('data-state', 'read')
  })

  await test.step('panel filters are per person too: "Mentioning me" for carol, "Mine" for bob, not for alice', async () => {
    const filterTo = async (page: Page, filter: string) => {
      const panel = await openCommentsPanel(page)
      await panel.getByTestId('comments-filter').selectOption(filter)
      return panel
    }
    await filterTo(c.page, 'mentions')
    await expect(commentRow(c.page, threadId)).toHaveAttribute('data-state', 'mentioned')
    await filterTo(b.page, 'mine')
    await expect(commentRow(b.page, threadId)).toBeVisible()
    const alicePanel = await filterTo(a.page, 'mentions')
    await expect(alicePanel.getByTestId('comments-empty')).toBeVisible()
    await filterTo(a.page, 'mine')
    await expect(alicePanel.getByTestId('comments-empty')).toBeVisible()
    await filterTo(a.page, 'open')
    await expect(commentRow(a.page, threadId)).toHaveAttribute('data-state', 'unread')
  })
})

test('one page: a legacy point anchor that names a tldraw page is drawn on the board, and its panel row does not say "(another page)"', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  // A point pin placed on tldraw page 2 before the board moved to the new canvas (the api keeps anchors as
  // they were, plan §5.8). This board was never converted, so there is no page offset to apply.
  const thread = await commentsApi(await users.api('alice')).createThread(
    board,
    { kind: 'point', x: 120, y: 90, pageId: 'page:second' },
    'Only on page two',
  )
  await expect(pin(a.page, thread.id)).toBeVisible()
  const box = await pin(a.page, thread.id).boundingBox()
  const want = await a.page.evaluate(() => {
    const b = (
      window as unknown as {
        __lobbyBoard?: { canvas: { sceneToScreen(p: object): { x: number; y: number } } }
      }
    ).__lobbyBoard
    return b?.canvas.sceneToScreen({ x: 120, y: 90 }) ?? null
  })
  expect(Math.abs((box?.x ?? 0) - (want?.x ?? Number.NaN))).toBeLessThanOrEqual(2)
  expect(Math.abs((box ? box.y + box.height : 0) - (want?.y ?? Number.NaN))).toBeLessThanOrEqual(2)
  await openCommentsPanel(a.page)
  const row = commentRow(a.page, thread.id)
  await expect(row).toContainText('On the board')
  await expect(row).not.toContainText('(another page)')
  await row.click()
  await expect(threadPopover(a.page, thread.id)).toBeVisible()
})

test('after posting, Esc leaves the thread with focus on the canvas, the next Esc returns to select, and shortcuts work again', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Storyboard 1')
  let threadId = ''

  await test.step('post, Esc: the thread closes, the board has focus, the tool is still comment', async () => {
    await pressCommentTool(a.page)
    threadId = await commentOnElement(a.page, note, 'Looks good')
    await expect(threadPopover(a.page, threadId)).toBeVisible()
    await a.page.keyboard.press('Escape')
    await expect(threadPopover(a.page)).toHaveCount(0)
    await expect.poll(() => canvasHasFocus(a.page)).toBe(true)
    expect(await currentTool(a.page)).toBe('comment')
  })

  await test.step('the next Esc returns to select, and the board shortcuts (N) work', async () => {
    await a.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(a.page)).toBe('select')
    await a.page.keyboard.press('n')
    await expect.poll(() => currentTool(a.page)).toBe('note')
    await a.page.keyboard.press('v')
    await expect.poll(() => currentTool(a.page)).toBe('select')
    await expect(newCommentPopover(a.page)).toHaveCount(0)
  })

  await test.step('Esc in the reply box closes the thread back to the board as well', async () => {
    await pin(a.page, threadId).click()
    const reply = composerIn(a.page, threadId)
    await reply.click()
    await reply.pressSequentially('half a thought')
    await reply.press('Escape')
    await expect(threadPopover(a.page)).toHaveCount(0)
    await expect.poll(() => canvasHasFocus(a.page)).toBe(true)
    await a.page.keyboard.press('n')
    await expect.poll(() => currentTool(a.page)).toBe('note')
    await a.page.keyboard.press('v')
  })

  await test.step('Esc right after a pin opens its thread (the pin still has the focus) closes the thread', async () => {
    // The popover takes the focus on the next frame; a quick Esc before that lands on the pin. Both in
    // one task here, so the Esc is certain to come first.
    expect(await currentTool(a.page)).toBe('select')
    await a.page.evaluate((id) => {
      const el = document.querySelector<HTMLButtonElement>(
        `[data-testid="comment-pin"][data-thread-id="${id}"]`,
      )
      if (!el) throw new Error('no pin')
      el.focus()
      el.click()
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    }, threadId)
    await expect(threadPopover(a.page)).toHaveCount(0)
    await expect.poll(() => canvasHasFocus(a.page)).toBe(true)
    expect(await currentTool(a.page)).toBe('select')
  })

  await test.step('Esc on a keyboard-focused pin leaves the comment tool too', async () => {
    await pressCommentTool(a.page)
    await pin(a.page, threadId).focus()
    await expect(pin(a.page, threadId)).toBeFocused()
    await a.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(a.page)).toBe('select')
    await expect.poll(() => canvasHasFocus(a.page)).toBe(true)
  })

  await test.step('resolving closes the thread and hands the focus back to the board', async () => {
    await pin(a.page, threadId).click()
    await threadPopover(a.page, threadId).getByTestId('thread-resolve').click()
    await expect(threadPopover(a.page)).toHaveCount(0)
    await expect(pins(a.page)).toHaveCount(0)
    await expect.poll(() => canvasHasFocus(a.page)).toBe(true)
    await a.page.keyboard.press('c')
    await expect.poll(() => currentTool(a.page)).toBe('comment')
    await a.page.keyboard.press('Escape')
    await expect.poll(() => currentTool(a.page)).toBe('select')
  })
})

test('keyboard commenting (PRI-14, A11Y2-04): C, Tab steps through the objects in reading order, Enter opens the composer on the selected one', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const left = await noteAt(a.page, 0, 0, 'Left')
  const right = await noteAt(a.page, 300, 0, 'Right')
  await pressCommentTool(a.page)
  await a.page.keyboard.press('Tab')
  await expect.poll(() => selection(a.page)).toEqual([left])
  await a.page.keyboard.press('Tab')
  await expect.poll(() => selection(a.page)).toEqual([right])
  await a.page.keyboard.press('Shift+Tab')
  await expect.poll(() => selection(a.page)).toEqual([left])
  await a.page.keyboard.press('Enter')
  const composer = composerIn(a.page, 'new')
  await expect(composer).toBeFocused()
  await expect(newCommentPopover(a.page).getByTestId('new-comment-where')).toHaveText('On a note')
  await composer.fill('From the keyboard')
  await composer.press('Enter')
  const threadId = (await threadPopover(a.page).getAttribute('data-thread-id')) ?? ''
  const stored = await commentsApi(await users.api('alice')).thread(board, threadId)
  // the selected note's top-right corner, so the marker does not cover it
  expect(stored?.anchor).toEqual({ kind: 'shape', shapeId: ref(left), u: 1, v: 0 })
})
