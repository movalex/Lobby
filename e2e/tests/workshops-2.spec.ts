// Workshops, second wave (checklist FAC-08; docs/REVIEW-2026-09-27.md RETRO-07 "reactions / +1, raise
// hand"): reactions, +1 on sticky notes and raise hand, driven through the real UI by several people
// at once: alice = board owner and facilitator, bob = editor (a facilitator too), carol = viewer,
// dave = commenter (a late joiner). What each person sees is asserted in their own browser; what the
// servers relay, store and refuse is asserted on the wire (DevTools Network domain) and through the
// API as that person.
import { edit, getShape, read } from './support/board.ts'
import { capture } from './support/screenshots.ts'
import {
  closeWorkshopPopover,
  expect,
  openWorkshopPopover,
  reloadBoard,
  showAll,
  test,
  type WorkshopSession,
} from './support/workshops.ts'
import {
  addNotes,
  burstAnimation,
  bursts,
  captureLive,
  clickPlusOne,
  closeReactionBar,
  expectShapes,
  handsChip,
  handsOnServer,
  hoverNote,
  openQueue,
  openReactionBar,
  plusOne,
  plusOnesIn,
  plusOnesOnServer,
  queueIds,
  react,
  setHand,
} from './support/workshops-2.ts'

const EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👏']

/** The sender's cursor as `page` has it, in that page's viewport (canvas) coordinates. */
const cursorOnScreen = (s: WorkshopSession, userId: string) =>
  read(
    s.page,
    (ed, uid) => {
      const e = ed as unknown as {
        getCollaborators(): { userId: string; cursor: { x: number; y: number } | null }[]
        pageToViewport(p: { x: number; y: number }): { x: number; y: number }
      }
      const c = e.getCollaborators().find((x) => x.userId === uid)
      return c?.cursor ? e.pageToViewport(c.cursor) : null
    },
    `user:${userId}`,
  )

const post = (s: WorkshopSession, path: string, body?: unknown) => s.api.fetch('POST', path, body ?? {})

// ---- reactions ---------------------------------------------------------------------------------------

