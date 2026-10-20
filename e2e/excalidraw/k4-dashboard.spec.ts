// Wave K (K4-1, K4-6): the dashboard's first impression, in a real browser against the real api.
//   - "Start something": creators get the template row above Recent boards, one click makes a board from a
//     tile and lands on it; an outside account (never creates) and someone who hid the picker do not get it;
//   - the Internal only control sits in the workspace menu (the workspace tile), with a shield on the tile
//     while it is on, and the same behaviour as before;
//   - (the Feedback pill and the What's new card are k4-feedback-card.spec.ts)
//   - K4-6: Share from a card still opens (its code loads on demand); touch targets measure 40 px on a phone.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-dashboard
import type { Locator, Page } from '@playwright/test'
import { Api, signInContext } from '../tests/support/api.ts'
import { expect, test } from '../tests/support/canvas.ts'
import {
  freshHandle,
  mainCard,
  openDashboard,
  personalWorkspace,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { capture } from '../tests/support/screenshots.ts'
import { createGuestLink, guestOn, waitForLobbyBoard } from './guests-kit.ts'
import { countOf, waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1360, height: 860 } })

const CREATOR = 'lobby-test-k4@darkburn.com'

/** A creator with their own personal workspace (domain access: a Dark Burn address). */
async function creator(browser: Parameters<typeof signedInContext>[0], name = 'Kay Four') {
  const p = await signedInContext(browser, freshHandle('k4'), { name, email: CREATOR })
  // a returning person (wave P: a first visit gets the Welcome card in place of the template row)
  await p.context.addInitScript(
    (key) => localStorage.setItem(key, '2026-10-wave-l'),
    `draftroom:whats-new-dismissed:${p.me.user.id}`,
  )
  return { ...p, wid: personalWorkspace(p.me), api: new Api(p.context.request) }
}

/** Makes the dashboard see an outside account (the server still decides: this only shows what the UI does). */
async function pretendOutside(page: Page) {
  const outside = { creator: false, reason: 'outside', email: 'client@client.example.test' }
  for (const url of ['**/api/auth/me', '**/api/me'])
    await page.route(url, async (route) => {
      const res = await route.fetch()
      if (res.status() !== 200) return route.fulfill({ response: res })
      const body = (await res.json()) as Record<string, unknown>
      return route.fulfill({ response: res, json: { ...body, access: outside } })
    })
}

test('"Start something": creators get the row above Recent boards; one click makes a board from a tile and opens it', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const p = await creator(browser)
  try {
    await p.api.createBoard(p.wid, 'First board')
    await openDashboard(p.page, p.wid)
    const row = p.page.getByTestId('start-row')
    await expect(row).toBeVisible()
    await expect(row.getByRole('heading', { name: 'Start something' })).toBeVisible()

    await test.step('twelve tiles, in order, above the boards, with thumbnails once the catalog has loaded', async () => {
      const tiles = row.getByTestId('start-tile')
      await expect(tiles).toHaveCount(12)
      expect(await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-template-id')))).toEqual([
        'blank',
        'lobby-tour',
        'brainstorm',
        'retrospective',
        'mood-board',
        'storyboard',
        'creative-brief',
        'client-feedback',
        'shot-list',
        'launch-timeline',
        'prioritisation-2x2',
        'kanban',
      ])
      await expect(row.locator('.dr-tthumb')).toHaveCount(11, { timeout: 15_000 })
      const rowBox = await row.boundingBox()
      const gridBox = await p.page.getByTestId('board-grid').boundingBox()
      expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(gridBox?.y ?? 0)
      await capture('k4-start-row.png', p.page, testInfo)
    })

    await test.step('Brainstorm: one click, a board named for it, opened with the template on it', async () => {
      await row.locator('[data-template-id="brainstorm"]').click()
      await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
      const id = new URL(p.page.url()).pathname.split('/')[2] ?? ''
      await waitForNavigation(p.page)
      await expect.poll(() => countOf(p.page, 'frame'), { timeout: 30_000 }).toBe(3)
      await expect(p.page.getByTestId('board-title')).toHaveText('Brainstorm')
      const detail = (await (await p.page.request.get(`/api/boards/${id}`)).json()) as {
        board: { title: string; createdBy: string; visibility: string }
      }
      expect(detail.board).toMatchObject({
        title: 'Brainstorm',
        createdBy: p.me.user.id,
        visibility: 'private',
      })
    })

    await test.step('Blank board: an empty board, no template parameter', async () => {
      await openDashboard(p.page, p.wid)
      await p.page.getByTestId('start-row').locator('[data-template-id="blank"]').click()
      await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
      await waitForLobbyBoard(p.page)
      await expect(p.page.getByTestId('board-title')).toHaveText('Untitled board')
      expect(await countOf(p.page, 'frame')).toBe(0)
    })

    await test.step('someone who asked not to see templates gets the plain Templates button, not the row', async () => {
      await p.page.evaluate(
        (key) => localStorage.setItem(key, '1'),
        `draftroom:template-picker-hidden:${p.me.user.id}`,
      )
      await openDashboard(p.page, p.wid)
      await expect(p.page.getByTestId('open-templates')).toBeVisible()
      await expect(p.page.getByTestId('start-row')).toHaveCount(0)
    })
  } finally {
    await p.context.close()
  }
})

