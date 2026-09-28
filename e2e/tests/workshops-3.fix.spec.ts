// Workshop follow-ups after the final review (key workshops-3), driven through the real UI:
// - DANA2-02 / R2-01: "A new frame, Private ideas, in view" lands in free space beside the frame in
//   view (a page child, never over or inside another frame), the camera shows it, and Cancel removes
//   the empty frame it made;
// - A11Y2-01: "Add your notes" puts the keyboard in the note box: typing goes into the note, never
//   into the board's tool shortcuts;
// - R2-06: Enter adds the note, Shift+Enter starts a new line, with a visible hint;
// - R2-02 / R2-03: on a phone the Private notes panel shows the running timer and "Time's up", and
//   after the reveal it gets out of the way and the camera goes to the revealed notes;
// - R2-12: a phone keeps a reminder of the open brainstorm, after writing and after a reload;
// - R2-05: no "+1" control on notes while a dot vote is open;
// - R3: someone else's running timer is theirs (and the board owner's) to pause or change.
// Each brainstorm is started by a different person: starts are rate-limited per person.
import type { Page } from '@playwright/test'
import { edit, read } from './support/board.ts'
import type { BoxLike } from './support/editor.ts'
import { capture } from './support/screenshots.ts'
import { expect, openWorkshopPopover, reloadBoard, test, type WorkshopSession } from './support/workshops.ts'

const PROMPT = 'What went well this sprint?'
const post = (s: WorkshopSession, path: string, body?: unknown) => s.api.fetch('POST', path, body ?? {})