/** Carol's pointer rests on the canvas, and alice has her cursor there. */
async function pointerOnCanvas(sender: WorkshopSession, receiver: WorkshopSession) {
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
  // Just above the pointer's tip (apps/web features/workshops/reactions.ts CURSOR_BURST_OFFSET).
  const off = (p: { x: number; y: number } | null) =>
    p ? Math.max(Math.abs(pos.x - (p.x + 4)), Math.abs(pos.y - (p.y - 20))) : Number.POSITIVE_INFINITY
  expect(Math.min(off(before), off(after)), JSON.stringify({ pos, before, after })).toBeLessThanOrEqual(2)
  expect(await burstAnimation(atAlice)).toBe('dr-wk-burst-up')
  // Bob prefers reduced motion: the same burst, but it only fades in and out.
  const atBob = bursts(b.page, c.id, '🎉')
  await expect(atBob).toHaveCount(1)
  expect(await burstAnimation(atBob)).toBe('dr-wk-burst-fade')
  await captureLive('workshops2-reaction-burst.png', a.page, testInfo)
  // A moment later it is gone everywhere.
  for (const s of [a, b, c]) await expect(bursts(s.page, c.id, '🎉')).toHaveCount(0, { timeout: 5_000 })

  // On the wire: the reaction, named from Carol's session, and nothing else.
  for (const s of [a, b])
    expect(s.net.eventsOf('workshop.reaction').map((e) => e.data)).toEqual([
      { userId: c.id, name: 'Carol Diaz', emoji: '🎉' },
    ])

  await c.page.keyboard.press('Escape')
  await expect(c.page.getByTestId('reaction-bar')).toHaveCount(0)

  // With the mouse, her pointer is up at the top bar: the burst goes under the top bar, with her name.
  // (Each receiver places a burst where it last saw the sender's cursor; presence arrives on its own
  // schedule, so wait until alice sees Carol's pointer up there before she picks the reaction.)
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
  await captureLive('workshops2-reaction-lane.png', a.page, testInfo)
  await closeReactionBar(c.page)

  // A facilitator hides everyone's cursors: no burst gives a cursor away then, even with Carol's
  // pointer on the canvas (each receiver places a burst, so alice's own setting applies at once).
  const pop = await openWorkshopPopover(a.page)
  await pop.getByTestId('session-hide-cursors').check()
  await closeWorkshopPopover(a.page)
  await pointerOnCanvas(c, b)
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

// ---- +1 on notes -----------------------------------------------------------------------------------------

const N1 = 'shape:wk2-warmup'
const N2 = 'shape:wk2-shorter'

test('+1 on notes: editors add and remove theirs in one click and everyone sees the count live; a viewer cannot (her UI says why, the server refuses a forged write); concurrent +1s both land; no undo entry; hidden while presenting', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const everyone = [a, b, c]
  await addNotes(
    a.page,
    [
      { id: N1, x: 40, y: 60, text: 'Warm-up game', parentId: 'shape:wk2-frame' },
      { id: N2, x: 300, y: 60, text: 'Shorter retro', parentId: 'shape:wk2-frame' },
    ],
    { id: 'shape:wk2-frame', x: 0, y: 0, w: 560, h: 320 },
  )
  await expectShapes(everyone, [N1, N2])
  for (const s of everyone) await showAll(s.page)

  // Bob hovers the note: the +1 control shows (no count yet); one click adds his.
  await hoverNote(b.page, N1)
  const bobs = plusOne(b.page, N1)
  await expect(bobs).toHaveAttribute('data-active', 'true')
  await expect(bobs).toHaveAttribute('data-count', '0')
  await expect(bobs).toHaveAttribute('aria-pressed', 'false')
  // Something Bob can undo first: a colour change (the +1 must not become the undo step).
  await edit(
    b.page,
    (ed, id) => {
      ed.markHistoryStoppingPoint('colour')
      ed.updateShape({ id, type: 'note', props: { color: 'blue' } })
    },
    N2,
  )
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
  await expect.poll(() => plusOnesOnServer(a.api, board, N1)).toEqual([b.id, a.id])
  await capture('workshops2-plus-ones.png', a.page, testInfo)

  // Ctrl+Z undoes Bob's colour change, not his +1 (a +1 is not an edit of the note).
  await b.page.keyboard.press('Control+z')
  await expect.poll(() => getShape(b.page, N2).then((s) => s?.props.color)).not.toBe('blue')
  expect(await plusOnesIn(b.page, N1)).toEqual([b.id, a.id])

  // Carol (viewer) sees the count; on the note she selects, the control is disabled and says why.
  await expect(plusOne(c.page, N1)).toHaveAttribute('data-readonly', 'true')
  await hoverNote(c.page, N1)
  await c.page.mouse.down()
  await c.page.mouse.up()
  const hers = plusOne(c.page, N1)
  await expect(hers).toHaveAttribute('data-active', 'true')
  await expect(hers).toHaveAttribute('aria-disabled', 'true')
  // aria-disabled, not disabled: it can still be pressed (Playwright waits for "enabled" unless forced).
  await hers.click({ force: true })
  await expect(c.page.getByTestId('plusone-toast')).toContainText(
    'Only people who can edit this board can +1 notes',
  )
  expect(await plusOnesIn(c.page, N1)).toEqual([b.id, a.id])
  await capture('workshops2-plus-ones-viewer.png', c.page, testInfo)
  // A client that ignores its read-only flag: the sync server refuses the write, it is rolled back.
  await edit(
    c.page,
    (ed, arg) => {
      ed.updateInstanceState({ isReadonly: false })
      ed.updateShape({ id: arg.id, type: 'note', meta: { plusOnes: arg.list } })
    },
    { id: N1, list: [b.id, a.id, c.id] },
  )
  await expect.poll(() => plusOnesIn(c.page, N1)).toEqual([b.id, a.id])
  await edit(c.page, (ed) => ed.updateInstanceState({ isReadonly: true }))
  expect(await plusOnesIn(a.page, N1)).toEqual([b.id, a.id])
  expect(await plusOnesOnServer(a.api, board, N1)).toEqual([b.id, a.id])

  // Bob takes his back.
  await clickPlusOne(b.page, N1)
  await expect(plusOne(b.page, N1)).toHaveAttribute('aria-pressed', 'false')
  for (const s of everyone) await expect(plusOne(s.page, N1)).toHaveAttribute('data-count', '1')

  // Alice and Bob +1 the other note at the same moment: both land, for everyone and on the server.
  await hoverNote(a.page, N2)
  await hoverNote(b.page, N2)
  await Promise.all([plusOne(a.page, N2).click(), plusOne(b.page, N2).click()])
  const both = [a.id, b.id].sort()
  for (const s of everyone)
    await expect
      .poll(() => plusOnesIn(s.page, N2).then((l) => [...l].sort()), { message: s.user })
      .toEqual(both)
  await expect.poll(() => plusOnesOnServer(a.api, board, N2).then((l) => [...l].sort())).toEqual(both)
  for (const s of everyone) await expect(plusOne(s.page, N2)).toHaveAttribute('data-count', '2')

  // Presenting keeps the slides clean: no +1s, back after Esc.
  await a.page.mouse.move(5, 300) // off the notes
  await a.page.getByTestId('present-button').click()
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  await expect(a.page.getByTestId('plusone')).toHaveCount(0)
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
  await expect(plusOne(a.page, N2)).toHaveAttribute('data-count', '2')

  // Stored with the board: Carol reloads and still sees them.
  await reloadBoard(c)
  await showAll(c.page)
  await expect(plusOne(c.page, N1)).toHaveAttribute('data-count', '1')
  await expect(plusOne(c.page, N2)).toHaveAttribute('data-count', '2')
})

