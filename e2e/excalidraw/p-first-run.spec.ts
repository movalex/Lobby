// Wave P (the release audit, "Lobby as a new teammate"): the first-run experience, in a real browser against the real api.
//  - P-002, P-009: a first visit gets the Welcome card (what Lobby is, three one-click starts, the keys), not a changelog;
//    "Create a board" is above the fold on a laptop and on a phone; What's new is for people who have been here;
//  - P-010: a Help menu on the dashboard (the tour, the keyboard shortcuts, Send feedback);
//  - P-004, P-042: a board with no picture yet has one neutral placeholder; a board nobody edited says "Created";
//  - P-019: a link that is not a Lobby board says so; the no-access screen says "Back to your boards";
//  - P-029: the sign-in page says "Lobby";
//  - P-031: the Start row fades and has an arrow when tiles wait to the right;
//  - P-033, P-043, P-045: the empty Trash has its own picture; toasts do not cover the view toggles; a new project lobby
//    does not take the person into it;
//  - P-035: a workspace name like "Omar Haddad's workspace" is not cut in the board's top bar;
//  - the empty command palette has no "Not available right now" tail.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/p-first-run.spec.ts --project=chromium --workers=1
import type { Locator, Page } from '@playwright/test'
import { Api } from '../tests/support/api.ts'
import { test as base, expect, waitForCanvas } from '../tests/support/canvas.ts'
import {
  chooseFromMenu,
  freshHandle,
  mainCard,
  openDashboard,
  personalWorkspace,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { capture } from '../tests/support/screenshots.ts'

const test = base
test.use({ viewport: { width: 1440, height: 900 } })

const CREATOR = 'lobby-test-pfr@darkburn.com'

/** A creator (a Dark Burn address) with their personal workspace, on a window of the given size. */
async function creator(
  browser: Parameters<typeof signedInContext>[0],
  name: string,
  viewport = { width: 1440, height: 900 },
) {
  const p = await signedInContext(browser, freshHandle('pfr'), { name, email: CREATOR, viewport })
  return { ...p, wid: personalWorkspace(p.me), api: new Api(p.context.request) }
}

/** A returning person: this browser has seen an earlier release of the What's new card. */
async function markReturning(p: { page: Page; me: { user: { id: string } } }) {
  await p.page.goto('/')
  await p.page.evaluate(
    (key) => localStorage.setItem(key, '2026-10-wave-l'),
    `draftroom:whats-new-dismissed:${p.me.user.id}`,
  )
}

const inside = async (loc: Locator, height: number) => {
  const box = await loc.boundingBox()
  if (!box) throw new Error('no box')
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(height)
}

test('a first visit gets the Welcome card with Create a board above the fold; the Help menu has the tour, the shortcuts and feedback', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'Nia New')
  try {
    await openDashboard(p.page, p.wid)
    const welcome = p.page.getByTestId('welcome')

    await test.step('Welcome, not What’s new; three starts; the keys; no Try it', async () => {
      await expect(welcome).toBeVisible()
      await expect(welcome).toContainText('Welcome to Lobby')
      await expect(p.page.getByTestId('whats-new')).toHaveCount(0)
      await expect(p.page.getByTestId('whats-new-try')).toHaveCount(0)
      const starts = welcome.getByTestId('welcome-start')
      expect(await starts.evaluateAll((els) => els.map((e) => e.getAttribute('data-template-id')))).toEqual([
        'blank',
        'brainstorm',
        'lobby-tour',
      ])
      await expect(welcome).toContainText('Search or do anything')
      await expect(welcome).toContainText('Sticky note, text, rectangle')
      // the row of twelve is not also there
      await expect(p.page.getByTestId('start-row')).toHaveCount(0)
    })

    await test.step('Create a board (and the header’s New board) are on the first screen of a laptop', async () => {
      await expect(p.page.getByTestId('dashboard-empty')).toBeVisible()
      const create = p.page.getByTestId('dashboard-empty').getByRole('button', { name: 'Create a board' })
      await inside(create, 900)
      await inside(p.page.getByTestId('create-board'), 900)
      await capture('p-welcome-desktop.png', p.page, testInfo)
    })

    await test.step('the Help menu lists the tour, the keyboard shortcuts and Send feedback', async () => {
      await p.page.getByTestId('help-menu').click()
      const items = p.page.getByRole('menuitem')
      await expect(items).toHaveText(['Take the Lobby tour', 'Keyboard shortcuts', 'Send feedback'])
      await items.nth(1).click()
      const dialog = p.page.getByTestId('help-shortcuts')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Search or do anything')
      await expect(dialog).toContainText('Ctrl+K')
      await capture('p-help-shortcuts.png', p.page, testInfo)
      await p.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await p.page.getByTestId('help-menu').click()
      await p.page.getByRole('menuitem', { name: 'Send feedback' }).click()
      await expect(p.page.getByTestId('feedback-dialog')).toBeVisible()
      await p.page.keyboard.press('Escape')
      await expect(p.page.getByTestId('feedback-dialog')).toHaveCount(0)
    })

    await test.step('Blank board: one click, a board is made and opened; the Welcome does not come back', async () => {
      await welcome.getByTestId('welcome-start').first().click()
      await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
      await waitForCanvas(p.page)
      await openDashboard(p.page, p.wid)
      await expect(p.page.getByTestId('dashboard')).toBeVisible()
      await expect(p.page.getByTestId('welcome')).toHaveCount(0)
      // and nothing else greets them either: they have seen this release
      await expect(p.page.getByTestId('whats-new')).toHaveCount(0)
      await expect(p.page.getByTestId('start-row')).toBeVisible()
    })
  } finally {
    await p.context.close()
  }
})