async function startBrainstorm(page: Page, target: 'new' | 'selected') {
  const pop = await openWorkshopPopover(page)
  await pop.getByTestId('pn-start').click()
  const dialog = page.getByTestId('pn-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('pn-prompt-input').fill(PROMPT)
  await dialog.getByTestId(target === 'new' ? 'pn-target-new' : 'pn-target-selected').check()
  await dialog.getByTestId('pn-setup-submit').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
}

interface FrameInfo {
  id: string
  name: string
  parentId: string
  bounds: BoxLike
  children: number
}

/** Every frame on the current page, with its page bounds. */
const frames = (page: Page) =>
  read(page, (ed) => {
    const e = ed as unknown as {
      getCurrentPageShapes(): { id: string; type: string; parentId: string; props: { name?: string } }[]
      getShapePageBounds(id: string): BoxLike | undefined
      getSortedChildIdsForParent(id: string): string[]
    }
    return e
      .getCurrentPageShapes()
      .filter((s) => s.type === 'frame')
      .map((s) => ({
        id: s.id,
        name: s.props.name ?? '',
        parentId: s.parentId,
        bounds: e.getShapePageBounds(s.id) as BoxLike,
        children: e.getSortedChildIdsForParent(s.id).length,
      }))
  }) as Promise<FrameInfo[]>

const viewport = (page: Page) =>
  read(page, (ed) =>
    (ed as unknown as { getViewportPageBounds(): BoxLike }).getViewportPageBounds(),
  ) as Promise<BoxLike>

const overlap = (a: BoxLike, b: BoxLike) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const contains = (outer: BoxLike, inner: BoxLike) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.w <= outer.x + outer.w + 0.5 &&
  inner.y + inner.h <= outer.y + outer.h + 0.5

/** A retro frame with six notes, zoomed to fill the view (as in the review: "2 · What went well"). */
async function busyFrameInView(page: Page) {
  await edit(page, (ed) => {
    const e = ed as unknown as {
      createShape(s: unknown): unknown
      zoomToBounds(b: BoxLike, o?: unknown): unknown
    }
    e.createShape({
      id: 'shape:wentwell',
      type: 'frame',
      x: -560,
      y: 216,
      props: { w: 800, h: 960, name: '2 · What went well' },
    })
    for (let i = 0; i < 6; i++)
      e.createShape({
        id: `shape:ww${i}`,
        type: 'note',
        parentId: 'shape:wentwell',
        x: 40 + (i % 3) * 240,
        y: 300 + Math.floor(i / 3) * 240,
      })
    e.zoomToBounds({ x: -560, y: 216, w: 800, h: 960 }, { immediate: true, inset: 40 })
  })
}

test('private notes: a new "Private ideas" frame lands in free space, is shown, and Cancel removes it (DANA2-02, R2-01)', async ({
  join,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const page = alice.page
  await busyFrameInView(page)
  await expect.poll(async () => (await frames(page)).length).toBe(1)
  await capture('workshops3-01-before-start.png', page, testInfo)

  // Nothing selected: the only option is a new frame in view.
  await startBrainstorm(page, 'new')
  const all = await frames(page)
  const created = all.find((f) => f.name === 'Private ideas')
  const existing = all.find((f) => f.id === 'shape:wentwell')
  expect(created, JSON.stringify(all)).toBeTruthy()
  expect(existing).toBeTruthy()
  if (!created || !existing) return
  // A page child, beside (not over, not inside) the frame that was in view.
  expect(created.parentId).toMatch(/^page:/)
  expect(overlap(created.bounds, existing.bounds)).toBe(false)
  // The camera shows it (once the panel has taken its width).
  await expect.poll(async () => contains(await viewport(page), created.bounds), { timeout: 5_000 }).toBe(true)
  // The notes of the frame in view are not hidden behind anything.
  expect(existing.children).toBe(6)
  await capture('workshops3-02-started-new-frame.png', page, testInfo)

  // Cancel: the empty frame made for it goes away again (one Ctrl+Z brings it back).
  const panel = page.getByTestId('pn-panel')
  await panel.getByTestId('pn-cancel').click()
  await panel.getByTestId('pn-cancel-confirm').click()
  await expect(page.getByTestId('pn-toast')).toContainText('cancelled')
  await expect.poll(async () => (await frames(page)).map((f) => f.name)).toEqual(['2 · What went well'])
  await expect(panel.getByTestId('pn-ended')).toHaveAttribute('data-state', 'cancelled')
  await capture('workshops3-03-cancelled.png', page, testInfo)

  // A second brainstorm on a board whose view is full of frames never nests into the first frame.
  await startBrainstorm(page, 'new')
  await startSecondCheck(page)
})

async function startSecondCheck(page: Page) {
  const all = await frames(page)
  const created = all.filter((f) => f.name === 'Private ideas')
  expect(created).toHaveLength(1)
  for (const f of all) expect(f.parentId, f.name).toMatch(/^page:/)
  for (const a of all)
    for (const b of all)
      if (a.id !== b.id) expect(overlap(a.bounds, b.bounds), `${a.name} × ${b.name}`).toBe(false)
}

test('private notes: "Add your notes" puts the keyboard in the note box; Enter adds, Shift+Enter new line (A11Y2-01, R2-06)', async ({
  join,
}, testInfo) => {
  const host = await join('dave', 'editor')
  const bob = await join('bob', 'editor')
  await startBrainstorm(host.page, 'new')

  const card = bob.page.getByTestId('pn-start-prompt')
  await expect(card).toBeVisible()
  // Announced to screen readers as it appears.
  await expect(bob.page.getByTestId('pn-start-announce')).toContainText(
    `Private brainstorm started: ${PROMPT}`,
  )
  await card.getByTestId('pn-start-prompt-write').click()
  const panel = bob.page.getByTestId('pn-panel')
  const compose = panel.getByTestId('pn-compose-text')
  await expect(compose).toBeFocused()

  // Typed as a person would: every key goes into the note ("e" is the eraser, "t" the text tool).
  await bob.page.keyboard.type('Live on stage')
  await expect(compose).toHaveValue('Live on stage')
  expect(await read(bob.page, (ed) => ed.getCurrentToolId())).toBe('select')

  // The hint is on screen; Enter adds the note and the box is ready for the next one.
  await expect(panel.getByTestId('pn-compose-keys')).toBeVisible()
  await expect(panel.getByTestId('pn-compose-keys')).toContainText('Enter to add')
  await capture('workshops3-04-typed-in-composer.png', bob.page, testInfo)
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['Live on stage'])
  await expect(compose).toHaveValue('')
  await expect(compose).toBeFocused()

  // Shift+Enter is a new line; Enter then adds the two-line note.
  await bob.page.keyboard.type('Cold open')
  await bob.page.keyboard.press('Shift+Enter')
  await bob.page.keyboard.type('on the boss')
  await expect(compose).toHaveValue('Cold open\non the boss')
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveCount(2)
  expect(await read(bob.page, (ed) => ed.getCurrentToolId())).toBe('select')

  // The top-bar chip does the same once the panel is closed.
  await bob.page.getByTestId('dock-panel-close').click()
  await expect(panel).toHaveCount(0)
  await bob.page.getByTestId('pn-chip').click()
  await expect(bob.page.getByTestId('pn-compose-text')).toBeFocused()
  await bob.page.keyboard.type('Stream it')
  await expect(bob.page.getByTestId('pn-compose-text')).toHaveValue('Stream it')
  expect(await read(bob.page, (ed) => ed.getCurrentToolId())).toBe('select')
  await capture('workshops3-05-after-enter.png', bob.page, testInfo)
})

test('private notes on a phone: the panel shows the timer and "Time\'s up"; after the reveal it closes onto the notes (R2-02, R2-03)', async ({
  join,
  board,
}, testInfo) => {
  const host = await join('erin', 'editor')
  const bob = await join('bob', 'editor')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await startBrainstorm(host.page, 'new')
  await bob.page.getByTestId('pn-start-prompt-write').click()
  const panel = bob.page.getByTestId('pn-panel')
  await expect(panel.getByTestId('pn-compose-text')).toBeFocused()
  await bob.page.keyboard.type('Friendly team')
  await bob.page.keyboard.press('Enter')
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['Friendly team'])

  // A short timer while everyone writes: the panel shows it counting, then "Time's up".
  expect(
    (await post(host, `/api/boards/${board}/timer`, { action: 'start', durationMs: 4_000 })).status(),
  ).toBe(200)
  const timer = panel.getByTestId('pn-timer')
  await expect(timer).toHaveAttribute('data-state', 'running')
  await expect(timer).toBeInViewport()
  await capture('workshops3-06-phone-timer-running.png', bob.page, testInfo)
  await expect(timer).toHaveAttribute('data-state', 'finished', { timeout: 10_000 })
  await expect(timer).toContainText("Time's up")
  await expect(timer).toBeInViewport()
  await capture('workshops3-07-phone-times-up.png', bob.page, testInfo)
  // It stays until tapped (well past the canvas flash's 4 s).
  await bob.page.waitForTimeout(4_500)
  await expect(timer).toContainText("Time's up")
  await timer.click()
  await expect(timer).toHaveCount(0)
  await bob.page.waitForTimeout(600) // the countdown still ticks: it stays put away
  await expect(timer).toHaveCount(0)

  // The reveal: bob's panel gets out of the way and his camera goes to the notes.
  await host.page.getByTestId('pn-panel').getByTestId('pn-reveal').click()
  await expect(panel).toHaveCount(0, { timeout: 15_000 })
  const noteIds = async () =>
    (await read(bob.page, (ed) =>
      ed.store
        .allRecords()
        .filter((r) => !!(r as { meta?: { drPrivateNote?: unknown } }).meta?.drPrivateNote)
        .map((r) => r.id),
    )) as string[]
  await expect.poll(async () => (await noteIds()).length).toBe(1)
  const [id] = await noteIds()
  await expect
    .poll(
      async () => {
        const b = (await read(
          bob.page,
          (ed, sid) => (ed as unknown as { getShapePageBounds(id: string): BoxLike }).getShapePageBounds(sid),
          id as string,
        )) as BoxLike
        return contains(await viewport(bob.page), b)
      },
      { timeout: 5_000 },
    )
    .toBe(true)
  await capture('workshops3-08-phone-after-reveal.png', bob.page, testInfo)
  // Opening the panel again says where the notes went, not the intro (the phone rail is folded, R13).
  await bob.page.getByTestId('dock-rail-toggle').click()
  await bob.page.getByTestId('dock-tab-private-notes').click()
  await expect(bob.page.getByTestId('pn-ended')).toHaveAttribute('data-state', 'placed')
  await expect(bob.page.getByTestId('pn-ended')).toContainText('1 note')
})

