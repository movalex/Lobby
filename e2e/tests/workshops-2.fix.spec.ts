// Workshop follow-ups after the round-2 review (key workshops-2), driven through the real UI:
// - G-R9: a long guest name is cut in the raised-hands queue and the presenting hands chip, never
//   its "(guest)" marker;
// - F3: vote result badges shrink and group when zoomed out, and stay under the top bar's popovers;
// - F5: a reveal into the Lobby tour's full Brainstorm frame lands in its empty space (the frame keeps
//   its size) and the revealing person's camera goes to the notes;
// - F6: the private-notes composer keeps what was typed while the previous note was saving;
// - SEAM-07: a brainstorm whose starter left the board can be ended by the board's other editors, and
//   a removed guest's draft never reaches the board;
// - export-control UI gates: History's Duplicate / Restore as new / Export .json and the vote
//   results' Export CSV are turned off, with the reason, for limited viewers, live;
// - F17 wording: "Waiting for votes", "3 notes from 2 people", lines of a note joined with " · ".
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { edit, read, shapeBounds, waitForBoard } from './support/board.ts'
import type { BoxLike } from './support/editor.ts'
import { openHistory } from './support/history.ts'
import { capture } from './support/screenshots.ts'
import {
  closeWorkshopPopover,
  expect,
  openWorkshopPopover,
  test,
  type WorkshopSession,
  workshopState,
} from './support/workshops.ts'
import { openQueue, setHand } from './support/workshops-2.ts'

const OFF_TEXT = 'The board owner turned off exporting for viewers.'
const LONG_GUEST = 'Maximiliana Featherstonehaugh-Lindqvist'

// ---- helpers -------------------------------------------------------------------------------------

const post = (s: WorkshopSession, path: string, body?: unknown) => s.api.fetch('POST', path, body ?? {})

/** A workshop (editor) or review link that lets people join with just a name. */
async function guestLinkUrl(owner: WorkshopSession, board: string): Promise<string> {
  const res = await post(owner, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { url: string }).url
}

interface Guest {
  context: BrowserContext
  page: Page
  id: string
}

/** A fresh browser (no account) that joins `url` as a guest called `name`. */
async function joinAsGuest(browser: Browser, url: string, name: string, opened: BrowserContext[]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  opened.push(context)
  const page = await context.newPage()
  await page.goto(url)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  await expect(page.getByTestId('timer-pill')).toHaveAttribute('data-state', /.+/)
  const id = (await page.getByTestId('user-menu').getAttribute('data-user-id')) ?? ''
  expect(id).toMatch(/^usr_/)
  return { context, page, id } satisfies Guest
}

/**
 * Where a person's name is shown in `scope`: whether its "(guest)" marker is there and fully inside
 * every box that clips it, and whether the name itself was cut (so the case is a real one).
 */
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

type Cam = {
  setCamera(c: { x: number; y: number; z: number }): unknown
  getViewportScreenBounds(): BoxLike
  getViewportPageBounds(): BoxLike
  getZoomLevel(): number
  zoomToBounds(b: BoxLike, o?: unknown): unknown
}

/** Puts page point `p` at client point `at` with zoom `z` (no animation). */
async function pinPoint(page: Page, p: { x: number; y: number }, at: { x: number; y: number }, z: number) {
  await edit(
    page,
    (ed, a) => {
      const c = ed as unknown as Cam
      const vsb = c.getViewportScreenBounds()
      c.setCamera({ x: (a.at.x - vsb.x) / a.z - a.p.x, y: (a.at.y - vsb.y) / a.z - a.p.y, z: a.z })
    },
    { p, at, z },
  )
}

const viewport = (page: Page) =>
  read(page, (ed) => (ed as unknown as Cam).getViewportPageBounds()) as Promise<BoxLike>

const contains = (outer: BoxLike, inner: BoxLike) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.w <= outer.x + outer.w + 0.5 &&
  inner.y + inner.h <= outer.y + outer.h + 0.5

const overlap = (a: BoxLike, b: BoxLike) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

