// OWNER: 3f. Reactions, +1 on notes, raise hand and the session settings on the Excalidraw board page,
// ported from tests/workshops-2.spec.ts (reactions, +1, raise hand, the api restart),
// tests/facilitation-review.fix.spec.ts (RETRO-03a + RETRO-07a, the board part) and
// tests/phone-overlays.spec.ts (R2-07; A11Y2-05's reactions bar). alice = board owner and facilitator,
// bob = editor (a facilitator too), carol = viewer, dave = commenter (a late joiner).
//
// Differences from the tldraw specs (docs/research/excalidraw/wave3/3F.md):
//  - A +1 is the note's identity-bound `customData.lobby['plusOne:<uid>']` key: the server's copy is read
//    from the test snapshot, a viewer's forged +1 goes through a raw socket (tldraw: flipping the editor's
//    read-only flag) and is refused `READ_ONLY`.
//  - "A +1 is not an undo step" is its own test, expected to fail until transact can skip the undo stack
//    (change request CR-3F-1); on this page a +1 is a `transact`, one undo step.
//  - The note-author label is the workshops feature's overlay (CR-3F-4, wave 3b), not the tldraw note face
//    (`.tl-note__attribution`): the test id `note-author`. Overlays are never exported, so RETRO-03a's
//    Present and export steps (3e) check that no slide, PNG or SVG names alice although the canvas holds
//    her attribution (the tldraw page stripped its drawn label from the SVG it rasterized; this page's
//    PNG is not made from an SVG).
import type { Locator, Page } from '@playwright/test'
import { item, itemBounds, select, updateItem, viewport } from '../tests/support/canvas.ts'
import { forgeSession, storedElement } from '../tests/support/excalidraw.ts'
import { downloadFrom } from '../tests/support/present-export.ts'
import { capture } from '../tests/support/screenshots.ts'
import { closeWorkshopPopover, openWorkshopPopover } from '../tests/support/workshops.ts'
import {
  burstAnimation,
  bursts,
  captureLive,
  closeReactionBar,
  handsChip,
  handsOnServer,
  openQueue,
  openReactionBar,
  queueIds,
  react,
  setHand,
} from '../tests/support/workshops-2.ts'
import {
  clickPlusOne,
  expect,
  expectItemsEverywhere,
  focusCanvas,
  hoverNote,
  plusOne,
  plusOnesIn,
  plusOnesOfElement,
  post,
  reloadBoard,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

const EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👏']
/** The sender's cursor as `s` draws it, in overlay pixels (the board page's cursor layer), or null. */
const cursorOnScreen = (s: WorkshopCanvasSession, userId: string) =>
  s.page.evaluate((uid) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="cursor"][data-uid="${uid}"]`)
    return el ? { x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) } : null
  }, userId)

// ---- reactions -----------------------------------------------------------------------------------------------

/** The sender's pointer rests on the canvas, and the receiver has their cursor there. */
async function pointerOnCanvas(sender: WorkshopCanvasSession, receiver: WorkshopCanvasSession) {
  const vp = sender.page.viewportSize() ?? { width: 1280, height: 720 }
  const p = { x: Math.round(vp.width / 2 - 120), y: Math.round(vp.height / 2 + 40) }
  await sender.page.mouse.move(p.x + 30, p.y + 30)
  await sender.page.mouse.move(p.x, p.y, { steps: 4 })
  await expect
    .poll(async () => {
      const c = await cursorOnScreen(receiver, sender.id)
      return !!c && c.y > 60 // on the canvas, not up at the top bar
    })
    .toBe(true)
}

test('reactions: a viewer’s reaction bursts for everyone (near her cursor when it is on the canvas, else under the top bar with her name, a fade only with reduced motion); the server relays only the six, at most five a second, and stores nothing', async ({
  join,
  board,
  users,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await b.page.emulateMedia({ reducedMotion: 'reduce' })

  // The bar: six reactions and the hand, for a viewer too.
  const bar = await openReactionBar(c.page)
  await expect(bar.getByTestId('reaction-option')).toHaveCount(6)
  expect(
    await bar
      .getByTestId('reaction-option')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-emoji'))),
  ).toEqual(EMOJIS)
  await expect(bar.getByTestId('reaction-option').first()).toBeFocused()
  await expect(bar.getByTestId('hand-toggle')).toBeEnabled()
  await closeReactionBar(c.page)
  await expect(c.page.getByTestId('reactions-button')).toBeFocused()

  // By keyboard, with her pointer resting on the canvas: the others see the burst at her cursor.
  await pointerOnCanvas(c, a)
  const before = await cursorOnScreen(a, c.id)
  await c.page.getByTestId('reactions-button').focus()
  await c.page.keyboard.press('Enter')
  await expect(c.page.getByTestId('reaction-bar')).toBeVisible()
  for (let i = 0; i < 3; i++) await c.page.keyboard.press('ArrowRight')
  await expect(c.page.locator('[data-testid="reaction-option"][data-emoji="🎉"]')).toBeFocused()
  await c.page.keyboard.press('Enter')
  // Carol: her own, at once, under the top bar next to the button she pressed.
  await expect(bursts(c.page, c.id, '🎉')).toHaveAttribute('data-placement', 'top')
  await expect(bursts(c.page, c.id, '🎉')).toHaveAttribute('data-mine', 'true')
  // Alice: next to Carol's cursor (where it was when the reaction arrived).
  const atAlice = bursts(a.page, c.id, '🎉')
  await expect(atAlice).toHaveAttribute('data-placement', 'cursor')
  const pos = await atAlice.evaluate((el) => ({
    x: Number.parseFloat((el as HTMLElement).style.left),
    y: Number.parseFloat((el as HTMLElement).style.top),
  }))
  const after = await cursorOnScreen(a, c.id)
  // Just above the pointer's tip (features/workshops/reactions.ts CURSOR_BURST_OFFSET).
  const off = (p: { x: number; y: number } | null) =>
    p ? Math.max(Math.abs(pos.x - (p.x + 4)), Math.abs(pos.y - (p.y - 20))) : Number.POSITIVE_INFINITY
  expect(Math.min(off(before), off(after)), JSON.stringify({ pos, before, after })).toBeLessThanOrEqual(2)
  expect(await burstAnimation(atAlice)).toBe('dr-wk-burst-up')
  // Bob prefers reduced motion: the same burst, but it only fades in and out.
  const atBob = bursts(b.page, c.id, '🎉')
  await expect(atBob).toHaveCount(1)
  expect(await burstAnimation(atBob)).toBe('dr-wk-burst-fade')
  await captureLive('lc-workshops2-reaction-burst.png', a.page, testInfo)
  for (const s of [a, b, c]) await expect(bursts(s.page, c.id, '🎉')).toHaveCount(0, { timeout: 5_000 })

  // On the wire: the reaction, named from Carol's session, and nothing else.
  for (const s of [a, b])
    expect(s.net.eventsOf('workshop.reaction').map((e) => e.data)).toEqual([
      { userId: c.id, name: 'Carol Diaz', emoji: '🎉' },
    ])

  await c.page.keyboard.press('Escape')
  await expect(c.page.getByTestId('reaction-bar')).toHaveCount(0)

  // With the mouse, her pointer is up at the top bar: the burst goes under the top bar, with her name.
  await openReactionBar(c.page)
  await expect
    .poll(async () => {
      const p = await cursorOnScreen(a, c.id)
      return !p || p.y < 48
    })
    .toBe(true)
  await react(c.page, '👍')
  const lane = bursts(a.page, c.id, '👍')
  await expect(lane).toHaveAttribute('data-placement', 'top')
  await expect(lane).toContainText('Carol Diaz')
  await captureLive('lc-workshops2-reaction-lane.png', a.page, testInfo)
  await closeReactionBar(c.page)

  // A facilitator hides everyone's cursors: no burst gives a cursor away then.
  const pop = await openWorkshopPopover(a.page)
  await pop.getByTestId('session-hide-cursors').check()
  await closeWorkshopPopover(a.page)
  await c.page.mouse.move(400, 400)
  await c.page.mouse.move(420, 420, { steps: 3 })
  for (const s of [a, b]) await expect(bursts(s.page, c.id, '👍')).toHaveCount(0, { timeout: 5_000 })
  await c.page.getByTestId('reactions-button').focus()
  await c.page.keyboard.press('Enter')
  await c.page.keyboard.press('Enter') // the first reaction, 👍
  await expect(bursts(a.page, c.id, '👍')).toHaveAttribute('data-placement', 'top')
  await expect(bursts(b.page, c.id, '👍')).toHaveAttribute('data-placement', 'top')
  await c.page.keyboard.press('Escape')

  // The server: the allowlist, the per-person limit, outsiders, and nothing stored.
  await c.page.waitForTimeout(1_100) // the UI's reactions have left the one-second window
  const path = `/api/boards/${board}/reactions`
  for (const body of [{ emoji: '💩' }, { emoji: '❤' }, { emoji: 'a' }, {}])
    expect((await post(c, path, body)).status(), JSON.stringify(body)).toBe(400)
  const statuses: number[] = []
  for (let i = 0; i < 6; i++) statuses.push((await post(c, path, { emoji: '👏' })).status())
  expect(statuses).toEqual([202, 202, 202, 202, 202, 429])
  await expect
    .poll(() => a.net.eventsOf('workshop.reaction').filter((e) => e.raw.includes('👏')).length)
    .toBe(5)
  const dave = await users.api('dave') // signed in, no access to this board
  expect((await dave.fetch('POST', path, { emoji: '👍' })).status()).toBe(404)
  const state = await a.api.fetch('GET', `/api/boards/${board}/workshop`)
  const text = await state.text()
  for (const e of EMOJIS) expect(text).not.toContain(e)
  // The bar says when this person is going too fast (without sending).
  await openReactionBar(c.page)
  for (let i = 0; i < 7; i++)
    await c.page.locator('[data-testid="reaction-option"][data-emoji="😂"]').click({ delay: 0 })
  await expect(c.page.getByTestId('reaction-hint')).toContainText('at most 5 reactions a second')
})

// ---- +1 on notes -------------------------------------------------------------------------------------------

const N1 = 'wk2-warmup'
const N2 = 'wk2-shorter'

async function twoNotesInAFrame(page: Page) {
  await seed(page, {
    frames: [{ id: 'wk2-frame', x: 0, y: 0, w: 560, h: 320, name: 'Ideas' }],
    notes: [
      { id: N1, x: 40, y: 60, text: 'Warm-up game', frameId: 'wk2-frame' },
      { id: N2, x: 300, y: 60, text: 'Shorter retro', frameId: 'wk2-frame' },
    ],
  })
}

test('+1 on notes: editors add and remove theirs in one click and everyone sees the count live; a viewer cannot (her UI says why, the server refuses a forged write); concurrent +1s both land', async ({
  join,
  board,
  stack,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const everyone = [a, b, c]
  await twoNotesInAFrame(a.page)
  await expectItemsEverywhere(everyone, [N1, N2])
  for (const s of everyone) await showAll(s.page)

  // Bob hovers the note: the +1 control shows (no count yet); one click adds his.
  await hoverNote(b.page, N1)
  const bobs = plusOne(b.page, N1)
  await expect(bobs).toHaveAttribute('data-active', 'true')
  await expect(bobs).toHaveAttribute('data-count', '0')
  await expect(bobs).toHaveAttribute('aria-pressed', 'false')
  await bobs.click()
  await expect(bobs).toHaveAttribute('aria-pressed', 'true')
  await expect(bobs).toHaveAttribute('data-count', '1')
  // Everyone else sees the count on the note, live.
  for (const s of [a, c]) {
    await expect(plusOne(s.page, N1)).toHaveAttribute('data-count', '1')
    await expect(plusOne(s.page, N1)).toHaveAttribute('data-mine', 'false')
  }
  await clickPlusOne(a.page, N1)
  for (const s of everyone) await expect(plusOne(s.page, N1)).toHaveAttribute('data-count', '2')
  await expect(plusOne(a.page, N1)).toHaveAttribute('aria-pressed', 'true')
  const both1 = [a.id, b.id].sort()
  await expect.poll(async () => plusOnesOfElement(await storedElement(stack, board, N1))).toEqual(both1)
  await capture('lc-workshops2-plus-ones.png', a.page, testInfo)

  // Carol (viewer) sees the count; on the note she selects, the control is disabled and says why.
  await expect(plusOne(c.page, N1)).toHaveAttribute('data-readonly', 'true')
  await select(c.page, [N1])
  const hers = plusOne(c.page, N1)
  await expect(hers).toHaveAttribute('data-active', 'true')
  await expect(hers).toHaveAttribute('aria-disabled', 'true')
  await hers.click({ force: true })
  await expect(c.page.getByTestId('plusone-toast')).toContainText(
    'Only people who can edit this board can +1 notes',
  )
  expect(await plusOnesIn(c.page, N1)).toEqual(both1)
  await capture('lc-workshops2-plus-ones-viewer.png', c.page, testInfo)
  // A forged +1 through a raw socket with her own ticket: the sync server refuses it.
  const { socket, welcome } = await forgeSession(c.page, board)
  try {
    expect(welcome.readonly).toBe(true)
    const stored = await storedElement(stack, board, N1)
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [{ k: 'p', id: N1, pv: (stored?.version ?? 1) as number, c: { [`plusOne:${c.id}`]: true } }],
    })
    const ack = await socket.next('ack')
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['READ_ONLY'])
  } finally {
    await socket.close()
  }
  expect(await plusOnesIn(a.page, N1)).toEqual(both1)
  expect(plusOnesOfElement(await storedElement(stack, board, N1))).toEqual(both1)

  // Bob takes his back.
  await clickPlusOne(b.page, N1)
  await expect(plusOne(b.page, N1)).toHaveAttribute('aria-pressed', 'false')
  for (const s of everyone) await expect(plusOne(s.page, N1)).toHaveAttribute('data-count', '1')

  // Alice and Bob +1 the other note at the same moment: both land, for everyone and on the server.
  await hoverNote(a.page, N2)
  await hoverNote(b.page, N2)
  await Promise.all([plusOne(a.page, N2).click(), plusOne(b.page, N2).click()])
  for (const s of everyone)
    await expect.poll(() => plusOnesIn(s.page, N2), { message: s.user }).toEqual(both1)
  await expect.poll(async () => plusOnesOfElement(await storedElement(stack, board, N2))).toEqual(both1)
  for (const s of everyone) await expect(plusOne(s.page, N2)).toHaveAttribute('data-count', '2')

  // Stored with the board: Carol reloads and still sees them.
  await reloadBoard(c)
  await showAll(c.page)
  await expect(plusOne(c.page, N1)).toHaveAttribute('data-count', '1')
  await expect(plusOne(c.page, N2)).toHaveAttribute('data-count', '2')
})

test('+1 on notes: a +1 is not an undo step (Ctrl+Z undoes the colour change before it) (CR-3F-1)', async ({
  join,
}) => {
  test.fail(
    true,
    'CR-3F-1: on this page a +1 is a transact, so one undo step, until transact can skip the undo stack',
  )
  const b = await join('bob', 'editor')
  await twoNotesInAFrame(b.page)
  await showAll(b.page)
  // Something Bob can undo first: a colour change.
  await updateItem(b.page, N2, { backgroundColor: '#a7b7f6' })
  await clickPlusOne(b.page, N1)
  await expect(plusOne(b.page, N1)).toHaveAttribute('aria-pressed', 'true')
  await focusCanvas(b.page)
  await b.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await item(b.page, N2))?.backgroundColor).not.toBe('#a7b7f6')
  expect(await plusOnesIn(b.page, N1)).toEqual([b.id])
})

test('+1 on notes: hidden while presenting, back after Esc (3e present mode)', async ({ join }) => {
  const a = await join('alice')
  await twoNotesInAFrame(a.page)
  await showAll(a.page)
  await clickPlusOne(a.page, N2)
  await a.page.mouse.move(5, 300)
  await a.page.getByTestId('present-button').click({ timeout: 5_000 })
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  await expect(a.page.getByTestId('plusone')).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
  await expect(plusOne(a.page, N2)).toHaveAttribute('data-count', '1')
})

// ---- raise hand ---------------------------------------------------------------------------------------------

test('raise hand: a viewer and an editor raise hands, facilitators are told and get the queue in order, a late joiner sees it, a facilitator lowers one, a closed tab lowers the other, a reload keeps a hand up', async ({
  join,
  board,
}, testInfo) => {
  test.setTimeout(180_000)
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')

  await setHand(c.page, true)
  await expect(c.page.getByTestId('reactions-button')).toHaveAttribute('data-hand', 'up')
  for (const s of [a, b, c]) await expect(handsChip(s.page)).toHaveAttribute('data-count', '1')
  await expect(handsChip(c.page)).toHaveAttribute('data-mine', 'true')
  for (const s of [a, b])
    await expect(s.page.getByTestId('hand-toast')).toContainText('Carol Diaz raised a hand.')
  await expect(c.page.getByTestId('hand-toast')).toHaveCount(0)

  await setHand(b.page, true)
  for (const s of [a, b, c]) await expect(handsChip(s.page)).toHaveAttribute('data-count', '2')
  await expect(a.page.getByTestId('hand-toast')).toContainText('Bob Chen raised a hand (2 hands up).')

  // "Show queue" on the toast opens the queue, first raised first.
  await a.page.getByTestId('hand-toast-open').click()
  const queue = a.page.getByTestId('hands-queue')
  await expect(queue).toBeVisible()
  expect(await queueIds(queue)).toEqual([c.id, b.id])
  await expect(queue.getByTestId('hand-lower')).toHaveCount(2)
  await expect(queue.getByTestId('hands-clear')).toBeVisible()
  await capture('lc-workshops2-hands-queue.png', a.page, testInfo)

  // A late joiner (dave, commenter) gets the queue from the workshop state; he cannot lower others.
  const d = await join('dave', 'commenter')
  await expect(handsChip(d.page)).toHaveAttribute('data-count', '2')
  const dq = await openQueue(d.page)
  expect(await queueIds(dq)).toEqual([c.id, b.id])
  await expect(dq.getByTestId('hand-lower')).toHaveCount(0)
  expect((await post(d, `/api/boards/${board}/hands/${c.id}/lower`)).status()).toBe(403)
  expect((await post(c, `/api/boards/${board}/hands/clear`)).status()).toBe(403)
  expect(await handsOnServer(a.api, board)).toEqual([c.id, b.id])

  // Alice lowers carol's hand: carol is told, and everyone's queue is down to bob.
  await queue.locator(`[data-testid="hand-row"][data-user-id="${c.id}"]`).getByTestId('hand-lower').click()
  await expect(c.page.getByTestId('hand-lowered-toast')).toContainText('Alice Park lowered your hand.')
  await expect(c.page.getByTestId('reactions-button')).toHaveAttribute('data-hand', 'down')
  for (const s of [a, b, c, d]) await expect(handsChip(s.page)).toHaveAttribute('data-count', '1')
  expect(await queueIds(queue)).toEqual([b.id])
  expect(await queueIds(dq)).toEqual([b.id])
  await expect(handsChip(b.page)).toHaveAttribute('data-mine', 'true')

  // Bob's tab closes: once his event stream has been gone for the grace, his hand goes down for all.
  await b.net.detach()
  await b.context.close()
  for (const s of [a, d]) await expect(handsChip(s.page)).toHaveCount(0, { timeout: 20_000 })
  await expect(queue.getByTestId('hand-row')).toHaveCount(0)
  expect(await handsOnServer(a.api, board)).toEqual([])
  const last = a.net.eventsOf('workshop.hand').at(-1)?.data as { hands: unknown[]; changes: unknown[] }
  expect(last).toMatchObject({
    hands: [],
    changes: [{ userId: b.id, reason: 'disconnected', raised: false }],
  })

  // A reload is not leaving: carol raises again, reloads, and her hand stays up past the grace.
  await setHand(c.page, true)
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')
  await reloadBoard(c)
  await expect(handsChip(c.page)).toHaveAttribute('data-mine', 'true')
  await c.page.waitForTimeout(7_000) // longer than the 5 s grace plus a sweep
  expect(await handsOnServer(a.api, board)).toEqual([c.id])
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')

  // Carol lowers hers herself from the bar; a facilitator lowers all that are left.
  await setHand(d.page, true)
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '2')
  await setHand(c.page, false)
  for (const s of [a, c, d]) await expect(handsChip(s.page)).toHaveAttribute('data-count', '1')
  await (await openQueue(a.page)).getByTestId('hand-lower').click()
  for (const s of [a, c, d]) await expect(handsChip(s.page)).toHaveCount(0)
  await expect(d.page.getByTestId('hand-lowered-toast')).toContainText('Alice Park lowered your hand.')
})

test('raise hand: presenting hides the top bar and the toasts, the presenter still sees the hands, and whose (3e present mode)', async ({
  join,
}) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  const d = await join('dave', 'commenter')
  await seed(a.page, { frames: [{ id: 'wk2-slide', x: 0, y: 0, w: 400, h: 300, name: 'Slide' }] })
  await setHand(c.page, true)
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')
  await a.page.getByTestId('present-button').click({ timeout: 5_000 })
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  const floating = a.page.getByTestId('hands-floating')
  await expect(floating).toHaveAttribute('data-count', '1')
  await expect(floating).toContainText('Carol Diaz')
  await setHand(d.page, true)
  await expect(floating).toHaveAttribute('data-count', '2')
  await expect(floating).toContainText('Carol Diaz, Dave Okafor')
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
  await expect(floating).toHaveCount(0)
})

test('after an api restart: raised hands were in memory, so every page drops the old queue on reconnect; new hands and reactions work at once', async ({
  join,
  stack,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  await setHand(c.page, true)
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')

  await stack.api.restart() // SIGKILL, then a fresh process (the hand registry starts empty)
  for (const s of [a, c]) await expect(handsChip(s.page)).toHaveCount(0, { timeout: 45_000 })
  await expect(c.page.getByTestId('reactions-button')).toHaveAttribute('data-hand', 'down')
  expect(await handsOnServer(a.api, board)).toEqual([])

  await setHand(c.page, true)
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')
  await react(c.page, '👏')
  await expect(bursts(a.page, c.id, '👏')).toHaveCount(1)
})

// ---- RETRO-03a + RETRO-07a: hide note authors and cursors (facilitation-review.fix, the board part) ------------

test('RETRO-03a + RETRO-07a: a facilitator hides note authors and cursors for everyone, on the board, in Present and in exports; the others are told what is in effect', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    frames: [{ id: 'fr-frame', x: -40, y: -40, w: 600, h: 320, name: 'Ideas' }],
    notes: [{ id: 'fr-authored', x: 0, y: 0, text: 'Anonymous idea', frameId: 'fr-frame' }],
  })
  await expectItemsEverywhere([b], ['fr-authored'])
  for (const s of [a, b]) await showAll(s.page)
  const cursors = (page: Page) => page.getByTestId('cursor')

  await test.step('before: bob sees alice’s cursor', async () => {
    await a.page.mouse.move(300, 300)
    await a.page.mouse.move(320, 330)
    await expect(cursors(b.page)).toHaveCount(1)
    await expect(b.page.locator('html')).not.toHaveAttribute('data-dr-hide-authors', 'true')
  })

  await test.step('alice switches both on in the workshop popover', async () => {
    const pop = await openWorkshopPopover(a.page)
    await expect(pop.getByTestId('session-settings')).toContainText('still records who last edited')
    await pop.getByTestId('session-hide-authors').check()
    await pop.getByTestId('session-hide-cursors').check()
    await closeWorkshopPopover(a.page)
  })

  await test.step('bob: note authors are hidden on the board, no cursor from alice; alice sees no cursor from bob', async () => {
    await expect(b.page.locator('html')).toHaveAttribute('data-dr-hide-authors', 'true')
    await a.page.mouse.move(400, 300)
    await a.page.mouse.move(420, 340)
    await b.page.mouse.move(300, 300)
    await b.page.mouse.move(330, 310)
    await expect(cursors(b.page)).toHaveCount(0)
    await expect(cursors(a.page)).toHaveCount(0)
    // The settings are the board's (synced, lb_doc `workshop`): bob, an editor, sees them on.
    const pop = await openWorkshopPopover(b.page)
    await expect(pop.getByTestId('session-hide-authors')).toBeChecked()
    await expect(pop.getByTestId('session-hide-cursors')).toBeChecked()
    await closeWorkshopPopover(b.page)
    // A viewer (who cannot change it) is told what is in effect. She joins after the room's 5 s snapshot
    // cache has let go of the snapshot made before the settings changed (DEF-3F-1: a joiner inside that
    // window gets the older board document; its own test below).
    await a.page.waitForTimeout(5_500)
    const c = await join('carol', 'viewer')
    await expect(c.page.locator('html')).toHaveAttribute('data-dr-hide-authors', 'true')
    // …from the server's board document (a fresh session reads it from its welcome)
    expect(
      await c.page.evaluate(() =>
        (
          window as unknown as { __lobbyBoard: { canvas: { doc: { get(k: string): unknown } } } }
        ).__lobbyBoard.canvas.doc.get('workshop'),
      ),
    ).toEqual({ hideNoteAuthors: true, hideCursors: true })
    const cpop = await openWorkshopPopover(c.page)
    await expect(cpop.getByTestId('session-settings')).toContainText('hidden the names on sticky notes')
    await expect(cpop.getByTestId('session-settings')).toContainText('hidden everyone’s cursors')
    await expect(cpop.getByTestId('session-hide-authors')).toHaveCount(0)
    await closeWorkshopPopover(c.page)
  })

  await test.step('bob presents: no author label and no cursor on the slide; after Esc the session still hides them', async () => {
    await b.page.getByTestId('present-button').click()
    await expect(b.page.getByTestId('present-overlay')).toBeVisible()
    await expect(b.page.getByTestId('present-counter')).toHaveText('1 / 1')
    await expect(b.page.getByTestId('note-author')).toHaveCount(0)
    await a.page.mouse.move(380, 320)
    await a.page.mouse.move(400, 350, { steps: 3 })
    await b.page.waitForTimeout(1_000) // a cursor would have arrived by now
    await expect(cursors(b.page)).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
    // Present mode's cursor filter gave way; the session's setting still hides alice's cursor (W3-4).
    await expect(b.page.locator('html')).toHaveAttribute('data-dr-hide-authors', 'true')
    await a.page.mouse.move(300, 300)
    await a.page.mouse.move(330, 330, { steps: 3 })
    await b.page.waitForTimeout(1_000)
    await expect(cursors(b.page)).toHaveCount(0)
  })

  await test.step('bob exports: the PNG and the SVG name nobody (the canvas knows who made the note)', async () => {
    // The board holds the server's attribution of alice's note (customData.lobbyServer, from her ticket)…
    const attribution = await b.page.evaluate(
      () =>
        (
          window as unknown as {
            lobbyCanvas: {
              get(id: string): { customData?: { lobbyServer?: { createdBy?: { uid?: string } } } } | undefined
            }
          }
        ).lobbyCanvas.get('fr-authored')?.customData?.lobbyServer?.createdBy?.uid ?? null,
    )
    expect(attribution).toBe(a.id)
    // …and no export carries it: the note-author label is an overlay, which exports never draw, and the
    // exports embed no scene data (the tldraw page stripped its drawn label from the SVG instead).
    const dialog = b.page.getByTestId('export-dialog')
    await b.page.getByTestId('export-button').click()
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-area-board').check()
    const png = await downloadFrom(b.page, () => dialog.getByTestId('export-png').click())
    expect(png.bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
    const svg = await downloadFrom(b.page, () => dialog.getByTestId('export-svg').click())
    const text = svg.bytes.toString('utf8')
    expect(text).toContain('Anonymous')
    for (const who of [a.name, a.id]) {
      expect(png.bytes.includes(Buffer.from(who, 'utf8')), `PNG names ${who}`).toBe(false)
      expect(text, `SVG names ${who}`).not.toContain(who)
    }
    await b.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  await test.step('alice switches cursors back on: they come back for everyone', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('session-hide-cursors').uncheck()
    await closeWorkshopPopover(a.page)
    await a.page.mouse.move(300, 300)
    await a.page.mouse.move(320, 330)
    await expect(cursors(b.page)).toHaveCount(1)
  })
})

test('RETRO-03a: someone who joins right after a facilitator changed the session settings gets them (DEF-3F-1)', async ({
  join,
}) => {
  test.fail(
    true,
    'DEF-3F-1: a joiner within 5 s of the last reset snapshot gets that snapshot’s older board document (room element-room.ts snapshotFor; engine.ts applies frame.doc over the welcome’s doc)',
  )
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const pop = await openWorkshopPopover(a.page)
  await pop.getByTestId('session-hide-authors').check()
  await closeWorkshopPopover(a.page)
  await expect(b.page.locator('html')).toHaveAttribute('data-dr-hide-authors', 'true')
  const c = await join('carol', 'viewer')
  await expect(c.page.locator('html')).toHaveAttribute('data-dr-hide-authors', 'true', { timeout: 3_000 })
})

test('RETRO-03a: the note-author label on the board hides with "Hide note authors" (CR-3F-4)', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: 'fr-authored', x: 0, y: 0, text: 'Anonymous idea' }] })
  await expectItemsEverywhere([b], ['fr-authored'])
  await showAll(b.page)
  const label = (page: Page) => page.locator('[data-testid="note-author"][data-note-id="fr-authored"]')
  const first = a.name.split(' ')[0] ?? a.name

  await test.step('before: bob sees alice’s first name in the note’s bottom right corner', async () => {
    await expect(label(b.page)).toHaveText(first, { timeout: 5_000 })
    await expect(label(b.page)).toHaveAttribute('title', a.name)
    await expect(label(b.page)).toBeVisible()
    const note = await itemBounds(b.page, 'fr-authored')
    const v = await viewport(b.page)
    const canvasBox = await b.page.locator('[data-lobby-board-canvas]').boundingBox()
    const box = await label(b.page).boundingBox()
    if (!note || !canvasBox || !box) throw new Error('no note, canvas or label box')
    // the note's bottom right, on screen
    const right = canvasBox.x + (note.x + note.width - v.x) * v.zoom
    const bottom = canvasBox.y + (note.y + note.height - v.y) * v.zoom
    expect(box.x + box.width).toBeLessThanOrEqual(right + 1)
    expect(box.x + box.width).toBeGreaterThan(right - 16 * v.zoom)
    expect(box.y + box.height).toBeLessThanOrEqual(bottom + 1)
    expect(box.y + box.height).toBeGreaterThan(bottom - 12 * v.zoom)
    // it never takes the note's clicks
    await expect(label(b.page)).toHaveCSS('pointer-events', 'none')
  })

  await test.step('the label follows the note when it moves', async () => {
    const before = await label(b.page).boundingBox()
    await updateItem(a.page, 'fr-authored', { x: 60 })
    await expect
      .poll(async () => ((await label(b.page).boundingBox())?.x ?? 0) - (before?.x ?? 0))
      .toBeGreaterThan(20)
  })

  await test.step('alice switches "Hide note authors" on: no label for bob or alice; off: back', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('session-hide-authors').check()
    await closeWorkshopPopover(a.page)
    await expect(b.page.locator('html')).toHaveAttribute('data-dr-hide-authors', 'true')
    await expect(label(b.page)).toHaveCount(0)
    await expect(label(a.page)).toHaveCount(0)
    const again = await openWorkshopPopover(a.page)
    await again.getByTestId('session-hide-authors').uncheck()
    await closeWorkshopPopover(a.page)
    await expect(label(b.page)).toHaveText(first)
  })
})

// ---- R2-07 and A11Y2-05 (phone-overlays) -------------------------------------------------------------------

test('R2-07: an open workshop popover stays above the notices and the canvas cursors; no "Show queue" toast over an open queue', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const pop = await openWorkshopPopover(a.page)
  const zIndex = () =>
    a.page.evaluate(() => Number(getComputedStyle(document.querySelector('.dr-topbar') as Element).zIndex))
  expect(await zIndex()).toBeGreaterThan(300)
  await b.page.getByTestId('reactions-button').click()
  await b.page.getByTestId('hand-toggle').click()
  await expect(pop.getByTestId('hands-queue')).toContainText(b.name)
  await a.page.waitForTimeout(500)
  await expect(a.page.getByTestId('hand-toast-open')).toHaveCount(0)
  const hits = await pop.evaluate((root) =>
    [...root.querySelectorAll('button')].flatMap((el) => {
      const r = el.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      if (r.width === 0 || y > box.bottom - 8) return []
      const at = document.elementFromPoint(x, y)
      return [{ label: el.textContent ?? '', inside: !!at && root.contains(at) }]
    }),
  )
  expect(hits.length).toBeGreaterThan(5)
  for (const h of hits) expect(h.inside, h.label).toBe(true)
  await capture('lc-phone-overlays-07-queue-open.png', a.page, testInfo)
  await a.page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  expect(await zIndex()).toBe(20)
})

test('A11Y2-05: the reactions bar closes when the keyboard leaves it', async ({ join }) => {
  const a = await join('alice')
  await a.page.getByTestId('reactions-button').click()
  const bar: Locator = a.page.getByTestId('reaction-bar')
  await expect(bar).toBeVisible()
  const stops = await bar.locator('button').count()
  for (let i = 0; i < stops + 1; i++) await a.page.keyboard.press('Tab')
  await expect(bar).toHaveCount(0)
})