test('a phone keeps a reminder of the open brainstorm, after writing and after a reload (R2-12)', async ({
  join,
}, testInfo) => {
  const host = await join('carol', 'editor')
  const bob = await join('bob', 'editor')
  await bob.page.setViewportSize({ width: 390, height: 844 })
  await startBrainstorm(host.page, 'new')
  // The start card first (no reminder on top of it)…
  await expect(bob.page.getByTestId('pn-start-prompt')).toBeVisible()
  await expect(bob.page.getByTestId('pn-reminder')).toHaveCount(0)
  await bob.page.getByTestId('pn-start-prompt-write').click()
  await bob.page.keyboard.type('Friendly team')
  await bob.page.keyboard.press('Enter')
  await expect(bob.page.getByTestId('pn-note-text')).toHaveText(['Friendly team'])
  await bob.page.getByTestId('dock-panel-close').click()
  // …then, with the panel closed, the reminder.
  const reminder = bob.page.getByTestId('pn-reminder')
  await expect(reminder).toContainText('Your notes (1)')
  await reloadBoard(bob)
  await expect(reminder).toBeVisible()
  await expect(reminder).toBeInViewport()
  await capture('workshops3-11-phone-reminder-after-reload.png', bob.page, testInfo)
  await reminder.click()
  await expect(bob.page.getByTestId('pn-compose-text')).toBeFocused()
  await expect(bob.page.getByTestId('pn-note-text')).toHaveText(['Friendly team'])
  await expect(reminder).toHaveCount(0)
})