async function openVotingPanel(page: Page) {
  const panel = page.getByTestId('dock-panel-voting')
  if (!(await panel.isVisible())) {
    // On a phone the rail is folded behind one button (R13).
    const toggle = page.getByTestId('dock-rail-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await page.getByTestId('dock-tab-voting').click()
  }
  await expect(panel).toBeVisible()
  return panel
}

async function openPrivatePanel(page: Page) {
  const panel = page.getByTestId('pn-panel')
  if (!(await panel.isVisible())) {
    // On a phone the rail is folded behind one button (R13).
    const toggle = page.getByTestId('dock-rail-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await page.getByTestId('dock-tab-private-notes').click()
  }
  await expect(panel).toBeVisible()
  return panel
}

/** Starts a private brainstorm from the workshop tools (the selected frame, or a new one). */
async function startBrainstorm(page: Page, target: 'new' | 'selected', anonymous = false) {
  const pop = await openWorkshopPopover(page)
  await pop.getByTestId('pn-start').click()
  const dialog = page.getByTestId('pn-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('pn-prompt-input').fill('What would make the trailer unmissable?')
  await dialog.getByTestId(target === 'new' ? 'pn-target-new' : 'pn-target-selected').check()
  const anon = dialog.getByTestId('pn-anonymous')
  if ((await anon.isChecked()) !== anonymous) await anon.click()
  await dialog.getByTestId('pn-setup-submit').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('pn-panel')).toHaveAttribute('data-state', 'open')
}

async function writeNote(page: Page, text: string) {
  const panel = await openPrivatePanel(page)
  await panel.getByTestId('pn-compose-text').fill(text)
  await panel.getByTestId('pn-add').click()
  await expect(panel.getByTestId('pn-note-text').filter({ hasText: text })).toBeVisible()
}

/** Notes a private brainstorm placed, as this page's store holds them. */
const placedNotes = (page: Page) =>
  read(page, (ed) =>
    ed.store
      .allRecords()
      .filter(
        (r) =>
          r.typeName === 'shape' &&
          (r as { type?: string }).type === 'note' &&
          !!(r as { meta?: { drPrivateNote?: unknown } }).meta?.drPrivateNote,
      )
      .map((r) => ({ id: r.id, parentId: (r as unknown as { parentId: string }).parentId })),
  )

// ---- G-R9 -------------------------------------------------------------------------------------------

test('raised hands: a long guest name is cut, never its "(guest)" marker (queue, presenting chip, phone, dark)', async ({
  join,
  browser,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const contexts: BrowserContext[] = []
  try {
    // Something to present.
    await edit(alice.page, (ed) =>
      ed.createShape({
        id: 'shape:slide',
        type: 'frame',
        x: 0,
        y: 0,
        props: { w: 800, h: 500, name: 'Slide' },
      }),
    )
    const guest = await joinAsGuest(browser, await guestLinkUrl(alice, board), LONG_GUEST, contexts)
    await setHand(guest.page, true)

    const queue = await openQueue(alice.page)
    const row = queue.locator(`[data-testid="hand-row"][data-user-id="${guest.id}"]`)
    await expect(row).toHaveCount(1)
    await capture('hands-queue-long-guest-light.png', alice.page, testInfo)
    await alice.page.emulateMedia({ colorScheme: 'dark' })
    await capture('hands-queue-long-guest-dark.png', alice.page, testInfo)
    // The full name is one hover away.
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
    await capture('hands-queue-long-guest-phone-dark.png', alice.page, testInfo)
    expect(await nameFit(phoneRow)).toMatchObject({ marker: ' (guest)', visible: true })
    // The workshop tools open on the screen, not past its left edge.
    const popBox = await alice.page.getByTestId('workshop-popover').boundingBox()
    expect(popBox && popBox.x >= 0 && popBox.x + popBox.width <= 390, JSON.stringify(popBox)).toBe(true)
    expect(await alice.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await alice.page.keyboard.press('Escape')
    await alice.page.emulateMedia({ colorScheme: 'light' })
    await alice.page.setViewportSize({ width: 1280, height: 720 })

    // Presenting: the chip in the corner of the slides names who is waiting, marker included.
    await alice.page.getByTestId('present-button').click()
    const floating = alice.page.getByTestId('hands-floating')
    await expect(floating).toBeVisible()
    await capture('hands-presenting-long-guest.png', alice.page, testInfo)
    expect(await nameFit(floating)).toMatchObject({ marker: ' (guest)', visible: true })
    await alice.page.keyboard.press('Escape')
  } finally {
    for (const c of contexts) await c.close()
  }
})

// ---- F3 + F17 (votes) ---------------------------------------------------------------------------------

const NOTES = Array.from({ length: 8 }, (_, i) => `shape:vote${i}`)

test('vote results: badges shrink and group when zoomed out, stay under the workshop popover, and read well', async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const a = alice.page
  await edit(
    a,
    (ed, ids) => {
      ed.createShape({
        id: 'shape:retro',
        type: 'frame',
        x: 0,
        y: 0,
        props: { w: 1000, h: 560, name: 'Retro' },
      })
      ed.createShapes(
        ids.map((id, i) => ({
          id,
          type: 'note',
          parentId: 'shape:retro',
          x: 40 + (i % 4) * 224,
          y: 40 + Math.floor(i / 4) * 240,
          props: {
            richText: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: `Idea ${i}` }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Owner: producer' }] },
              ],
            },
          },
        })),
      )
    },
    NOTES,
  )
  await expect.poll(() => read(bob.page, (ed, id) => !!ed.getShape(id), NOTES[7])).toBe(true)

  const created = await post(alice, `/api/boards/${board}/votes`, {
    votesPerPerson: 5,
    onePerObject: false,
    scope: 'board',
  })
  expect(created.status(), await created.text()).toBe(201)
  const sid = (await workshopState(alice.api, board)).vote?.session.id ?? ''

  await test.step('F17: before anyone votes, the facilitator reads "Waiting for votes"', async () => {
    const panel = await openVotingPanel(a)
    await expect.soft(panel.getByTestId('vote-progress')).toHaveText('Waiting for votes')
  })

  for (const [s, picks] of [
    [alice, [0, 0, 1, 2, 3]],
    [bob, [0, 4, 5, 6, 7]],
  ] as const) {
    for (const i of picks) {
      const res = await post(s, `/api/votes/${sid}/cast`, { shapeId: NOTES[i], delta: 1 })
      expect(res.status(), await res.text()).toBe(200)
    }
  }
  expect((await post(alice, `/api/votes/${sid}/reveal`)).status()).toBe(200)
  const singles = a.locator('.dr-wk-badge[data-testid="vote-count"]')
  await expect(singles).toHaveCount(8)

  await test.step('F17: a note’s lines are joined with " · " in the ranking', async () => {
    const panel = await openVotingPanel(a)
    const first = panel.getByTestId('vote-results').getByTestId('vote-result-row').first()
    await expect.soft(first).toContainText('Idea 0 · Owner: producer')
    await a.getByTestId('dock-tab-voting').click() // close the panel: the whole canvas is free
  })

  await test.step('F3: at 100% every badge is full size and on its own', async () => {
    await pinPoint(a, { x: 0, y: 0 }, { x: 80, y: 120 }, 1)
    await expect(a.getByTestId('vote-count-group')).toHaveCount(0)
    const h = await singles.first().evaluate((el) => el.getBoundingClientRect().height)
    expect(h).toBeCloseTo(28, 0)
  })

  await test.step('F3: under the workshop popover, the popover wins', async () => {
    const card = a.getByTestId('vote-results-card')
    await expect(card).toBeVisible() // "Results are in" (30 s after the reveal)
    const pop = await openWorkshopPopover(a)
    const box = await pop.boundingBox()
    if (!box) throw new Error('no popover box')
    // Bring note 0's corner (where its badge sits) into the middle of the popover.
    const note = (await shapeBounds(a, NOTES[0] as string)) as BoxLike
    await pinPoint(a, { x: note.x + note.w, y: note.y }, { x: box.x + box.width / 2, y: box.y + 140 }, 1)
    await capture('vote-badges-under-popover.png', a, testInfo)
    // Where the results card and the popover overlap, the popover is on top.
    const cb = await card.boundingBox()
    if (cb) {
      const x0 = Math.max(cb.x, box.x)
      const y0 = Math.max(cb.y, box.y)
      const x1 = Math.min(cb.x + cb.width, box.x + box.width)
      const y1 = Math.min(cb.y + cb.height, box.y + box.height)
      if (x1 > x0 && y1 > y0) {
        const top = await a.evaluate(
          ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="workshop-popover"]'),
          { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
        )
        expect.soft(top, 'the popover is above the results card').toBe(true)
      }
    }
    const badge = a.locator(`.dr-wk-badge[data-shape-id="${NOTES[0]}"]`)
    await expect(badge).toHaveCount(1)
    const b = await badge.boundingBox()
    if (!b) throw new Error('no badge box')
    const on = await a.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y)
        return {
          inPopover: !!el?.closest('[data-testid="workshop-popover"]'),
          badge: !!el?.closest('.dr-wk-badge'),
        }
      },
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    )
    expect(on).toEqual({ inPopover: true, badge: false })
    await a.keyboard.press('Escape')
  })

  await test.step('F3: zoomed out, badges shrink and group so none overlaps another', async () => {
    await pinPoint(a, { x: 0, y: 0 }, { x: 300, y: 300 }, 0.12)
    await expect(a.locator('.dr-wk-badge').first()).toBeVisible()
    await capture('vote-badges-zoomed-out.png', a, testInfo)
    await a.emulateMedia({ colorScheme: 'dark' })
    await capture('vote-badges-zoomed-out-dark.png', a, testInfo)
    await a.emulateMedia({ colorScheme: 'light' })
    const groups = a.getByTestId('vote-count-group')
    await expect(groups.first()).toBeVisible()
    const boxes = await a
      .locator('.dr-wk-badge')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    for (const r of boxes) expect(r.height).toBeLessThanOrEqual(28 * 0.6 + 1)
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [p, q] = [boxes[i] as DOMRect, boxes[j] as DOMRect]
        expect(
          overlap({ x: p.x, y: p.y, w: p.width, h: p.height }, { x: q.x, y: q.y, w: q.width, h: q.height }),
          `badges ${i} and ${j} overlap`,
        ).toBe(false)
      }
    // Every result is still there for screen readers, best first in its group.
    await expect(a.locator('[data-testid="vote-count"]')).toHaveCount(8)
    await expect(groups.first()).toHaveAttribute('aria-label', /results here, \d+ votes in all/)

    // A group zooms in to what it stands for, where the badges come apart again.
    const before = (await read(a, (ed) => (ed as unknown as Cam).getZoomLevel())) as number
    await groups.first().click()
    await expect
      .poll(() => read(a, (ed) => (ed as unknown as Cam).getZoomLevel()))
      .toBeGreaterThan(before * 2)
  })
})