test('Take the Lobby tour in the Help menu makes the tour board and opens it', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'Tom Tour')
  try {
    await markReturning(p)
    await openDashboard(p.page, p.wid)
    await p.page.getByTestId('help-menu').click()
    await p.page.getByRole('menuitem', { name: 'Take the Lobby tour' }).click()
    await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
    await waitForCanvas(p.page)
    await expect(p.page.getByTestId('board-title')).toHaveText('Lobby tour')
  } finally {
    await p.context.close()
  }
})

test('on a phone the Welcome fits, with Create a board on the first screen and no sideways scroll', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Pia Phone', { width: 390, height: 844 })
  try {
    await openDashboard(p.page, p.wid)
    await expect(p.page.getByTestId('welcome')).toBeVisible()
    await inside(p.page.getByTestId('create-board'), 844)
    await capture('p-welcome-phone.png', p.page, testInfo)
    const scrollsSideways = await p.page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(scrollsSideways).toBe(false)
  } finally {
    await p.context.close()
  }
})

test('a returning person gets What’s new once, for this release, and no changelog button that could look dead', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Rae Returning')
  try {
    await markReturning(p)
    await openDashboard(p.page, p.wid)
    await expect(p.page.getByTestId('welcome')).toHaveCount(0)
    const card = p.page.getByTestId('whats-new')
    await expect(card).toBeVisible()
    // wave T's release (dashboard/whats-new.ts '2026-10-wave-t')
    await expect(card).toContainText('Storyboards, from a script too')
    await expect(card).toContainText('Play a storyboard as an animatic')
    await expect(card).toContainText('Work cards, Kanban and the card table')
    await expect(card).toContainText('Timelines from your cards')
    await expect(card.getByRole('button', { name: /try it/i })).toHaveCount(0)
  } finally {
    await p.context.close()
  }
})

test('the Start row fades out at the right edge and has an arrow that scrolls it; at the end both go', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Sam Scroll')
  try {
    await markReturning(p)
    await openDashboard(p.page, p.wid)
    const scroller = p.page.getByTestId('start-scroller')
    await expect(scroller).toHaveAttribute('data-more', 'true')
    const next = p.page.getByTestId('start-next')
    await expect(next).toBeVisible()
    await capture('p-start-row-fade.png', p.page, testInfo)
    for (let i = 0; i < 6 && (await scroller.getAttribute('data-more')) === 'true'; i++) {
      await next.click()
      await p.page.waitForTimeout(500)
    }
    await expect(scroller).toHaveAttribute('data-more', 'false')
    await expect(next).toHaveCount(0)

    // P-032: the Lobby tour tile shows its first frame, not a thin strip of six tiny ones
    const tour = p.page.locator('[data-testid="start-tile"][data-template-id="lobby-tour"] svg.dr-tthumb')
    await expect(tour).toBeVisible({ timeout: 15_000 })
    const [, , w, h] = ((await tour.getAttribute('viewBox')) ?? '').split(' ').map(Number)
    expect((w ?? 0) / (h ?? 1)).toBeLessThan(2)
  } finally {
    await p.context.close()
  }
})

test('boards: a neutral placeholder with initials, the same in Recent and All boards; a board nobody edited says Created', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Pat Placeholder')
  try {
    await markReturning(p)
    const board = await p.api.createBoard(p.wid, 'Festival booth plan')
    await openDashboard(p.page, p.wid, 'all')
    const card = mainCard(p.page, board.id)
    const art = card.getByTestId('board-thumb-placeholder')
    await expect(art).toBeVisible()
    await expect(art).toContainText('No preview yet')
    await expect(art).toContainText('FB')
    // nothing drawn that could pass for the board's content
    await expect(art.locator('path, circle')).toHaveCount(0)
    await expect(card).toContainText(/Created (just now|\d+ min ago)/)
    await expect(card).not.toContainText('Edited')
    const all = await art.evaluate((el) => el.outerHTML)
    await capture('p-placeholder-card.png', p.page, testInfo)

    // a board nobody has opened is not in Recent: open it, and come back
    await p.page.goto(`/b/${board.id}`)
    await waitForCanvas(p.page)
    await openDashboard(p.page, p.wid)
    const recent = mainCard(p.page, board.id).getByTestId('board-thumb-placeholder')
    await expect(recent).toHaveCount(1)
    expect(await recent.evaluate((el) => el.outerHTML)).toBe(all)
  } finally {
    await p.context.close()
  }
})

