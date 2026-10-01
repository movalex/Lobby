// OWNER: 3f. Workshops for guests and on phones on the Excalidraw board page, ported from
// tests/facilitation-polish.fix.spec.ts (R2 R3 R4 R5 R6) and tests/workshops-2.fix.spec.ts (G-R9: a long
// guest name keeps its "(guest)" marker).
//
// On this page the bottom toolbar is 3a's host slot (`[data-lobby-slot="toolbar"]`); the cards must stay
// above it where it is drawn, and on screen in any case. The presenting half of G-R9 needs 3e's present
// mode and is its own test, expected to fail until then.
import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { selection } from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import { openWorkshopPopover } from '../tests/support/workshops.ts'
import { openQueue, setHand } from '../tests/support/workshops-2.ts'
import {
  expect,
  post,
  reachableCenter,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
  waitForWorkshopBoard,
} from './workshops-kit.ts'

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const PROMPT = 'What slowed us down this sprint?'
async function ok(res: Promise<{ status(): number; text(): Promise<string> }>, status = 200) {
  const r = await res
  expect(r.status(), await r.text()).toBe(status)
  return r as unknown as { json(): Promise<unknown> }
}

async function guestLinkUrl(owner: WorkshopCanvasSession, board: string): Promise<string> {
  const r = await ok(
    post(owner, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true }),
    201,
  )
  return ((await r.json()) as { url: string }).url
}

/** A fresh browser (no account; a phone unless `options` say otherwise) that joins `url` as guest `name`. */
async function guestOn(
  browser: Browser,
  url: string,
  name: string,
  opened: BrowserContext[],
  options: Parameters<Browser['newContext']>[0] = PHONE,
) {
  const context = await browser.newContext(options)
  opened.push(context)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForWorkshopBoard(page)
  const id = (await page.getByTestId('user-menu').getAttribute('data-user-id')) ?? ''
  return { page, id }
}

async function shot(page: Page, name: string, testInfo: TestInfo) {
  await page.screenshot({ path: testInfo.outputPath(name) })
}