test('+1 is not offered on notes while a dot vote is open (R2-05)', async ({ join, board }, testInfo) => {
  const alice = await join('alice', 'owner')
  await edit(alice.page, (ed) => {
    const e = ed as unknown as {
      createShape(s: unknown): unknown
      select(id: string): unknown
      zoomToBounds(b: BoxLike, o?: unknown): unknown
    }
    e.createShape({ id: 'shape:slow', type: 'note', x: 0, y: 0 })
    e.select('shape:slow')
    e.zoomToBounds({ x: -200, y: -200, w: 600, h: 600 }, { immediate: true })
  })
  const control = alice.page.locator('[data-testid="plusone"][data-shape-id="shape:slow"]')
  await expect(control).toHaveAttribute('data-active', 'true')
  const res = await post(alice, `/api/boards/${board}/votes`, {
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.status(), await res.text()).toBe(201)
  await expect(control).toHaveCount(0)
  await capture('workshops3-10-no-plusone-during-vote.png', alice.page, testInfo)
})

test("the timer: a teammate can't pause the facilitator's running timer; the owner and its starter can (R3)", async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const carol = await join('carol', 'editor')
  const timer = (s: WorkshopSession, body: unknown) => post(s, `/api/boards/${board}/timer`, body)
  expect((await timer(bob, { action: 'start', durationMs: 5 * 60_000 })).status()).toBe(200)
  await expect(carol.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')

  // Carol (another editor) sees whose timer it is, and no Pause / Stop / +1 min.
  const pop = await openWorkshopPopover(carol.page)
  await expect(pop.getByTestId('timer-held-hint')).toHaveText(
    /Bob .* is running this timer\. Only they or the board owner can pause, stop or change it\./,
  )
  for (const id of ['timer-pause', 'timer-stop', 'timer-add-1m', 'timer-start'])
    await expect(pop.getByTestId(id), id).toHaveCount(0)
  await capture('workshops3-09-teammate-timer-popover.png', carol.page, testInfo)
  const refused = await timer(carol, { action: 'pause' })
  expect(refused.status()).toBe(403)
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('TIMER_NOT_YOURS')
  await expect(bob.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')

  // Bob (who started it) and alice (the board owner) keep their controls.
  const bobPop = await openWorkshopPopover(bob.page)
  await expect(bobPop.getByTestId('timer-pause')).toBeVisible()
  const alicePop = await openWorkshopPopover(alice.page)
  await alicePop.getByTestId('timer-pause').click()
  await expect(carol.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'paused')
})