test('"Skip to boards" goes past the template row and the What’s new card, to the first board', async ({
  browser,
}) => {
  const p = await creator(browser, 'Kip Skip')
  try {
    const board = await p.api.createBoard(p.wid, 'Skip to me')
    await openDashboard(p.page, p.wid)
    await expect(p.page.getByTestId('start-row')).toBeVisible()
    await expect(p.page.getByTestId('whats-new')).toBeVisible()
    // the skip link is the first Tab stop; Enter on it
    await p.page.keyboard.press('Tab')
    await expect(p.page.getByTestId('skip-to-boards')).toBeFocused()
    await p.page.keyboard.press('Enter')
    await expect(mainCard(p.page, board.id).locator('a.dr-bcard__link')).toBeFocused()
  } finally {
    await p.context.close()
  }
})

test('"Start something" is not for accounts that cannot create (the api still refuses them whatever the page shows)', async ({
  browser,
}) => {
  const p = await creator(browser, 'Out Sider')
  try {
    await pretendOutside(p.page)
    await openDashboard(p.page, p.wid)
    await expect(p.page.getByTestId('access-outside')).toBeVisible()
    await expect(p.page.getByTestId('start-row')).toHaveCount(0)
    await expect(p.page.getByTestId('create-board')).toHaveCount(0)
  } finally {
    await p.context.close()
  }
})

test('a name-only guest gets neither the template row, the What’s new card nor the Feedback pill (P-023)', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Gwen Host')
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    const board = await p.api.createBoard(p.wid, 'For a guest')
    const link = await createGuestLink(p.page, board.id, 'review')
    const guest = await guestOn(guestContext, link.split('/').pop() ?? '', 'Gus')
    await guest.page.goto('/')
    await expect(guest.page.getByTestId('guest-banner')).toBeVisible()
    await expect(guest.page.getByTestId('board-grid').locator('[data-testid="board-card"]')).toHaveCount(1)
    await expect(guest.page.getByTestId('start-row')).toHaveCount(0)
    await expect(guest.page.getByTestId('whats-new')).toHaveCount(0)
    await expect(guest.page.getByTestId('create-board')).toHaveCount(0)
    // P-023: Feedback is the team's; a name-only guest is not offered it
    await expect(guest.page.getByTestId('feedback-pill')).toHaveCount(0)
  } finally {
    await guestContext.close()
    await p.context.close()
  }
})

/** Opens the workspace tile's menu (the Internal only control lives in it). */
async function openWorkspaceMenu(page: Page) {
  const tile = page.getByTestId('workspace-switcher')
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click()
  await expect(page.getByTestId('workspace-menu')).toBeVisible()
}

