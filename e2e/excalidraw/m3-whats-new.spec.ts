// Wave M (W3, M3-3, FTU-4.1, FTU-4.4): What's new for wave L, "Try it" that lands on the feature, and first-run hints.
//  - a returning creator's dashboard shows the wave L card and the Start row above the board grid, and the old card (a
//    dismissed wave K) does not stay dismissed;
//  - "Try it" on Ask opens the board they opened last that they can edit, with the palette marking Ask this board, and
//    `?try=` is out of the address bar (a reload shows nothing); "Try it" on the palette is a bubble under its button;
//  - an unknown `?try=` value is ignored: the board opens as always and the address is left alone;
//  - with no board at all "Try it" goes to the Start row (nothing is made);
//  - an empty board's card has "Ctrl+K: search or do" and, with AI on, "Diagram from words".
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m3-whats-new.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { Api } from '../tests/support/api.ts'
import { test as base, expect, waitForCanvas } from '../tests/support/canvas.ts'
import {
  freshHandle,
  openDashboard,
  personalWorkspace,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { AI_API_ENV_3H, FAKE_OPENAI_PORT_3H } from './ai-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1360, height: 860 }, apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

const CREATOR = 'lobby-test-m3w@darkburn.com'

/** A creator (a Dark Burn address) with their personal workspace and an Api for it. */
async function creator(browser: Parameters<typeof signedInContext>[0], handle: string, name: string) {
  const p = await signedInContext(browser, freshHandle(handle), { name, email: CREATOR })
  return { ...p, wid: personalWorkspace(p.me), api: new Api(p.context.request) }
}

const card = (page: Page) => page.getByTestId('whats-new')
const tryIt = (page: Page, hint: string) => card(page).locator(`[data-action="board-hint:${hint}"]`)
/** The address without its origin; ?try= must be gone from it once the board has handled it. */
const here = (page: Page) => {
  const u = new URL(page.url())
  return `${u.pathname}${u.search}`
}

test('a returning creator sees the wave L card and the Start row above the board grid; the old card’s dismissal does not carry over', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3w', 'Wen Wave')
  try {
    await p.api.createBoard(p.wid, 'Planning')
    await p.api.createBoard(p.wid, 'Retro')
    // a person who dismissed wave K's card: that version is remembered, wave L's is a new card
    await p.page.goto('/')
    await p.page.evaluate(
      ([key]) => localStorage.setItem(key as string, '2026-10-wave-k'),
      [`draftroom:whats-new-dismissed:${p.me.user.id}`],
    )
    await openDashboard(p.page, p.wid)
    await expect(card(p.page)).toBeVisible()

    await test.step('five items, wave L’s, each with a Try it that is named for it', async () => {
      const titles = await card(p.page).getByTestId('whats-new-item').locator('strong').allTextContents()
      expect(titles).toEqual([
        'Ctrl+K: do it in words',
        'Ask this board / Wrap up',
        'Diagram from words and Mermaid paste',
        'Time travel: bring back just what you need',
        'Run of show, spotlight and vote results',
      ])
      expect(
        await card(p.page)
          .getByTestId('whats-new-try')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-action'))),
      ).toEqual([
        'board-hint:palette',
        'board-hint:ask',
        'board-hint:diagram',
        'board-hint:time-travel',
        'board-hint:run-of-show',
      ])
    })

    await test.step('the Start row, then the card, then the boards: in that order, down the page', async () => {
      await expect(p.page.getByTestId('board-grid')).toBeVisible()
      const y = async (id: string) => (await p.page.getByTestId(id).boundingBox())?.y ?? Number.NaN
      const row = await y('start-row')
      const news = await y('whats-new')
      const grid = await y('board-grid')
      expect(row).toBeLessThan(news)
      expect(news).toBeLessThan(grid)
      // and the card is on the first screen of a laptop, not below the fold
      const height = (await card(p.page).boundingBox())?.height ?? 0
      expect(news + height).toBeLessThan(860)
    })

    await test.step('dismissing wave L’s card is remembered under its own version', async () => {
      await card(p.page).getByTestId('whats-new-dismiss').click()
      await expect(card(p.page)).toHaveCount(0)
      expect(
        await p.page.evaluate(
          (key) => localStorage.getItem(key),
          `draftroom:whats-new-dismissed:${p.me.user.id}`,
        ),
      ).toBe('2026-10-wave-l')
      await p.page.reload()
      await expect(p.page.getByTestId('dashboard')).toBeVisible()
      await expect(card(p.page)).toHaveCount(0)
    })
  } finally {
    await p.context.close()
  }
})

