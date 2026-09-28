// Facilitation fixes from the final demo review, driven through the real UI:
//   R1: a reveal keeps the target frame's width and never runs into the frame beside it;
//   R3: facilitator controls are for editors with an account: a name-only guest only takes part;
//   R2/R4: when a brainstorm starts, everyone who can write (desktop and phone) is asked to add their
//     notes, and a running timer floats on phones (the pill is in the "⋯" menu there);
//   R5: the "⋯" menu with the brainstorm chip stays on a 390 px screen;
//   R6: the vote join card, the voting bar and the results card stay above tldraw's phone toolbars.
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { edit, read, waitForBoard } from './support/board.ts'
import { expect, openWorkshopPopover, test, type WorkshopSession } from './support/workshops.ts'

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const PROMPT = 'What slowed us down this sprint?'

const post = (s: WorkshopSession, path: string, body?: unknown) => s.api.fetch('POST', path, body ?? {})

async function ok(res: Promise<{ status(): number; text(): Promise<string> }>, status = 200) {
  const r = await res
  expect(r.status(), await r.text()).toBe(status)
  return r as unknown as { json(): Promise<unknown> }
}

async function guestLinkUrl(owner: WorkshopSession, board: string): Promise<string> {
  const r = await ok(
    post(owner, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true }),
    201,
  )
  return ((await r.json()) as { url: string }).url
}

/** A fresh phone (no account) that joins `url` as a guest called `name`. */
async function phoneGuest(browser: Browser, url: string, name: string, opened: BrowserContext[]) {
  const context = await browser.newContext(PHONE)
  opened.push(context)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  await expect(page.getByTestId('timer-pill')).toHaveAttribute('data-state', /.+/)
  return page
}

async function shot(page: Page, name: string, testInfo: TestInfo) {
  await page.screenshot({ path: testInfo.outputPath(name) })
}

/** Where tldraw's bottom UI (on phones: the undo row above the tools) starts, in viewport px. */
const toolbarTop = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('.tlui-layout__bottom')
    let top = Number.POSITIVE_INFINITY
    for (const el of root ? [root, ...root.querySelectorAll('*')] : []) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
        top = Math.min(top, r.top)
    }
    return top
  })

async function expectOnScreenAboveToolbars(page: Page, loc: Locator) {
  await expect(loc).toBeVisible()
  const b = (await loc.boundingBox()) as { x: number; y: number; width: number; height: number }
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(PHONE.viewport.width)
  expect(b.y + b.height).toBeLessThanOrEqual((await toolbarTop(page)) - 4)
}