// ---- F6 -----------------------------------------------------------------------------------------------

test('private notes: text typed while the previous note is still saving is kept (F6)', async ({ join }) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  await startBrainstorm(alice.page, 'new')
  const panel = await openPrivatePanel(bob.page)
  const compose = panel.getByTestId('pn-compose-text')

  // A slow network (staging): each "Add note" answer takes 1.5 s.
  await bob.page.route('**/api/private-brainstorms/*/notes', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await compose.fill('First idea')
  await panel.getByTestId('pn-add').click()
  // The box is free at once, and keeps the keyboard: the next idea goes straight in.
  expect.soft(await compose.inputValue()).toBe('')
  expect.soft(await compose.evaluate((el) => el === document.activeElement)).toBe(true)
  // The next idea, typed while the first one is still saving (as in the round-2 walk: replace it all).
  await compose.fill('Second idea')
  await expect(panel.getByTestId('pn-note-text').filter({ hasText: 'First idea' })).toBeVisible()
  await expect(compose).toHaveValue('Second idea')
  await panel.getByTestId('pn-add').click()
  await expect(panel.getByTestId('pn-note-text')).toHaveText(['First idea', 'Second idea'])
  await bob.page.unroute('**/api/private-brainstorms/*/notes')

  // A refused note comes back to try again, ahead of anything typed since.
  await bob.page.route('**/api/private-brainstorms/*/notes', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'That is a lot of changes.' } }),
    })
  })
  await compose.fill('Third idea')
  await panel.getByTestId('pn-add').click()
  await compose.pressSequentially('Fourth')
  await expect(panel.getByTestId('pn-error')).toBeVisible()
  await expect(compose).toHaveValue('Third idea\n\nFourth')
  await bob.page.unroute('**/api/private-brainstorms/*/notes')
})

