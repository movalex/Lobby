// K6-4 (wave K): cursor chat on the Excalidraw board page, two browsers on the local stack. A presses / with
// the board in hand, types a line and presses Enter; B sees it float at A's cursor within 2 s, and it fades.
// Nothing is pushed to sync from either side and nothing is stored: the api relays it on the board's event
// stream. A viewer's / does nothing; a / typed into a note's editor is text.
//
// K6-2 rides along: no request of either page leaves the page's own origin (no Clerk telemetry host), and
// the test stack's api log has no Clerk telemetry notice.
import type { Page, Request } from '@playwright/test'
import {
  createNote,
  editingId,
  expectSaved,
  items,
  itemText,
  pushedOps,
  startTextEditing,
  stopTextEditing,
  TEXT_EDITOR,
  tool,
} from '../tests/support/canvas.ts'
import { openPhoneSession } from './a11y-kit.ts'
import { emptyCanvasPoint, focusBoard } from './board-kit.ts'
import { expect, test, type WorkshopCanvasSession } from './workshops-kit.ts'

const MESSAGE = 'Hello team, look here'
const bubbleOf = (page: Page, userId: string) =>
  page.locator(`[data-testid="cursor-chat-bubble"][data-user-id="${userId}"]`)
/** The sender's cursor as `page` draws it (overlay px), or null. */
const cursorAt = (page: Page, userId: string) =>
  page.evaluate((uid) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="cursor"][data-uid="${uid}"]`)
    return el ? { x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) } : null
  }, userId)
const placeOf = (page: Page, userId: string) =>
  bubbleOf(page, userId).evaluate((el) => ({
    x: Number.parseFloat((el as HTMLElement).style.left),
    y: Number.parseFloat((el as HTMLElement).style.top),
  }))

/** Every http(s) request a page makes, to check where they go. */
function requestsOf(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (r: Request) => {
    if (/^https?:/.test(r.url())) urls.push(r.url())
  })
  return urls
}

/** The sender's pointer rests on empty canvas, the board has the keyboard, and `watcher` sees the cursor. */
async function pointerOnCanvas(sender: WorkshopCanvasSession, watcher: WorkshopCanvasSession) {
  await focusBoard(sender.page)
  const p = await emptyCanvasPoint(sender.page)
  await sender.page.mouse.move(p.x - 40, p.y - 30)
  await sender.page.mouse.move(p.x - 60, p.y - 40, { steps: 4 })
  await expect.poll(async () => !!(await cursorAt(watcher.page, sender.id))).toBe(true)
}

test('cursor chat: A presses /, types and Enter; B sees the bubble at A’s cursor within 2 s, and it fades; no sync push, nothing stored, no request off the origin', async ({
  join,
  stack,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'commenter')
  const urls = [requestsOf(a.page), requestsOf(b.page)]
  const pushesBefore = [(await pushedOps(a.page)).length, (await pushedOps(b.page)).length]

  await pointerOnCanvas(a, b)
  const toolBefore = await tool(a.page)
  await a.page.keyboard.press('/')
  const input = a.page.getByTestId('cursor-chat-input')
  await expect(input).toBeFocused()
  // the words go into the field, never to the board (h, e, l, t, a, m, o, k and r are tool letters)
  await a.page.keyboard.type(MESSAGE, { delay: 15 })
  await expect(input).toHaveValue(MESSAGE)
  expect(await tool(a.page)).toBe(toolBefore)
  const sentAt = Date.now()
  await a.page.keyboard.press('Enter')
  await expect(input).toHaveCount(0)
  // A sees their own at once, where they typed it
  await expect(bubbleOf(a.page, a.id)).toHaveText(MESSAGE)
  await expect(bubbleOf(a.page, a.id)).toHaveAttribute('data-mine', 'true')
  // the board has the keyboard again
  await expect.poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)

  // B: within 2 s, at A's live cursor (just under its name label: model.ts BUBBLE_OFFSET 10, 30)
  const atB = bubbleOf(b.page, a.id)
  await expect(atB).toHaveText(MESSAGE, { timeout: 2_000 })
  expect(Date.now() - sentAt).toBeLessThan(2_000)
  await expect(atB).toHaveAttribute('data-phase', 'shown')
  const cursor = await cursorAt(b.page, a.id)
  const place = await placeOf(b.page, a.id)
  expect(cursor, 'A’s cursor on B’s page').not.toBeNull()
  expect(Math.abs(place.x - ((cursor?.x ?? 0) + 10))).toBeLessThanOrEqual(1)
  expect(Math.abs(place.y - ((cursor?.y ?? 0) + 30))).toBeLessThanOrEqual(1)
  // said by the board's polite live region (the a11y announcer's)
  await expect(b.page.getByTestId('canvas-announcer-tool')).toContainText(MESSAGE)

  // it follows A's cursor while it is up
  await a.page.mouse.move(400, 380, { steps: 5 })
  await expect
    .poll(async () => {
      const c = await cursorAt(b.page, a.id)
      const p = await placeOf(b.page, a.id).catch(() => null)
      return (
        !!c && !!p && Math.abs(p.x - (c.x + 10)) <= 1 && Math.abs(p.y - (c.y + 30)) <= 1 && c.x !== cursor?.x
      )
    })
    .toBe(true)

  // and fades: after CURSOR_CHAT_SHOW_MS (5 s) it fades, then it is gone, on both pages
  await expect(atB).toHaveAttribute('data-phase', 'fading', { timeout: 7_000 })
  await expect(atB).toHaveCount(0, { timeout: 3_000 })
  await expect(bubbleOf(a.page, a.id)).toHaveCount(0, { timeout: 3_000 })

  // on the wire: one event, named from A's session; nothing pushed to sync by either page
  expect(b.net.eventsOf('cursor.chat').map((e) => e.data)).toEqual([
    expect.objectContaining({ userId: a.id, text: MESSAGE }),
  ])
  expect((await pushedOps(a.page)).length).toBe(pushesBefore[0])
  expect((await pushedOps(b.page)).length).toBe(pushesBefore[1])
  // nothing stored: no element anywhere carries the words
  for (const page of [a.page, b.page]) expect(JSON.stringify(await items(page))).not.toContain(MESSAGE)

  // K6-2: every request stayed on the page's origin (no clerk-telemetry host), and no telemetry notice
  const origin = new URL(a.page.url()).origin
  for (const list of urls) {
    expect(list.filter((u) => /clerk-telemetry/i.test(u))).toEqual([])
    expect(list.filter((u) => new URL(u).origin !== origin)).toEqual([])
  }
  expect(stack.api.logs()).not.toMatch(/collects telemetry/i)
})

test('cursor chat: a commenter chats, a viewer’s / does nothing, Escape closes, and a / typed into a note is text', async ({
  join,
}) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  const d = await join('dave', 'commenter')

  // the viewer: no composer, nothing sent
  await pointerOnCanvas(c, a)
  await c.page.keyboard.press('/')
  await c.page.waitForTimeout(300)
  await expect(c.page.getByTestId('cursor-chat-input')).toHaveCount(0)

  // the commenter: Escape closes without sending; then a message reaches the owner
  await pointerOnCanvas(d, a)
  await d.page.keyboard.press('/')
  await expect(d.page.getByTestId('cursor-chat-input')).toBeFocused()
  await d.page.keyboard.type('never mind')
  await d.page.keyboard.press('Escape')
  await expect(d.page.getByTestId('cursor-chat-input')).toHaveCount(0)
  await d.page.keyboard.press('/')
  await d.page.keyboard.type('From the commenter')
  await d.page.keyboard.press('Enter')
  await expect(bubbleOf(a.page, d.id)).toHaveText('From the commenter', { timeout: 2_000 })
  expect(a.net.eventsOf('cursor.chat').map((e) => (e.data as { text: string }).text)).toEqual([
    'From the commenter',
  ])

  // a / typed in a note's editor is a character of the note, not cursor chat
  const note = await createNote(a.page, { x: 40, y: 40, text: 'a' })
  // Saved first (board-kit.ts settled: a write right after a facade write can meet its own ack)
  await expectSaved(a.page)
  await startTextEditing(a.page, note)
  await expect(a.page.locator(TEXT_EDITOR)).toBeFocused()
  await a.page.keyboard.press('End')
  await a.page.keyboard.type('/b')
  await expect(a.page.getByTestId('cursor-chat-input')).toHaveCount(0)
  await stopTextEditing(a.page)
  expect(await editingId(a.page)).toBeNull()
  await expect.poll(() => itemText(a.page, note)).toBe('a/b')
})

// Wave K.1 (follow-up 11): '/' is matched by the character it types, so a German layout's Shift+7 opens cursor
// chat (a key event as that layout sends it: key '/', code Digit7, Shift); a phone with no cursor is not offered
// cursor chat at all.
test('K.1: a layout that needs Shift for / (German Shift+7) opens cursor chat, and the line reaches B', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'commenter')
  await pointerOnCanvas(a, b)
  const cdp = await a.page.context().newCDPSession(a.page)
  const SHIFT = 8
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Shift',
    code: 'ShiftLeft',
    modifiers: SHIFT,
    windowsVirtualKeyCode: 16,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: '/',
    code: 'Digit7',
    text: '/',
    unmodifiedText: '7',
    modifiers: SHIFT,
    windowsVirtualKeyCode: 55,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: '/',
    code: 'Digit7',
    modifiers: SHIFT,
    windowsVirtualKeyCode: 55,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Shift',
    code: 'ShiftLeft',
    modifiers: 0,
    windowsVirtualKeyCode: 16,
  })
  const input = a.page.getByTestId('cursor-chat-input')
  await expect(input).toBeFocused()
  // the '/' that opened it is not typed into it
  await expect(input).toHaveValue('')
  await a.page.keyboard.type('Hallo zusammen', { delay: 10 })
  await a.page.keyboard.press('Enter')
  await expect(bubbleOf(b.page, a.id)).toHaveText('Hallo zusammen', { timeout: 2_000 })
})

test('K.1: on a phone (touch, no cursor) cursor chat is not offered: / from an attached keyboard does nothing, and the command is not offered (no shortcuts-dialog row)', async ({
  browser,
  board,
  users,
}) => {
  const a = await openPhoneSession(browser, board, users, 'alice')
  try {
    expect(await a.page.evaluate(() => matchMedia('(any-hover: hover)').matches)).toBe(false)
    // the board has the keyboard (a keyboard attached to the phone): before K.1 '/' opened a composer there
    await a.page.evaluate(() =>
      (document.querySelector('[data-lobby-board-canvas] canvas') as HTMLElement | null)?.focus(),
    )
    await a.page.keyboard.press('/')
    await a.page.waitForTimeout(300)
    await expect(a.page.getByTestId('cursor-chat-input')).toHaveCount(0)
    const rows = await a.page.evaluate(async () => {
      const w = window as unknown as {
        __lobbyBoard?: { registries: { commands: { list(): { id: string; available?: () => boolean }[] } } }
      }
      const cmd = w.__lobbyBoard?.registries.commands.list().find((c) => c.id === 'cursor-chat.open')
      return { registered: !!cmd, offered: cmd?.available ? cmd.available() : true }
    })
    expect(rows).toEqual({ registered: true, offered: false })
  } finally {
    await a.context.close()
  }
})
