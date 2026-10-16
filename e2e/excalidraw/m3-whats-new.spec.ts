// Wave M (W3, M3-3, FTU-4.1, FTU-4.4) and wave P (P-002): the What's new card for people who have been here before, the
// board side of a "Try it" hint, and first-run hints.
//  - a returning creator's dashboard shows the card (wave P's items, no "Try it" that could look dead) and the Start row
//    above the board grid, and the old card (a dismissed wave L) does not stay dismissed;
//  - `?try=ask` on a board opens the palette with Ask this board marked, and `?try=` is out of the address bar (a reload
//    shows nothing); `?try=palette` is a bubble under its button;
//  - an unknown `?try=` value is ignored: the board opens as always and the address is left alone;
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
/** The address without its origin; ?try= must be gone from it once the board has handled it. */
const here = (page: Page) => {
  const u = new URL(page.url())
  return `${u.pathname}${u.search}`
}

test('a returning creator sees the wave P card and the Start row above the board grid; the old card’s dismissal does not carry over', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3w', 'Wen Wave')
  try {
    await p.api.createBoard(p.wid, 'Planning')
    await p.api.createBoard(p.wid, 'Retro')
    // a person who dismissed wave L's card: that version is remembered, wave S's is a new card
    await p.page.goto('/')
    await p.page.evaluate(
      ([key]) => localStorage.setItem(key as string, '2026-10-wave-l'),
      [`draftroom:whats-new-dismissed:${p.me.user.id}`],
    )
    await openDashboard(p.page, p.wid)
    await expect(card(p.page)).toBeVisible()

    await test.step('five items, wave S, and no button that could look dead', async () => {
      const titles = await card(p.page).getByTestId('whats-new-item').locator('strong').allTextContents()
      expect(titles).toEqual([
        'Client review: approve or request changes',
        'Versions and compare',
        'Comments on a video moment or a PDF page',
        'A review page for clients',
        'A summary PDF of the review',
      ])
      await expect(card(p.page).getByTestId('whats-new-try')).toHaveCount(0)
    })

    await test.step('the Start row, then the card, then the boards: in that order, down the page', async () => {
      await expect(p.page.getByTestId('board-grid')).toBeVisible()
      const y = async (id: string) => (await p.page.getByTestId(id).boundingBox())?.y ?? Number.NaN
      const row = await y('start-row')
      const news = await y('whats-new')
      const grid = await y('board-grid')
      expect(row).toBeLessThan(news)
      expect(news).toBeLessThan(grid)
      // and the card starts on the first screen of a laptop, not below the fold
      expect(news).toBeLessThan(860)
    })

    await test.step('dismissing wave S’s card is remembered under its own version', async () => {
      await card(p.page).getByTestId('whats-new-dismiss').click()
      await expect(card(p.page)).toHaveCount(0)
      expect(
        await p.page.evaluate(
          (key) => localStorage.getItem(key),
          `draftroom:whats-new-dismissed:${p.me.user.id}`,
        ),
      ).toBe('2026-10-wave-s')
      await p.page.reload()
      await expect(p.page.getByTestId('dashboard')).toBeVisible()
      await expect(card(p.page)).toHaveCount(0)
    })
  } finally {
    await p.context.close()
  }
})

test('?try=ask opens the palette with Ask this board marked; ?try= is gone from the address', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3a', 'Ada Ask')
  try {
    const first = await p.api.createBoard(p.wid, 'Opened last')
    await p.page.goto(`/b/${first.id}?try=ask`)
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

test('?try=palette is a bubble under the Search or do… button; Got it closes it', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'm3p', 'Pat Palette')
  try {
    const board = await p.api.createBoard(p.wid, 'Palette board')
    await p.page.goto(`/b/${board.id}?try=palette`)
    await waitForCanvas(p.page)
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