// ---- F5 + F17 (chip) --------------------------------------------------------------------------------

test('private notes: a reveal into the Lobby tour’s Brainstorm frame lands in its free space and the revealer sees it (F5)', async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const a = alice.page
  // The tour, as the dashboard's "Start with the sample board" makes it.
  await a.goto(`/b/${board}?template=lobby-tour`)
  await waitForBoard(a)
  const frames = async () =>
    (await read(a, (ed) =>
      ed
        .getCurrentPageShapes()
        .filter((s) => s.type === 'frame')
        .map((s) => ({ id: s.id, name: String(s.props.name) })),
    )) as { id: string; name: string }[]
  await expect.poll(async () => (await frames()).length).toBe(6)
  const all = await frames()
  const brainstorm = all.find((f) => f.name === '2 · Brainstorm')?.id ?? ''
  const retro = all.find((f) => f.name === '5 · Retro')?.id ?? ''
  const before = (await read(a, (ed, id) => ed.getShape(id)?.props, brainstorm)) as { w: number; h: number }
  expect(before).toMatchObject({ w: 1600, h: 1000 })
  const kidsBefore = (await read(
    a,
    (ed, id) =>
      ed
        .getCurrentPageShapes()
        .filter((s) => s.parentId === id && s.type !== 'arrow')
        .map((s) => s.id),
    brainstorm,
  )) as string[]

  const bob = await join('bob', 'editor')
  await edit(a, (ed, id) => ed.select(id), brainstorm)
  await startBrainstorm(a, 'selected')
  await writeNote(a, 'Open on the crowd, not the logo')
  await writeNote(a, 'Let players narrate it')
  await writeNote(bob.page, 'End on the release date')
  // F17: the chip says it in words (the label is hidden below 1500 px).
  await expect.soft(bob.page.getByTestId('pn-chip-counts')).toHaveText('3 notes from 2 people')

  // alice is looking somewhere else (the Retro frame at 100%) when she reveals.
  await edit(
    a,
    (ed, id) => {
      const b = ed.getShapePageBounds(id)
      if (b) (ed as unknown as Cam).zoomToBounds(b, { targetZoom: 1 })
    },
    retro,
  )
  const panel = await openPrivatePanel(a)
  await panel.getByTestId('pn-reveal').click()
  await expect(a.getByTestId('pn-toast')).toContainText(
    '3 notes from the private brainstorm are now on the board',
  )

  await expect.poll(async () => (await placedNotes(a)).length).toBe(3)
  await a.waitForTimeout(600) // the camera animation settles for the screenshot
  await capture('private-notes-reveal-tour-brainstorm.png', a, testInfo)
  await a.emulateMedia({ colorScheme: 'dark' })
  await capture('private-notes-reveal-tour-brainstorm-dark.png', a, testInfo)
  await a.emulateMedia({ colorScheme: 'light' })
  const notes = await placedNotes(a)
  expect(notes.every((n) => n.parentId === brainstorm)).toBe(true)
  // The frame kept its 16:10 size: the notes went into its empty space.
  expect(await read(a, (ed, id) => ed.getShape(id)?.props, brainstorm)).toMatchObject({ w: 1600, h: 1000 })
  const frameBox = (await shapeBounds(a, brainstorm)) as BoxLike
  const noteBoxes = await Promise.all(notes.map(async (n) => (await shapeBounds(a, n.id)) as BoxLike))
  for (const nb of noteBoxes) expect(contains(frameBox, nb)).toBe(true)
  // ...covering nothing that was there.
  for (const id of kidsBefore) {
    const kb = (await shapeBounds(a, id)) as BoxLike
    for (const nb of noteBoxes) expect(overlap(kb, nb), `a revealed note covers ${id}`).toBe(false)
  }
  // The camera of the person who revealed moved to the notes.
  await expect
    .poll(async () => {
      const vp = await viewport(a)
      return noteBoxes.every((nb) => contains(vp, nb))
    })
    .toBe(true)
})