/** Where the board's bottom toolbar starts (3a's toolbar slot), else the bottom of the window. */
const toolbarTop = (page: Page) =>
  page.evaluate(() => {
    const slot = document.querySelector('[data-lobby-slot="toolbar"]')
    let top = window.innerHeight
    for (const el of slot ? [slot, ...slot.querySelectorAll('*')] : []) {
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

/**
 * W5-07: nothing lies over a card (the phone sheet's "Board actions" button, the tool dock, a bar): a tap
 * anywhere on it reaches it. Probes a grid over the card (its top, middle and bottom rows, inside the
 * border and clear of the rounded corners) and each of its buttons (left, middle and right). Lists what is
 * in the way instead.
 */
async function expectNothingOver(loc: Locator) {
  await expect(loc).toBeVisible()
  const covered = await loc.evaluate((card) => {
    const out: string[] = []
    const probe = (x: number, y: number, what: string) => {
      const el = document.elementFromPoint(x, y)
      if (el && card.contains(el)) return
      const name = el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` : 'nothing'
      out.push(`${what} (${Math.round(x)}, ${Math.round(y)}): ${name}`)
    }
    const r = card.getBoundingClientRect()
    const side = 12 // clear of the card's rounded corners
    const edge = 4 // inside its border
    for (const [y, row] of [
      [r.top + edge, 'top'],
      [(r.top + r.bottom) / 2, 'middle'],
      [r.bottom - edge, 'bottom'],
    ] as const)
      for (let i = 0; i <= 6; i++) probe(r.left + side + ((r.width - 2 * side) * i) / 6, y, `${row} ${i}/6`)
    for (const b of card.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')) {
      const q = b.getBoundingClientRect()
      if (!q.width || !q.height) continue
      const label = (b.textContent?.trim() || b.getAttribute('aria-label') || b.tagName).slice(0, 30)
      for (const [f, side] of [
        [0.15, 'left'],
        [0.5, 'middle'],
        [0.85, 'right'],
      ] as const)
        probe(q.left + q.width * f, q.top + q.height / 2, `"${label}" ${side}`)
    }
    return out
  })
  expect(covered, 'taps that miss the card').toEqual([])
}

async function sessionId(s: WorkshopCanvasSession, board: string): Promise<string> {
  const r = await s.api.fetch('GET', `/api/boards/${board}/private-brainstorm`)
  return ((await r.json()) as { session: { id: string } }).session.id
}

test('R2 R3 R4 R5 R6 W5-07: guests take part but never facilitate; a brainstorm asks everyone to write; phones keep the timer, the menu and the vote cards on screen, with nothing over the cards', async ({
  browser,
  board,
  join,
}, testInfo) => {
  const opened: BrowserContext[] = []
  try {
    const alice = await join('alice')
    const bob = await join('bob', 'editor')
    await seed(alice.page, {
      frames: [{ id: 'fp-frame', x: 0, y: 0, w: 1120, h: 720, name: 'Ideas' }],
      notes: Array.from({ length: 3 }, (_, i) => ({ id: `fp-n${i}`, x: 1300 + i * 240, y: 0 })),
    })
    const { page: guest } = await guestOn(browser, await guestLinkUrl(alice, board), 'Kai', opened)

    await test.step('R3: the guest’s workshop tools have no facilitator controls; the API refuses them too', async () => {
      await guest.getByTestId('topbar-overflow').click()
      await guest.getByTestId('timer-pill').click()
      const pop = guest.getByTestId('workshop-popover')
      await expect(pop).toBeVisible()
      for (const id of ['timer-start', 'vote-start', 'pn-start', 'summon-button'])
        await expect(pop.getByTestId(id), id).toHaveCount(0)
      await shot(guest, 'lc-r3-guest-phone-tools.png', testInfo)
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
      await guest.keyboard.press('Escape')
      await expect(guest.getByTestId('topbar-overflow-panel')).toHaveAttribute('data-open', 'false')
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
          target: { frameId: 'shape:fp-frame', pageId: 'page:page', x: 0, y: 0, w: 1120, h: 720 },
        }),
        201,
      )
      const card = bob.page.getByTestId('pn-start-prompt')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('pn-start-prompt-text')).toHaveText(PROMPT)
      await expect(bob.page.getByTestId('pn-chip-counts')).toHaveText('Add your notes')
      await shot(bob.page, 'lc-r4-bob-desktop-brainstorm-started.png', testInfo)
      await expect(alice.page.getByTestId('pn-chip-counts')).toHaveText('Waiting for notes')
      await expect(alice.page.getByTestId('pn-start-prompt')).toHaveCount(0)
      await card.getByTestId('pn-start-prompt-write').click()
      await expect(bob.page.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
      await expect(bob.page.getByTestId('pn-compose-text')).toBeVisible()
      await expect(card).toHaveCount(0)

      const phoneCard = guest.getByTestId('pn-start-prompt')
      await expectOnScreenAboveToolbars(guest, phoneCard)
      await expectNothingOver(phoneCard)
      await expect(phoneCard.getByTestId('pn-start-prompt-text')).toHaveText(PROMPT)
      const timer = guest.getByTestId('timer-floating')
      await expect(timer).toBeVisible()
      await expect(timer).toHaveAttribute('data-state', 'running')
      await expect(timer).toContainText(/^\s*[45]:\d\d/)
      await shot(guest, 'lc-r2-guest-phone-brainstorm-started.png', testInfo)
      await phoneCard.getByTestId('pn-start-prompt-write').click()
      await expect(guest.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
      await guest.getByTestId('pn-compose-text').fill('Too many meetings mid-sprint')
      await guest.getByTestId('pn-add').click()
      await expect(guest.getByTestId('pn-note-text')).toHaveText('Too many meetings mid-sprint')
      await shot(guest, 'lc-r2-guest-phone-writing.png', testInfo)
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
      await shot(guest, 'lc-r5-guest-phone-overflow.png', testInfo)
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
      const joinCard = guest.getByTestId('vote-join-prompt')
      await expectOnScreenAboveToolbars(guest, joinCard)
      await expectNothingOver(joinCard)
      await expect(joinCard.getByTestId('vote-touch-hint')).toBeVisible()
      await expect(joinCard.getByTestId('vote-keys-hint')).toBeHidden()
      await shot(guest, 'lc-r6-guest-phone-vote-join.png', testInfo)
      await joinCard.getByTestId('vote-join').click()
      const bar = guest.getByTestId('vote-bar')
      await expectOnScreenAboveToolbars(guest, bar)
      await expectOnScreenAboveToolbars(guest, bar.getByTestId('vote-done'))
      await expectNothingOver(bar)
      // A tap on a note votes (touch), and selects nothing.
      await showAll(guest)
      const tapAt = await reachableCenter(guest, 'fp-n0')
      await guest.touchscreen.tap(tapAt.x, tapAt.y)
      await expect(guest.getByTestId('vote-remaining')).toHaveAttribute('data-remaining', '2')
      await expect(guest.locator('[data-testid="vote-dot"][data-shape-id="shape:fp-n0"]')).toHaveAttribute(
        'data-count',
        '1',
      )
      expect(await selection(guest)).toEqual([])
      await shot(guest, 'lc-r6-guest-phone-voting.png', testInfo)
      await ok(post(alice, `/api/votes/${vid}/reveal`))
      const results = guest.getByTestId('vote-results-card')
      await expectOnScreenAboveToolbars(guest, results)
      await expectOnScreenAboveToolbars(guest, results.getByTestId('vote-results-card-all'))
      await expectNothingOver(results)
      await shot(guest, 'lc-r6-guest-phone-results.png', testInfo)
    })
  } finally {
    for (const c of opened) await c.close()
  }
})

// ---- G-R9: a long guest name keeps its "(guest)" marker (workshops-2.fix) ----------------------------------

const LONG_GUEST = 'Maximiliana Featherstonehaugh-Lindqvist'

function nameFit(scope: Locator) {
  return scope.evaluate((root) => {
    const marker = root.querySelector('[data-testid="guest-marker"]')
    const name = root.querySelector('.dr-wk-person__name')
    if (!marker || !name) return { marker: null, visible: false, cut: false }
    const m = marker.getBoundingClientRect()
    let visible = m.width > 0
    for (let a = marker.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const r = a.getBoundingClientRect()
      if (m.left < r.left - 0.5 || m.right > r.right + 0.5) visible = false
    }
    return { marker: marker.textContent, visible, cut: name.scrollWidth > name.clientWidth + 1 }
  })
}

test('raised hands: a long guest name is cut, never its "(guest)" marker (queue, phone, dark)', async ({
  join,
  browser,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const contexts: BrowserContext[] = []
  try {
    const guest = await guestOn(browser, await guestLinkUrl(alice, board), LONG_GUEST, contexts, {
      viewport: { width: 1280, height: 820 },
    })
    await setHand(guest.page, true)

    const queue = await openQueue(alice.page)
    const row = queue.locator(`[data-testid="hand-row"][data-user-id="${guest.id}"]`)
    await expect(row).toHaveCount(1)
    await capture('lc-hands-queue-long-guest-light.png', alice.page, testInfo)
    await alice.page.emulateMedia({ colorScheme: 'dark' })
    await capture('lc-hands-queue-long-guest-dark.png', alice.page, testInfo)
    await expect(row.locator('.dr-wk-hands__name')).toHaveAttribute('title', `${LONG_GUEST} (guest)`)
    expect(await nameFit(row)).toEqual({ marker: ' (guest)', visible: true, cut: true })
    await alice.page.emulateMedia({ colorScheme: 'light' })
    expect(await nameFit(row)).toMatchObject({ marker: ' (guest)', visible: true })
    await alice.page.emulateMedia({ colorScheme: 'dark' })
    await alice.page.keyboard.press('Escape')

    // A phone: the tools are in the "⋯" menu, the queue still shows the marker.
    await alice.page.setViewportSize({ width: 390, height: 844 })
    await alice.page.getByTestId('topbar-overflow').click()
    await alice.page.getByTestId('timer-pill').click()
    const phoneRow = alice.page.locator(`[data-testid="hand-row"][data-user-id="${guest.id}"]`)
    await expect(phoneRow).toBeVisible()
    await capture('lc-hands-queue-long-guest-phone-dark.png', alice.page, testInfo)
    expect(await nameFit(phoneRow)).toMatchObject({ marker: ' (guest)', visible: true })
    const popBox = await alice.page.getByTestId('workshop-popover').boundingBox()
    expect(popBox && popBox.x >= 0 && popBox.x + popBox.width <= 390, JSON.stringify(popBox)).toBe(true)
    expect(await alice.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await alice.page.keyboard.press('Escape')
  } finally {
    for (const c of contexts) await c.close()
  }
})

test('raised hands: presenting, the chip in the corner of the slides names who is waiting, marker included (3e present mode)', async ({
  join,
  browser,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const contexts: BrowserContext[] = []
  try {
    await seed(alice.page, { frames: [{ id: 'slide', x: 0, y: 0, w: 800, h: 500, name: 'Slide' }] })
    const guest = await guestOn(browser, await guestLinkUrl(alice, board), LONG_GUEST, contexts, {
      viewport: { width: 1280, height: 820 },
    })
    await setHand(guest.page, true)
    await alice.page.getByTestId('present-button').click({ timeout: 5_000 })
    const floating = alice.page.getByTestId('hands-floating')
    await expect(floating).toBeVisible()
    expect(await nameFit(floating)).toMatchObject({ marker: ' (guest)', visible: true })
    await alice.page.keyboard.press('Escape')
  } finally {
    for (const c of contexts) await c.close()
  }
})
