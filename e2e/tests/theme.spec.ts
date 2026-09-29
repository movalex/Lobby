// Dark mode (PRF-12, PRI-19): the System / Light / Dark choice in the account menu is kept per browser,
// is applied before the app's JavaScript runs (no light flash), and moves the app chrome AND the tldraw
// canvas together, live, in both directions (tldraw's own Ctrl/Cmd+/ switch moves the chrome too).
import { signInContext } from './support/api.ts'
import { waitForBoard } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import {
  backgroundOf,
  canvasFrames,
  closeAccountMenu,
  expectCanvas,
  expectChrome,
  PAPER,
  pickTheme,
  recordCanvasFrames,
  SURFACE,
  storedChoice,
  THEME_KEY,
  themedContext,
  tldrawStoredScheme,
} from './support/theme.ts'

test('theme: a dark choice persists, paints before the app loads, and reaches the board canvas', async ({
  browser,
  board,
  users,
}) => {
  const context = await themedContext(browser, 'light')
  try {
    await signInContext(context, 'alice')
    const page = await context.newPage()
    await page.goto(`/w/${users.devStudioId}`)
    await expect(page.getByTestId('dashboard')).toBeVisible()

    await test.step('first visit: System, and the OS is light', async () => {
      await expectChrome(page, 'light', 'system')
      expect(await storedChoice(page)).toBeNull()
    })

    await test.step('Dark in the account menu applies at once and is stored', async () => {
      await pickTheme(page, 'dark')
      await expectChrome(page, 'dark', 'dark')
      expect(await storedChoice(page)).toBe('dark')
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#14161b')
      await closeAccountMenu(page)
      expect(await backgroundOf(page, '.dr-side')).toBe(SURFACE.dark)
    })

    await test.step('a reload is dark before any of the app JavaScript runs (no light flash)', async () => {
      // Block every bundle: only the inline script in index.html and the stylesheet remain.
      await page.route(/\/assets\/.*\.js$/, (route) => route.abort())
      await page.goto(`/w/${users.devStudioId}`)
      await expectChrome(page, 'dark', 'dark')
      await expect(page.getByTestId('dashboard')).toHaveCount(0) // the app really did not start
      expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
      await page.unroute(/\/assets\/.*\.js$/)
      await page.goto(`/w/${users.devStudioId}`)
      await expect(page.getByTestId('dashboard')).toBeVisible()
      await expectChrome(page, 'dark', 'dark')
    })

    await test.step('the board opens dark: chrome and canvas, tldraw told "dark", never a light frame', async () => {
      // The canvas has never been loaded in this browser, yet tldraw's stored preference already says
      // "dark" (the startup bundle keeps it in step): the canvas must not show one light frame.
      expect(await tldrawStoredScheme(page)).toBe('dark')
      expect(await page.evaluate(() => typeof window.editor)).toBe('undefined')
      await context.addInitScript(recordCanvasFrames) // for the full reloads below
      await page.evaluate(recordCanvasFrames) // this document: an in-app navigation, no reload
      await page.locator(`[data-testid="board-card"][data-board-id="${board}"] a`).first().click()
      await expect(page).toHaveURL(new RegExp(`/b/${board}$`))
      await waitForBoard(page)
      expect(await canvasFrames(page)).toEqual(['dark'])
      await expectChrome(page, 'dark', 'dark')
      await expectCanvas(page, 'dark')
      expect(await tldrawStoredScheme(page)).toBe('dark')
      expect(await backgroundOf(page, '.dr-topbar')).toBe(SURFACE.dark)
      expect(await backgroundOf(page, '.dr-dock')).toBe(SURFACE.dark)
    })

    await test.step('Light on the board switches both at once, without a reload', async () => {
      const editorBefore = await page.evaluate(() => window.editor !== undefined)
      await pickTheme(page, 'light')
      await expectChrome(page, 'light', 'light')
      await expectCanvas(page, 'light')
      expect(editorBefore && (await page.evaluate(() => window.editor !== undefined))).toBe(true)
      await closeAccountMenu(page)
      expect(await backgroundOf(page, '.dr-topbar')).toBe(SURFACE.light)
    })

    await test.step('and it survives a reload of the board (light from the first canvas frame)', async () => {
      await page.reload()
      await waitForBoard(page)
      expect(await canvasFrames(page)).toEqual(['light'])
      await expectChrome(page, 'light', 'light')
      await expectCanvas(page, 'light')
      expect(await storedChoice(page)).toBe('light')
      expect(await tldrawStoredScheme(page)).toBe('light')
    })
  } finally {
    await context.close()
  }
})