// ---- SEAM-07 ----------------------------------------------------------------------------------------

// Since final review R3 a name-only guest never starts a brainstorm (the API refuses it; taking over a
// session whose starter left is covered in apps/api/test/features/workshops/private-notes-access.test.ts).
test('private notes: a guest cannot start a brainstorm; a guest removed mid-session keeps their draft off the board (SEAM-07)', async ({
  join,
  browser,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const contexts: BrowserContext[] = []
  try {
    const guest = await joinAsGuest(browser, await guestLinkUrl(alice, board), 'Troll', contexts)
    const guestTools = await openWorkshopPopover(guest.page)
    await expect(guestTools.getByTestId('pn-start')).toHaveCount(0)
    await closeWorkshopPopover(guest.page)
    await startBrainstorm(bob.page, 'new', true)
    await writeNote(guest.page, 'Something nobody should see')
    await writeNote(bob.page, 'A real idea from bob')
    const bobPanel = await openPrivatePanel(bob.page)

    const res = await alice.api.fetch('DELETE', `/api/boards/${board}/members/${guest.id}`)
    expect(res.status()).toBe(200)
    await bobPanel.getByTestId('pn-reveal').click()
    await expect(bob.page.getByTestId('pn-toast')).toContainText(
      '1 note from the private brainstorm is now on the board',
    )
    await expect.poll(async () => (await placedNotes(bob.page)).length).toBe(1)
    const texts = (await read(bob.page, (ed) =>
      ed.store
        .allRecords()
        .filter((r) => !!(r as { meta?: { drPrivateNote?: unknown } }).meta?.drPrivateNote)
        .map((r) => JSON.stringify(r)),
    )) as string[]
    expect(texts.join()).toContain('A real idea from bob')
    expect(texts.join()).not.toContain('Something nobody should see')
  } finally {
    for (const c of contexts) await c.close()
  }
})

// ---- export-control UI gates ----------------------------------------------------------------------

test('history and vote results: duplicate, restore as new, .json and CSV exports are off for a limited viewer, live', async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const carol = await join('carol', 'viewer')
  const c = carol.page
  await edit(alice.page, (ed) => ed.createShape({ id: 'shape:one', type: 'note', x: 0, y: 0, props: {} }))
  await expect.poll(() => read(c, (ed) => !!ed.getShape('shape:one'))).toBe(true)
  expect((await post(alice, `/api/boards/${board}/snapshots`, { name: 'Before the review' })).status()).toBe(
    201,
  )
  expect(
    (
      await post(alice, `/api/boards/${board}/votes`, {
        votesPerPerson: 1,
        onePerObject: false,
        scope: 'board',
      })
    ).status(),
  ).toBe(201)
  const sid = (await workshopState(alice.api, board)).vote?.session.id ?? ''
  expect((await post(alice, `/api/votes/${sid}/cast`, { shapeId: 'shape:one', delta: 1 })).status()).toBe(200)
  expect((await post(alice, `/api/votes/${sid}/reveal`)).status()).toBe(200)

  const setPolicy = async (exportPolicy: 'everyone' | 'editors') => {
    const res = await alice.api.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy })
    expect(res.status(), await res.text()).toBe(200)
  }
  await setPolicy('editors')

  // The policy reached carol's tab (present-export's Export button says so too).
  await expect(c.getByTestId('export-button')).toHaveAttribute('data-export-off', '')
  const history = await openHistory(c)
  await capture('history-export-off-light.png', c, testInfo)
  await expect(history.getByTestId('history-export-off')).toHaveText(OFF_TEXT)
  await expect(history.getByTestId('history-restore-off')).toHaveText(OFF_TEXT)
  await expect(history.getByTestId('history-duplicate')).toBeDisabled()
  await expect(history.getByTestId('export-json')).toBeDisabled()
  await expect(history.getByTestId('checkpoint-restore')).toBeDisabled()
  await expect(history.getByTestId('history-duplicate')).toHaveAccessibleDescription(OFF_TEXT)
  // The server refuses them too (the UI only says so first).
  expect((await carol.api.fetch('POST', `/api/boards/${board}/duplicate`, {})).status()).toBe(403)
  await c.emulateMedia({ colorScheme: 'dark' })
  await c.setViewportSize({ width: 390, height: 844 })
  await expect(history.getByTestId('history-export-off')).toBeVisible()
  await capture('history-export-off-phone-dark.png', c, testInfo)
  expect(await c.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await c.setViewportSize({ width: 1280, height: 720 })
  await c.emulateMedia({ colorScheme: 'light' })

  const voting = await openVotingPanel(c)
  const csv = voting.getByTestId('vote-results-csv')
  await expect(csv).toBeVisible()
  await capture('vote-csv-export-off.png', c, testInfo)
  await expect(csv).toBeDisabled()
  await expect(voting.getByTestId('vote-results-csv-off')).toHaveText(OFF_TEXT)

  // The owner turns exporting back on: carol's buttons come back without a reload.
  await setPolicy('everyone')
  await expect(csv).toBeEnabled()
  await expect(voting.getByTestId('vote-results-csv-off')).toHaveCount(0)
  const download = c.waitForEvent('download')
  await csv.click()
  expect((await download).suggestedFilename()).toMatch(/\.csv$/)
  const again = await openHistory(c)
  await expect(again.getByTestId('history-duplicate')).toBeEnabled()
  await expect(again.getByTestId('export-json')).toBeEnabled()
  await expect(again.getByTestId('checkpoint-restore')).toBeEnabled()
  await expect(again.getByTestId('history-export-off')).toHaveCount(0)
})