// ---- raise hand ------------------------------------------------------------------------------------------

test('raise hand: a viewer and an editor raise hands, facilitators are told and get the queue in order, a late joiner sees it, a facilitator lowers one, a closed tab lowers the other, a reload keeps a hand up', async ({
  join,
  board,
}, testInfo) => {
  test.setTimeout(180_000)
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  // One slide, so that alice can present later.
  await addNotes(
    a.page,
    [{ id: 'shape:wk2-agenda', x: 40, y: 60, text: 'Agenda', parentId: 'shape:wk2-slide' }],
    {
      id: 'shape:wk2-slide',
      x: 0,
      y: 0,
      w: 400,
      h: 300,
    },
  )

  await setHand(c.page, true)
  await expect(c.page.getByTestId('reactions-button')).toHaveAttribute('data-hand', 'up')
  for (const s of [a, b, c]) await expect(handsChip(s.page)).toHaveAttribute('data-count', '1')
  await expect(handsChip(c.page)).toHaveAttribute('data-mine', 'true')
  // Facilitators (alice, and bob as an editor) are told; carol is not told about her own hand.
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
  await capture('workshops2-hands-queue.png', a.page, testInfo)

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

  // Presenting hides the top bar and the toasts: the presenter still sees the hand, and whose.
  await a.page.getByTestId('present-button').click()
  await expect(a.page.getByTestId('present-overlay')).toBeVisible()
  const floating = a.page.getByTestId('hands-floating')
  await expect(floating).toHaveAttribute('data-count', '1')
  await expect(floating).toContainText('Carol Diaz')
  await setHand(d.page, true) // and a new one shows up while presenting
  await expect(floating).toHaveAttribute('data-count', '2')
  await expect(floating).toContainText('Carol Diaz, Dave Okafor')
  await capture('workshops2-hands-presenting.png', a.page, testInfo)
  await a.page.keyboard.press('Escape')
  await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
  await expect(floating).toHaveCount(0)

  // Carol lowers hers herself from the bar; a facilitator lowers all that are left.
  await setHand(c.page, false)
  for (const s of [a, c, d]) await expect(handsChip(s.page)).toHaveAttribute('data-count', '1')
  await (await openQueue(a.page)).getByTestId('hand-lower').click()
  for (const s of [a, c, d]) await expect(handsChip(s.page)).toHaveCount(0)
  await expect(d.page.getByTestId('hand-lowered-toast')).toContainText('Alice Park lowered your hand.')
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
  // Each page's stream reconnects and refetches; the new process's list replaces the old one.
  for (const s of [a, c]) await expect(handsChip(s.page)).toHaveCount(0, { timeout: 45_000 })
  await expect(c.page.getByTestId('reactions-button')).toHaveAttribute('data-hand', 'down')
  expect(await handsOnServer(a.api, board)).toEqual([])

  await setHand(c.page, true)
  await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')
  await react(c.page, '👏')
  await expect(bursts(a.page, c.id, '👏')).toHaveCount(1)
})