test("theme: System follows the OS live, and tldraw's own dark-mode switch moves the whole app", async ({
  browser,
  board,
}) => {
  const context = await themedContext(browser, 'dark')
  try {
    await signInContext(context, 'alice')
    await context.addInitScript(recordCanvasFrames)
    const page = await context.newPage()
    await page.goto(`/b/${board}`)
    await waitForBoard(page)

    await test.step('System on a dark OS, first visit ever: dark chrome, dark canvas from its first frame', async () => {
      await expectChrome(page, 'dark', 'system')
      await expectCanvas(page, 'dark')
      expect(await canvasFrames(page)).toEqual(['dark'])
      expect(await tldrawStoredScheme(page)).toBe('system')
    })

    await test.step('the OS switches to light while the board is open: both follow', async () => {
      await page.emulateMedia({ colorScheme: 'light' })
      await expectChrome(page, 'light', 'system')
      await expectCanvas(page, 'light')
      await page.emulateMedia({ colorScheme: 'dark' })
      await expectChrome(page, 'dark', 'system')
      await expectCanvas(page, 'dark')
    })

    await test.step("tldraw's own theme switch becomes the stored choice; Ctrl/Cmd+/ no longer flips it (A11Y2-07)", async () => {
      // Focus the canvas (an empty spot). Ctrl/Cmd+/ opens the keyboard shortcuts now, not a silent flip.
      const box = await page.locator('.tl-canvas').boundingBox()
      if (!box) throw new Error('no canvas')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.press('ControlOrMeta+/')
      await expect(page.locator('.tlui-shortcuts-dialog__body')).toBeVisible()
      await expectCanvas(page, 'dark')
      await page.keyboard.press('Escape')
      await expect(page.locator('.tlui-shortcuts-dialog__body')).toHaveCount(0)
      // tldraw's Theme menu (Preferences) writes the same user preference its toggle did.
      await page.evaluate(() =>
        (
          window.editor as unknown as { user: { updateUserPreferences(p: { colorScheme: string }): void } }
        ).user.updateUserPreferences({ colorScheme: 'light' }),
      )
      await expectCanvas(page, 'light')
      await expectChrome(page, 'light', 'light')
      expect(await storedChoice(page)).toBe('light')
      await page.getByTestId('dev-identity-badge').click()
      await expect(page.getByTestId('theme-picker')).toHaveAttribute('data-preference', 'light')
      await closeAccountMenu(page)
    })

    await test.step('a choice made in another tab applies to the open board', async () => {
      const other = await context.newPage()
      await other.goto('/')
      await expect(other.getByTestId('dashboard')).toBeVisible()
      await expectChrome(other, 'light', 'light')
      await pickTheme(other, 'dark')
      await expectChrome(page, 'dark', 'dark')
      await expectCanvas(page, 'dark')
      await other.close()
    })
  } finally {
    await context.close()
  }
})

test('theme: a dark mode picked in tldraw before the app had a theme is kept, app-wide', async ({
  browser,
  board,
}) => {
  const context = await themedContext(browser, 'light')
  try {
    // What tldraw 5.4.2 stored after Ctrl/Cmd+/ (its user-preferences format, version 13).
    await context.addInitScript(() => {
      if (localStorage.getItem('TLDRAW_USER_DATA_v3') === null) {
        localStorage.setItem(
          'TLDRAW_USER_DATA_v3',
          JSON.stringify({ version: 13, user: { id: 'legacy-user', colorScheme: 'dark' } }),
        )
      }
    })
    await signInContext(context, 'alice')
    const page = await context.newPage()
    await page.goto(`/b/${board}`)
    await waitForBoard(page)
    await expectCanvas(page, 'dark')
    await expectChrome(page, 'dark', 'dark')
    expect(await storedChoice(page)).toBe('dark')
    await page.goto('/')
    await expect(page.getByTestId('dashboard')).toBeVisible()
    await expectChrome(page, 'dark', 'dark')
  } finally {
    await context.close()
  }
})

test('theme: the signed-out pages (sign-in, invitation) follow the stored choice', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  // Domain access: a single-use invitation names the one address that may accept it.
  const res = await alice.fetch('POST', `/api/boards/${board}/invitations`, {
    role: 'editor',
    email: 'guest-theme@client.example.test',
  })
  expect(res.status()).toBe(201)
  const invite = new URL(((await res.json()) as { url: string }).url).pathname
  const context = await themedContext(browser, 'light')
  try {
    await context.addInitScript(
      ([key]) => {
        if (localStorage.getItem(key as string) === null) localStorage.setItem(key as string, 'dark')
      },
      [THEME_KEY],
    )
    const page = await context.newPage()
    await page.goto('/')
    await expect(page).toHaveURL(/\/signin$/)
    await expect(page.getByTestId('signin-form')).toBeVisible()
    await expectChrome(page, 'dark', 'dark')
    expect(await backgroundOf(page, '.dr-signin__card')).toBe(SURFACE.dark)

    await page.goto(invite)
    await expect(page.getByTestId('invite-page')).toBeVisible()
    await expectChrome(page, 'dark', 'dark')
    expect(await backgroundOf(page, '.dr-invite-card')).toBe(SURFACE.dark)
    expect(await backgroundOf(page, '.dr-invite-card__facts')).toBe(PAPER.dark)
  } finally {
    await context.close()
  }
})