test('Internal only sits in the workspace menu: one click opens it, the shield shows while it is on, Escape closes it', async ({
  browser,
}, testInfo) => {
  const p = await creator(browser, 'Ina Internal')
  try {
    await openDashboard(p.page, p.wid)
    const tile = p.page.getByTestId('workspace-switcher')
    await expect(tile).toHaveAttribute('aria-expanded', 'false')
    await expect(p.page.getByTestId('internal-only')).toHaveCount(0)
    await expect(p.page.getByTestId('workspace-internal-badge')).toHaveCount(0)

    await openWorkspaceMenu(p.page)
    const section = p.page.getByTestId('workspace-menu').getByTestId('internal-only')
    await expect(section).toHaveAttribute('data-on', 'false')
    await section.getByTestId('internal-only-switch').check()
    await expect(section).toHaveAttribute('data-on', 'true')
    await expect(p.page.getByTestId('workspace-internal-badge')).toBeVisible()
    await capture('k4-workspace-menu.png', p.page, testInfo)

    // the server holds it, and the shield is there on the next visit with the menu closed
    const stored = (await (await p.page.request.get(`/api/workspaces/${p.wid}/internal-only`)).json()) as {
      workspace: boolean
    }
    expect(stored.workspace).toBe(true)
    await p.page.reload()
    await expect(p.page.getByTestId('workspace-internal-badge')).toBeVisible()
    await expect(p.page.getByTestId('internal-only')).toHaveCount(0)

    await openWorkspaceMenu(p.page)
    await p.page.keyboard.press('Escape')
    await expect(p.page.getByTestId('workspace-menu')).toHaveCount(0)
    await expect(tile).toBeFocused()

    await openWorkspaceMenu(p.page)
    await p.page.getByTestId('internal-only-switch').uncheck()
    await expect(p.page.getByTestId('internal-only')).toHaveAttribute('data-on', 'false')
    await expect(p.page.getByTestId('workspace-internal-badge')).toHaveCount(0)
  } finally {
    await p.api.fetch('PUT', `/api/workspaces/${p.wid}/internal-only`, { internalOnly: false })
    await p.context.close()
  }
})

test('a card’s Share opens the dialog, and its code is fetched only when Share is chosen', async ({
  browser,
}) => {
  const p = await creator(browser, 'Sam Share')
  try {
    const board = await p.api.createBoard(p.wid, 'Share me')
    const scripts: string[] = []
    p.page.on('request', (r) => {
      if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname)
    })
    await openDashboard(p.page, p.wid)
    const card = mainCard(p.page, board.id)
    await expect(card).toBeVisible()
    // the dashboard is up and idle (the template catalog has arrived): no Share code has been asked for
    await expect(p.page.getByTestId('start-row').locator('.dr-tthumb').first()).toBeVisible({
      timeout: 15_000,
    })
    expect(scripts.filter((u) => /ShareDialog/i.test(u))).toEqual([])
    expect(scripts.some((u) => /template-catalog/.test(u))).toBe(true)

    await card.getByTestId('board-card-menu').click()
    await card.locator('[role="menuitem"][data-action="share"]').click()
    await expect(shareDialog(p.page)).toBeVisible({ timeout: 15_000 })
    expect(scripts.filter((u) => /ShareDialog/i.test(u))).toHaveLength(1)
    // and it works: the dialog names the board
    await expect(shareDialog(p.page)).toContainText('Share me')
  } finally {
    await p.context.close()
  }
})

/**
 * How far a button's hit area reaches around its centre, by asking the page which element sits under points
 * on both axes (a transparent ::after counts, the button's own box is what it looks like).
 */
async function hitArea(locator: Locator) {
  return locator.evaluate((el) => {
    // in the middle of its scroller: at an edge, what lies beyond it (a header) would answer for it
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const hit = (x: number, y: number) => {
      const t = document.elementFromPoint(x, y)
      return !!t && (t === el || el.contains(t))
    }
    const reach = (dx: number, dy: number) => {
      let n = 0
      while (n < 60 && hit(cx + dx * (n + 1), cy + dy * (n + 1))) n++
      return n
    }
    return {
      visualW: Math.round(r.width),
      visualH: Math.round(r.height),
      hitW: reach(-1, 0) + reach(1, 0) + 1,
      hitH: reach(0, -1) + reach(0, 1) + 1,
    }
  })
}