test('Try it on Ask opens the board they opened last, with the palette marking Ask this board; ?try= is gone from the address', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3a', 'Ada Ask')
  try {
    const first = await p.api.createBoard(p.wid, 'Opened last')
    const second = await p.api.createBoard(p.wid, 'Made later')
    // the first board is the one they opened last (the second was only made after it)
    await p.page.goto(`/b/${second.id}`)
    await waitForCanvas(p.page)
    await p.page.goto(`/b/${first.id}`)
    await waitForCanvas(p.page)
    await openDashboard(p.page, p.wid)

    await tryIt(p.page, 'ask').click()
    await expect.poll(() => new URL(p.page.url()).pathname, { timeout: 30_000 }).toBe(`/b/${first.id}`)
    await waitForCanvas(p.page)

    await test.step('the palette opens on Try with Ask this board marked, and says what it is', async () => {
      const dialog = p.page.getByTestId('command-palette')
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      const ask = p.page.locator('[data-testid="command-palette-option"][data-entry-id="cmd:ai.ask"]')
      await expect(ask).toHaveAttribute('data-coach', 'true')
      await expect(ask).toContainText('Ask this board')
      await expect(ask).toContainText('Try this')
      await expect(p.page.getByTestId('command-palette-coach')).toContainText('answer with sources')
      // nothing is chosen for them
      await expect(p.page.locator('[data-testid="command-palette-option"][data-active="true"]')).toHaveCount(
        0,
      )
    })

    await test.step('?try= is out of the address bar at once; a reload shows nothing', async () => {
      expect(here(p.page)).toBe(`/b/${first.id}`)
      await p.page.keyboard.press('Escape')
      await expect(p.page.getByTestId('command-palette')).toHaveCount(0)
      await p.page.reload()
      await waitForCanvas(p.page)
      await p.page.waitForTimeout(1500)
      await expect(p.page.getByTestId('command-palette')).toHaveCount(0)
      await expect(p.page.getByTestId('try-coach')).toHaveCount(0)
    })
  } finally {
    await p.context.close()
  }
})

test('Try it on Ctrl+K is a bubble under the Search or do… button; Got it closes it', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3p', 'Pat Palette')
  try {
    const board = await p.api.createBoard(p.wid, 'Palette board')
    await openDashboard(p.page, p.wid)
    await tryIt(p.page, 'palette').click()
    await expect.poll(() => new URL(p.page.url()).pathname, { timeout: 30_000 }).toBe(`/b/${board.id}`)
    const bubble = p.page.getByTestId('try-coach')
    await expect(bubble).toBeVisible({ timeout: 30_000 })
    await expect(bubble).toContainText('Search or do…')
    expect(here(p.page)).toBe(`/b/${board.id}`)
    // under the button, on the screen
    const b = await p.page.getByTestId('topbar-palette').boundingBox()
    const c = await bubble.boundingBox()
    if (!b || !c) throw new Error('no boxes')
    expect(c.y).toBeGreaterThanOrEqual(b.y + b.height)
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.x + c.width).toBeLessThanOrEqual(1360)
    await bubble.getByTestId('try-coach-ok').click()
    await expect(bubble).toHaveCount(0)
  } finally {
    await p.context.close()
  }
})