test('the empty Trash has its own picture; a toast does not cover the view toggles; a new project lobby does not take you into it', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await creator(browser, 'Tia Trash')
  try {
    await markReturning(p)
    const board = await p.api.createBoard(p.wid, 'To the bin')

    await test.step('Trash is empty: a bin, not the "make a note" picture', async () => {
      await openDashboard(p.page, p.wid, 'trash')
      await expect(p.page.getByTestId('dashboard-empty')).toBeVisible()
      await expect(p.page.getByTestId('empty-art-trash')).toBeVisible()
    })

    await test.step('moving a board to the trash: the toast is clear of the view toggles and the header controls', async () => {
      await openDashboard(p.page, p.wid, 'all')
      await chooseFromMenu(mainCard(p.page, board.id), 'trash')
      const toast = p.page.getByTestId('dashboard-toast')
      await expect(toast).toBeVisible()
      const t = await toast.boundingBox()
      for (const id of ['view-toggle', 'owner-filter', 'dashboard-sort', 'create-board']) {
        const b = await p.page.getByTestId(id).boundingBox()
        if (!t || !b) throw new Error(`no box for ${id}`)
        const above = t.y + t.height <= b.y || t.y >= b.y + b.height
        const beside = t.x + t.width <= b.x || t.x >= b.x + b.width
        const apart = above || beside
        expect(apart, `the toast covers ${id}`).toBe(true)
      }
    })

    await test.step('a new project lobby: the person stays where they are; the lobby is in the sidebar; the notice offers to open it', async () => {
      const before = new URL(p.page.url()).pathname
      await p.page.getByTestId('create-project').click()
      await p.page.getByTestId('create-project-name').fill('Alpha launch')
      await p.page.getByTestId('create-project-name').press('Enter')
      const toast = p.page.getByTestId('dashboard-toast').filter({ hasText: 'Alpha launch' })
      await expect(toast).toBeVisible()
      await expect(p.page.getByTestId('project-list')).toContainText('Alpha launch')
      expect(new URL(p.page.url()).pathname).toBe(before)
      await p.page.getByTestId('project-open-new').click()
      await expect(p.page.getByTestId('dashboard-title')).toHaveText('Alpha launch')
    })
  } finally {
    await p.context.close()
  }
})

test('a link that cannot be a Lobby board says so, and the no-access screen leads back to your boards', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Nell Nolink')
  try {
    await p.page.goto('/b/not-a-board')
    const screen = p.page.getByTestId('board-not-found')
    await expect(screen).toContainText("This board doesn't exist or was deleted")
    await expect(screen.getByRole('link', { name: 'Back to your boards' })).toBeVisible()
    await expect(p.page.getByTestId('access-request-button')).toHaveCount(0)

    // a well-formed id nobody made: the api answers as it does for a board they may not open, so the request stays
    await p.page.goto('/b/b-zzzzzzzzzz')
    const noAccess = p.page.getByTestId('no-access')
    await expect(noAccess).toBeVisible()
    await expect(noAccess).toContainText('may not exist or may have been deleted')
    await expect(noAccess.getByRole('link', { name: 'Back to your boards' })).toBeVisible()
  } finally {
    await p.context.close()
  }
})

test('the sign-in page says "Lobby" (by Dark Burn), never "DBC Lobby"', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const page = await context.newPage()
    await page.goto('/signin')
    const signin = page.getByTestId('signin-page')
    await expect(signin).toBeVisible()
    await expect(signin).toContainText('Lobby')
    await expect(page.getByTestId('signin-by')).toHaveText('by Dark Burn')
    await expect(signin).not.toContainText('DBC Lobby')
  } finally {
    await context.close()
  }
})

test('the board’s top bar shows a workspace name like "Omar Haddad’s workspace" in full', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Omar Haddad')
  try {
    await markReturning(p)
    const board = await p.api.createBoard(p.wid, 'Crumb board')
    await p.page.goto(`/b/${board.id}`)
    await waitForCanvas(p.page)
    const crumb = p.page.locator('.dr-topbar__ws')
    await expect(crumb).toBeVisible()
    await expect(crumb).toHaveText("Omar Haddad's workspace")
    const cut = await crumb.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(cut).toBe(false)
  } finally {
    await p.context.close()
  }
})

test('the empty command palette has no "Not available right now" tail; typing still finds what cannot run yet', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Cleo Command')
  try {
    await markReturning(p)
    const board = await p.api.createBoard(p.wid, 'Palette board')
    await p.page.goto(`/b/${board.id}`)
    await waitForCanvas(p.page)
    await p.page.getByTestId('topbar-palette').click()
    const palette = p.page.getByTestId('command-palette')
    await expect(palette).toBeVisible()
    await expect(palette).not.toContainText('Not available right now')
    // typing ranks every line, including the ones that cannot run now, each with its reason
    await p.page.getByTestId('command-palette-input').fill('crop')
    await expect(p.page.locator('[data-testid="command-palette-option"]').first()).toBeVisible()
  } finally {
    await p.context.close()
  }
})