test('on a phone with touch, the bell, a card’s ⋯ and star and the template categories have 40 px targets, and look the size they did', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const handle = freshHandle('k4p')
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  })
  try {
    const me = await signInContext(context, handle, 'Pia Phone', { email: CREATOR })
    const wid = personalWorkspace(me)
    const api = new Api(context.request)
    const board = await api.createBoard(wid, 'Thumb me')
    const page = await context.newPage()
    await openDashboard(page, wid)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    const card = mainCard(page, board.id)
    await expect(card).toBeVisible()

    const bell = await hitArea(page.getByTestId('dashboard-bell'))
    const menu = await hitArea(card.getByTestId('board-card-menu'))
    const star = await hitArea(card.getByTestId('board-star'))
    for (const [name, h] of Object.entries({ bell, menu, star })) {
      expect(h.hitW, `${name} hit width`).toBeGreaterThanOrEqual(40)
      expect(h.hitH, `${name} hit height`).toBeGreaterThanOrEqual(40)
      // what it looks like is what it was: under 40 (the old sizes are 30 to 34)
      expect(h.visualW, `${name} visual width`).toBeLessThan(40)
      expect(h.visualH, `${name} visual height`).toBeLessThan(40)
    }
    // the sizes they have always had (28 to 34 px on a phone: the top bar squeezes the bell to 28, the footer
    // the ⋯ to 28), never grown to make room for a finger
    for (const [name, h] of Object.entries({ bell, menu, star })) {
      expect(h.visualW, `${name} visual width`).toBeGreaterThanOrEqual(24)
      expect(h.visualW, `${name} visual width`).toBeLessThanOrEqual(34)
      expect(h.visualH, `${name} visual height`).toBeLessThanOrEqual(34)
    }

    await page.getByTestId('create-board').click()
    await expect(page.getByTestId('create-board-dialog')).toBeVisible()
    const chips = page.getByTestId('template-category')
    await expect.poll(() => chips.count()).toBeGreaterThanOrEqual(5)
    // the dialog opens with a short animation (it scales in): measure once it has settled
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
    )
    for (let i = 0; i < (await chips.count()); i++) {
      const h = await hitArea(chips.nth(i))
      expect(h.hitH, `category ${i} hit height`).toBeGreaterThanOrEqual(40)
      expect(h.hitW, `category ${i} hit width`).toBeGreaterThanOrEqual(40)
      expect(h.visualH, `category ${i} visual height`).toBe(30)
    }
  } finally {
    await context.close()
  }
})

test('with a mouse the same controls keep their own size (the larger area is for touch only)', async ({
  browser,
}) => {
  const p = await creator(browser, 'Max Mouse')
  try {
    const board = await p.api.createBoard(p.wid, 'Mouse me')
    await openDashboard(p.page, p.wid)
    const card = mainCard(p.page, board.id)
    await expect(card).toBeVisible()
    expect(await p.page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)
    for (const [name, locator] of [
      ['bell', p.page.getByTestId('dashboard-bell')],
      ['menu', card.getByTestId('board-card-menu')],
      ['star', card.getByTestId('board-star')],
    ] as const) {
      const h = await hitArea(locator)
      expect(Math.abs(h.hitW - h.visualW), name).toBeLessThanOrEqual(1)
      expect(Math.abs(h.hitH - h.visualH), name).toBeLessThanOrEqual(1)
    }
  } finally {
    await p.context.close()
  }
})

// ---- K4 review follow-ups --------------------------------------------------------------------------------

test('the template catalog is fetched only where the row is shown: not on the All view, not for an account that cannot create', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const p = await creator(browser, 'Cat Alog')
  // Wave K integration: K1-3 downloads the board page's code on an idle dashboard, and that code holds the
  // catalog (the board's templates panel), so this checks the dashboard's OWN idle load with K1's prefetch
  // off: on Save-Data (K1 skips it there; the dashboard's gate does not depend on it)
  await p.context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'connection', {
      configurable: true,
      get: () => ({ saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {} }),
    })
  })
  const scriptsOf = (page: Page) => {
    const seen: string[] = []
    page.on('request', (r) => {
      if (r.resourceType() === 'script') seen.push(new URL(r.url()).pathname)
    })
    return seen
  }
  const catalog = (urls: string[]) => urls.filter((u) => /template-catalog/.test(u))
  try {
    await test.step('the All boards view of a creator: idle for longer than the idle load waits, no catalog', async () => {
      const seen = scriptsOf(p.page)
      await openDashboard(p.page, p.wid, 'all')
      await expect(p.page.getByTestId('start-row')).toHaveCount(0)
      await p.page.waitForTimeout(3500)
      expect(catalog(seen)).toEqual([])
    })

    await test.step('an account that cannot create, on the landing view: no row, no catalog', async () => {
      const outsider = await p.context.newPage()
      await pretendOutside(outsider)
      const seen = scriptsOf(outsider)
      await openDashboard(outsider, p.wid)
      await expect(outsider.getByTestId('access-outside')).toBeVisible()
      await outsider.waitForTimeout(3500)
      expect(catalog(seen)).toEqual([])
      await outsider.close()
    })

    await test.step('the control: the creator’s landing view does fetch it once idle', async () => {
      const seen = scriptsOf(p.page)
      await openDashboard(p.page, p.wid)
      await expect(p.page.getByTestId('start-row')).toBeVisible()
      await expect.poll(() => catalog(seen).length, { timeout: 15_000 }).toBeGreaterThan(0)
    })
  } finally {
    await p.context.close()
  }
})