test('R2 R3 R4 R5 R6: guests take part but never facilitate; a brainstorm asks everyone to write; phones keep the timer, the menu and the vote cards on screen', async ({
  browser,
  board,
  join,
}, testInfo) => {
  const opened: BrowserContext[] = []
  const alice = await join('alice')
  const bob = await join('bob', 'editor')
  const pageId = await read(alice.page, (ed) =>
    (ed as unknown as { getCurrentPageId(): string }).getCurrentPageId(),
  )
  await edit(alice.page, (ed) => {
    ed.createShape({
      id: 'shape:fp-frame',
      type: 'frame',
      x: 0,
      y: 0,
      props: { w: 1120, h: 720, name: 'Ideas' },
    })
    for (let i = 0; i < 3; i++)
      ed.createShape({ id: `shape:fp-n${i}`, type: 'note', x: 1300 + i * 240, y: 0, props: {} })
  })
  const guest = await phoneGuest(browser, await guestLinkUrl(alice, board), 'Kai', opened)

  await test.step('R3: the guest’s workshop tools have no facilitator controls; the API refuses them too', async () => {
    await guest.getByTestId('topbar-overflow').click()
    await guest.getByTestId('timer-pill').click()
    const pop = guest.getByTestId('workshop-popover')
    await expect(pop).toBeVisible()
    for (const id of ['timer-start', 'vote-start', 'pn-start', 'summon-button'])
      await expect(pop.getByTestId(id), id).toHaveCount(0)
    await shot(guest, 'r3-guest-phone-tools.png', testInfo)
    const refused = await guest.evaluate(
      async (b) =>
        (
          await fetch(`/api/boards/${b}/timer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'start', durationMs: 60_000 }),
          })
        ).status,
      board,
    )
    expect(refused).toBe(403)
    await guest.keyboard.press('Escape')
    await expect(pop).toHaveCount(0)
    // …and the "⋯" menu it was opened from.
    await guest.keyboard.press('Escape')
    await expect(guest.getByTestId('topbar-overflow-panel')).toHaveAttribute('data-open', 'false')
    // An account editor has them.
    const bobPop = await openWorkshopPopover(bob.page)
    await expect(bobPop.getByTestId('pn-start')).toBeVisible()
    await bob.page.keyboard.press('Escape')
  })

  await test.step('R2/R4: alice starts a timer and a brainstorm; bob and the phone guest are asked to write', async () => {
    await ok(post(alice, `/api/boards/${board}/timer`, { action: 'start', durationMs: 5 * 60_000 }))
    await ok(
      post(alice, `/api/boards/${board}/private-brainstorm`, {
        prompt: PROMPT,
        anonymous: false,
        target: { frameId: 'shape:fp-frame', pageId, x: 0, y: 0, w: 1120, h: 720 },
      }),
      201,
    )
    // Desktop: the card with the prompt, and a chip that asks rather than "Waiting for notes".
    const card = bob.page.getByTestId('pn-start-prompt')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('pn-start-prompt-text')).toHaveText(PROMPT)
    await expect(bob.page.getByTestId('pn-chip-counts')).toHaveText('Add your notes')
    await shot(bob.page, 'r4-bob-desktop-brainstorm-started.png', testInfo)
    // The starter is not asked; her chip keeps the counts.
    await expect(alice.page.getByTestId('pn-chip-counts')).toHaveText('Waiting for notes')
    await expect(alice.page.getByTestId('pn-start-prompt')).toHaveCount(0)
    await card.getByTestId('pn-start-prompt-write').click()
    await expect(bob.page.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
    await expect(bob.page.getByTestId('pn-compose-text')).toBeVisible()
    await expect(card).toHaveCount(0)

    // Phone: the same card above the toolbars, and the running timer on the canvas.
    const phoneCard = guest.getByTestId('pn-start-prompt')
    await expectOnScreenAboveToolbars(guest, phoneCard)
    await expect(phoneCard.getByTestId('pn-start-prompt-text')).toHaveText(PROMPT)
    const timer = guest.getByTestId('timer-floating')
    await expect(timer).toBeVisible()
    await expect(timer).toHaveAttribute('data-state', 'running')
    await expect(timer).toContainText(/^\s*[45]:\d\d/)
    await shot(guest, 'r2-guest-phone-brainstorm-started.png', testInfo)
    await phoneCard.getByTestId('pn-start-prompt-write').click()
    await expect(guest.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
    await guest.getByTestId('pn-compose-text').fill('Too many meetings mid-sprint')
    await guest.getByTestId('pn-add').click()
    await expect(guest.getByTestId('pn-note-text')).toHaveText('Too many meetings mid-sprint')
    await shot(guest, 'r2-guest-phone-writing.png', testInfo)
    await guest.getByRole('button', { name: 'Close Private notes' }).click()
    await expect(guest.getByTestId('pn-panel')).toHaveCount(0)
  })

  await test.step('R5: the "⋯" menu with the brainstorm chip stays on the 390 px screen', async () => {
    await guest.getByTestId('topbar-overflow').click()
    const panel = guest.getByTestId('topbar-overflow-panel')
    await expect(panel).toHaveAttribute('data-open', 'true')
    await expect(panel.getByTestId('pn-chip')).toBeVisible()
    const b = (await panel.boundingBox()) as { x: number; width: number }
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    for (const id of ['timer-pill', 'pn-chip']) {
      const c = (await panel.getByTestId(id).boundingBox()) as { x: number; width: number }
      expect(c.x, id).toBeGreaterThanOrEqual(b.x)
      expect(c.x + c.width, id).toBeLessThanOrEqual(b.x + b.width)
    }
    await shot(guest, 'r5-guest-phone-overflow.png', testInfo)
    await guest.keyboard.press('Escape')
    await expect(panel).toHaveAttribute('data-open', 'false')
  })

  await test.step('R6: the vote join card, the voting bar and the results card stay above the toolbars', async () => {
    await ok(post(alice, `/api/private-brainstorms/${await sessionId(alice, board)}/cancel`))
    const started = await ok(
      post(alice, `/api/boards/${board}/votes`, { votesPerPerson: 3, onePerObject: false, scope: 'board' }),
      201,
    )
    const vid = ((await started.json()) as { session: { id: string } }).session.id
    const join = guest.getByTestId('vote-join-prompt')
    await expectOnScreenAboveToolbars(guest, join)
    await expect(join.getByTestId('vote-touch-hint')).toBeVisible()
    await expect(join.getByTestId('vote-keys-hint')).toBeHidden()
    await shot(guest, 'r6-guest-phone-vote-join.png', testInfo)
    await join.getByTestId('vote-join').click()
    const bar = guest.getByTestId('vote-bar')
    await expectOnScreenAboveToolbars(guest, bar)
    await expectOnScreenAboveToolbars(guest, bar.getByTestId('vote-done'))
    await shot(guest, 'r6-guest-phone-voting.png', testInfo)
    await ok(post(alice, `/api/votes/${vid}/reveal`))
    const results = guest.getByTestId('vote-results-card')
    await expectOnScreenAboveToolbars(guest, results)
    await expectOnScreenAboveToolbars(guest, results.getByTestId('vote-results-card-all'))
    await shot(guest, 'r6-guest-phone-results.png', testInfo)
  })

  for (const c of opened) await c.close()
})

async function sessionId(s: WorkshopSession, board: string): Promise<string> {
  const r = await s.api.fetch('GET', `/api/boards/${board}/private-brainstorm`)
  return ((await r.json()) as { session: { id: string } }).session.id
}

test('R1: 16 notes revealed into a retro column keep its width and never reach the frame beside it', async ({
  board,
  join,
}, testInfo) => {
  const alice = await join('alice')
  const bob = await join('bob', 'editor')
  const pageId = await read(alice.page, (ed) =>
    (ed as unknown as { getCurrentPageId(): string }).getCurrentPageId(),
  )
  // The Retrospective's columns: 800 x 960, 80 apart, with three prompt notes at the top.
  await edit(alice.page, (ed) => {
    for (const [i, name] of ['2 · What went well', '3 · What to improve', '4 · Actions'].entries())
      ed.createShape({
        id: `shape:fp-col${i}`,
        type: 'frame',
        x: i * 880,
        y: 0,
        props: { w: 800, h: 960, name },
      })
    for (let i = 0; i < 3; i++)
      ed.createShape({
        id: `shape:fp-prompt${i}`,
        type: 'note',
        parentId: 'shape:fp-col1',
        x: 40 + i * 180,
        y: 120,
        props: { color: 'orange', scale: 0.75 },
      })
  })
  // The server has the board once another client sees it (the reveal lays out what the server holds).
  await expect.poll(() => read(bob.page, (ed) => !!ed.getShape('shape:fp-prompt2'))).toBe(true)
  const target = { frameId: 'shape:fp-col1', pageId, x: 880, y: 0, w: 800, h: 960 }
  await ok(
    post(alice, `/api/boards/${board}/private-brainstorm`, { prompt: PROMPT, anonymous: true, target }),
    201,
  )
  const sid = await sessionId(alice, board)
  for (let i = 0; i < 16; i++)
    await ok(
      post(i % 2 ? bob : alice, `/api/private-brainstorms/${sid}/notes`, {
        text: `Friction ${i}`,
        color: 'yellow',
      }),
      201,
    )
  await ok(post(alice, `/api/private-brainstorms/${sid}/reveal`))

  const layout = () =>
    read(alice.page, (ed) => {
      const frames = ['shape:fp-col0', 'shape:fp-col1', 'shape:fp-col2'].map((id) => {
        const s = ed.getShape(id) as unknown as { x: number; y: number; props: { w: number; h: number } }
        return { id, x: s.x, y: s.y, w: s.props.w, h: s.props.h }
      })
      const notes = ed
        .getCurrentPageShapes()
        .filter((s) => (s.meta as { drPrivateNote?: unknown }).drPrivateNote)
        .map((s) => ({ parentId: s.parentId, x: s.x, y: s.y }))
      return { frames, notes }
    })
  await expect.poll(async () => (await layout()).notes.length).toBe(16)
  const { frames, notes } = await layout()
  const [left, mid, right] = frames as [(typeof frames)[0], (typeof frames)[0], (typeof frames)[0]]
  expect(mid).toMatchObject({ x: 880, y: 0, w: 800 })
  expect(mid.h).toBeGreaterThan(960)
  expect(left).toMatchObject({ x: 0, w: 800, h: 960 })
  expect(right).toMatchObject({ x: 1760, w: 800, h: 960 })
  // No frame reaches another; every note is inside the column.
  expect(mid.x + mid.w).toBeLessThanOrEqual(right.x)
  expect(left.x + left.w).toBeLessThanOrEqual(mid.x)
  for (const n of notes) {
    expect(n.parentId).toBe('shape:fp-col1')
    expect(n.x).toBeGreaterThanOrEqual(0)
    expect(n.x + 200).toBeLessThanOrEqual(800)
  }
  await edit(alice.page, (ed) => ed.zoomToFit())
  await alice.page.waitForTimeout(400)
  await shot(alice.page, 'r1-retro-after-reveal.png', testInfo)
})