test('an unknown ?try= value is ignored: the board opens as always, nothing is shown, the address is left alone', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'm3u', 'Uma Unknown')
  try {
    const board = await p.api.createBoard(p.wid, 'Plain board')
    const errors: string[] = []
    p.page.on('pageerror', (e) => errors.push(e.message))
    await p.page.goto(`/b/${board.id}?try=nope`)
    await waitForCanvas(p.page)
    await p.page.waitForTimeout(2500)
    await expect(p.page.getByTestId('command-palette')).toHaveCount(0)
    await expect(p.page.getByTestId('try-coach')).toHaveCount(0)
    expect(here(p.page)).toBe(`/b/${board.id}?try=nope`)
    expect(errors).toEqual([])
  } finally {
    await p.context.close()
  }
})

test('with no board at all Try it goes to the Start row and makes nothing', async ({ browser }) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'm3n', 'Nora None')
  try {
    await openDashboard(p.page, p.wid)
    expect(await p.api.listBoards(p.wid)).toHaveLength(0)
    await tryIt(p.page, 'ask').click()
    await expect(p.page.locator('[data-testid="start-tile"]').first()).toBeFocused()
    expect(new URL(p.page.url()).pathname).toBe(`/w/${p.wid}`)
    await p.page.waitForTimeout(800)
    expect(await p.api.listBoards(p.wid)).toHaveLength(0)
  } finally {
    await p.context.close()
  }
})

// N1 (wave M follow-up 3): with no board and the template row switched off ("Don't show templates on new boards") there is
// nowhere to take them: the buttons are disabled, with the reason, instead of doing nothing.
test('with no board and the Start row switched off, Try it is disabled and says why (it used to do nothing)', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'm3x', 'Nico Nowhere')
  try {
    await p.page.addInitScript(
      (key) => localStorage.setItem(key, '1'),
      `draftroom:template-picker-hidden:${p.me.user.id}`,
    )
    await openDashboard(p.page, p.wid)
    expect(await p.api.listBoards(p.wid)).toHaveLength(0)
    await expect(card(p.page)).toBeVisible()
    await expect(p.page.locator('[data-testid="start-tile"]')).toHaveCount(0)
    const buttons = card(p.page).locator('[data-testid="whats-new-try"]')
    expect(await buttons.count()).toBeGreaterThan(2)
    for (const b of await buttons.all()) {
      await expect(b).toBeDisabled()
      await expect(b).toHaveAttribute('title', /no board to try this on/i)
    }
    // and nothing was made
    await p.page.waitForTimeout(500)
    expect(await p.api.listBoards(p.wid)).toHaveLength(0)
  } finally {
    await p.context.close()
  }
})

test('an empty board’s card has "Search or do" and, with AI on, "Diagram from words"; the first opens the palette', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3e', 'Eve Empty')
  try {
    const board = await p.api.createBoard(p.wid, 'Empty board')
    await p.page.goto(`/b/${board.id}`)
    await waitForCanvas(p.page)
    const hint = p.page.getByTestId('empty-board-hint')
    await expect(hint).toBeVisible()
    const search = hint.getByTestId('empty-hint-palette')
    await expect(search).toBeVisible()
    await expect(search).toHaveText(/^(Ctrl\+K|⌘K): search or do$/)
    // the older buttons are still there
    await expect(hint.getByTestId('empty-hint-templates')).toBeVisible()
    await expect(hint.getByTestId('empty-hint-mindmap')).toBeVisible()
    await expect(hint.getByTestId('empty-hint-diagram')).toHaveText('Diagram from words', { timeout: 30_000 })
    await search.click()
    await expect(p.page.getByTestId('command-palette')).toBeVisible()
    await expect(p.page.locator('[data-testid="command-palette-option"][data-active="true"]')).toHaveCount(0)
    await p.page.keyboard.press('Escape')
  } finally {
    await p.context.close()
  }
})