test('a Share chunk that is gone (a tab left open across a deploy) shows a notice with Reload, and the dashboard stays', async ({
  browser,
}) => {
  const p = await creator(browser, 'Stale Tab')
  try {
    const board = await p.api.createBoard(p.wid, 'Share me later')
    await openDashboard(p.page, p.wid)
    const card = mainCard(p.page, board.id)
    await expect(card).toBeVisible()
    // the new build no longer has the chunk this old page asks for
    await p.page.route('**/*ShareDialog*', (route) => route.abort())
    await card.getByTestId('board-card-menu').click()
    await card.locator('[role="menuitem"][data-action="share"]').click()
    const notice = p.page.getByTestId('lazy-dialog-failed')
    await expect(notice).toBeVisible({ timeout: 15_000 })
    await expect(notice).toContainText('Share could not open')
    await expect(notice.getByTestId('lazy-dialog-reload')).toBeVisible()
    await expect(shareDialog(p.page)).toHaveCount(0)
    // the page is still there behind it (an uncaught error would have unmounted the app)
    await p.page.keyboard.press('Escape')
    await expect(notice).toHaveCount(0)
    await expect(p.page.getByTestId('dashboard')).toBeVisible()
    await expect(card).toBeVisible()
  } finally {
    await p.context.close()
  }
})

// fix/firefox (the NAS Firefox run): the test above clicks Share while the dashboard's idle board-code prefetch is
// still under way, and the page's stale-chunk handler ignored every failure in that time; once it was done, the
// handler took the Share chunk's failure as its own and reloaded the dashboard (Firefox, every time; Chromium too,
// when the prefetch had finished). The Share import is the dialog's (ownedImport): the notice, and no reload.
test('a Share chunk that is gone, once the dashboard is idle (its prefetch done): the notice, and no reload', async ({
  browser,
}) => {
  const p = await creator(browser, 'Idle Tab')
  try {
    const board = await p.api.createBoard(p.wid, 'Share me idle')
    let loads = 0
    p.page.on('load', () => loads++)
    // the idle prefetch of the board code (lib/prefetch-board.ts K1-3): its page chunk, loaded
    const boardCode = p.page.waitForEvent('requestfinished', {
      predicate: (r) => /\/assets\/LobbyBoardPage-[\w-]+\.js$/.test(new URL(r.url()).pathname),
      timeout: 30_000,
    })
    await openDashboard(p.page, p.wid)
    const card = mainCard(p.page, board.id)
    await expect(card).toBeVisible()
    await boardCode
    // and nothing else is loading (the chunks it imports are in too)
    await p.page.waitForLoadState('networkidle')
    const loadsBefore = loads
    await p.page.route('**/*ShareDialog*', (route) => route.abort())
    await card.getByTestId('board-card-menu').click()
    await card.locator('[role="menuitem"][data-action="share"]').click()
    const notice = p.page.getByTestId('lazy-dialog-failed')
    await expect(notice).toBeVisible({ timeout: 15_000 })
    await expect(notice).toContainText('Share could not open')
    await expect(notice.getByTestId('lazy-dialog-reload')).toBeVisible()
    // nothing reloaded under the person who chose Share
    expect(loads).toBe(loadsBefore)
    expect(await p.page.evaluate(() => sessionStorage.getItem('lobby:stale-chunk-reload'))).toBeNull()
    await p.page.keyboard.press('Escape')
    await expect(notice).toHaveCount(0)
    await expect(card).toBeVisible()
  } finally {
    await p.context.close()
  }
})

test('Escape closes the workspace menu from inside it, and leaves a field elsewhere on the page alone', async ({
  browser,
}) => {
  const p = await creator(browser, 'Esc Ape')
  try {
    await openDashboard(p.page, p.wid)
    const tile = p.page.getByTestId('workspace-switcher')
    const menu = p.page.getByTestId('workspace-menu')
    const search = p.page.getByTestId('dashboard-search')

    await openWorkspaceMenu(p.page)
    // typing in the search box and pressing Escape there is the box’s business, not the menu’s
    await search.focus()
    await search.fill('xyz')
    await p.page.keyboard.press('Escape')
    await expect(menu).toBeVisible()
    await expect(search).toBeFocused()

    // from the tile or the switch inside the panel, Escape closes it and the tile gets the keyboard back
    await tile.focus()
    await p.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(tile).toBeFocused()
    await openWorkspaceMenu(p.page)
    await p.page.getByTestId('internal-only-switch').focus()
    await p.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(tile).toBeFocused()
  } finally {
    await p.context.close()
  }
})
