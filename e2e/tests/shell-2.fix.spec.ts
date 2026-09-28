// Demo polish, shell-2 (the final review's DANA-08, DANA-11, DANA-13, DANA-14, A11Y-06, A11Y-09,
// A11Y-17): the lobby wording, the storage meter, the folded phone sidebar, the skip links, the focus
// after sign-in, a quiet sign-in console, and no Language item in the board menu.
import type { Page } from '@playwright/test'
import { signInContext } from './support/api.ts'
import { waitForBoard } from './support/board.ts'
import { openBoardMenu } from './support/canvas-ux-2.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'
import { createGuestLink, joinAsGuest } from './support/tags.ts'

const TAGLINE =
  'Shared boards for sketching, planning and reviewing work together, with a lobby for each DBC project.'

async function openDashboard(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}`)
  await expect(page.getByTestId('dashboard-title')).toBeVisible({ timeout: 30_000 })
}

test('DANA-08 / A11Y-17: sign-in says what a lobby is without a console error; after sign-in the heading has the focus', async ({
  browser,
  users,
}, testInfo) => {
  await users.get('alice')
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  try {
    const page = await context.newPage()
    const problems: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`)
    })
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`)
    })
    await page.goto('/')
    await expect(page.getByTestId('signin-form')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('signin-tagline')).toHaveText(TAGLINE)
    await expect(page.getByTestId('signin-heading')).toHaveText('Sign in to Lobby')
    // The session check answered "signed out" (204): nothing for the browser to log as an error.
    await page.waitForLoadState('networkidle')
    expect(problems).toEqual([])
    await capture('shell2-signin.png', page, testInfo)

    // Keyboard sign-in: the dashboard's heading takes the focus, so the new page is announced.
    await page.getByTestId('signin-quick-alice').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('dashboard-title')).toBeFocused({ timeout: 30_000 })
    expect(problems.filter((p) => p.includes('401'))).toEqual([])

    // The sidebar tells the same story: a workspace, and project lobbies in it.
    await expect(page.getByTestId('workspace-switcher')).toContainText('Workspace · Owner')
    await expect(page.locator('#dr-projects-heading')).toHaveText('Project lobbies')
    await expect(page.getByTestId('create-project')).toHaveAccessibleName('New project lobby')
  } finally {
    await context.close()
  }
})

test('DANA-14: the storage meter is labelled, and its breakdown opens from a button (no tooltip)', async ({
  browser,
  users,
}, testInfo) => {
  await users.get('alice')
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  try {
    await signInContext(context, 'alice')
    const page = await context.newPage()
    await openDashboard(page, users.devStudioId)
    const toggle = page.getByTestId('storage-toggle')
    await expect(page.getByTestId('storage-usage')).toHaveText(/^Storage: \d+(\.\d)? (KB|MB|GB) of 2 GB$/)
    await expect(page.locator('[data-testid="storage"] [title]')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('storage-breakdown')).toHaveCount(0)

    await toggle.click()
    const panel = page.getByTestId('storage-breakdown')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAttribute('aria-controls', (await panel.getAttribute('id')) ?? 'missing')
    await expect(panel).toContainText("of this workspace's storage is in use")
    for (const row of ['Uploaded files', 'File previews', 'Board thumbnails', 'Files'])
      await expect(panel.locator('dt', { hasText: row }).first()).toBeVisible()
    await capture('shell2-storage-open.png', page, testInfo)

    // Escape closes it and gives the keyboard back to the button; Enter opens it again.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('storage-breakdown')).toBeVisible()
    // A click elsewhere closes it too.
    await page.getByTestId('dashboard-title').click()
    await expect(page.getByTestId('storage-breakdown')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('A11Y-06 / DANA-11: at 390 px and at 200% zoom the boards come first; the sidebar folds into Menu', async ({
  browser,
  users,
}, testInfo) => {
  await users.get('alice')
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try {
    await signInContext(context, 'alice')
    const page = await context.newPage()
    await openDashboard(page, users.devStudioId)
    const toggle = page.getByTestId('side-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('nav-all')).toBeHidden()
    // The heading and "New board" are on the first screen.
    const title = await page.getByTestId('dashboard-title').boundingBox()
    expect(title?.y ?? 999).toBeLessThan(260)
    const create = await page.getByTestId('create-board').boundingBox()
    expect((create?.y ?? 999) + (create?.height ?? 0)).toBeLessThan(844)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await capture('shell2-dashboard-phone.png', page, testInfo)

    // Menu opens the navigation; a link closes it and the new list's heading takes the focus.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('nav-all')).toBeVisible()
    await expect(page.getByTestId('storage-usage')).toBeVisible()
    await capture('shell2-dashboard-phone-menu.png', page, testInfo)
    await page.getByTestId('nav-all').click()
    await expect(page.getByTestId('dashboard-title')).toHaveText('All boards')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('nav-all')).toBeHidden()
    await expect(page.getByTestId('dashboard-title')).toBeFocused()
    // Escape folds it again from the keyboard.
    await toggle.click()
    await page.getByTestId('nav-recent').focus()
    await page.keyboard.press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()

    // A 1440 px laptop at 200% zoom.
    await page.setViewportSize({ width: 720, height: 450 })
    await expect(toggle).toBeVisible()
    const zoomed = await page.getByTestId('dashboard-title').boundingBox()
    expect((zoomed?.y ?? 999) + (zoomed?.height ?? 0)).toBeLessThan(450)
    await capture('shell2-dashboard-zoom200.png', page, testInfo)

    // Wide screens keep the full sidebar and no Menu button.
    await page.setViewportSize({ width: 1360, height: 860 })
    await expect(toggle).toBeHidden()
    await expect(page.getByTestId('nav-all')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('DANA-11: a guest’s dashboard has no Archived or Trash', async ({ browser, session }) => {
  const a = await session('alice')
  const link = await createGuestLink(a.page, 'review')
  const guest = await joinAsGuest(browser, link, 'Gia Client')
  try {
    await guest.page.goto('/')
    await expect(guest.page.getByTestId('dashboard-title')).toBeVisible({ timeout: 30_000 })
    await expect(guest.page.getByTestId('guest-banner')).toBeVisible()
    await expect(guest.page.getByTestId('nav-recent')).toBeVisible()
    await expect(guest.page.getByTestId('nav-archived')).toHaveCount(0)
    await expect(guest.page.getByTestId('nav-trash')).toHaveCount(0)
  } finally {
    await guest.context.close()
  }
})

test('A11Y-09: the dashboard’s first Tab is "Skip to boards"', async ({ browser, users }) => {
  await users.get('alice')
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  try {
    await signInContext(context, 'alice')
    const page = await context.newPage()
    await openDashboard(page, users.devStudioId)
    await page.keyboard.press('Tab')
    const skip = page.getByTestId('skip-to-boards')
    await expect(skip).toBeFocused()
    await expect(skip).toHaveText('Skip to boards')
    await expect(skip).toBeInViewport()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('dashboard-title')).toBeFocused()
  } finally {
    await context.close()
  }
})

test('A11Y-09 / DANA-13: the board’s first Tab is "Skip to canvas"; the board menu has no Language', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await a.page.reload()
  await waitForBoard(a.page)
  const noteId = await a.page.evaluate(() => {
    const ed = window.editor as unknown as {
      createShapes(s: unknown[]): void
      getCurrentPageShapeIds(): Set<string>
      selectNone(): void
    }
    ed.createShapes([{ type: 'note', x: 200, y: 200 }])
    ed.selectNone()
    return [...ed.getCurrentPageShapeIds()][0] ?? ''
  })
  expect(noteId).not.toBe('')
  await a.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await a.page.keyboard.press('Tab')
  const skip = a.page.getByTestId('skip-to-canvas')
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await capture('shell2-board-skip.png', a.page, testInfo)
  await a.page.keyboard.press('Enter')
  // tldraw's own skip behaviour: the first shape is selected and the canvas has the keyboard.
  await expect
    .poll(() =>
      a.page.evaluate(() => {
        const ed = window.editor as unknown as {
          getSelectedShapeIds(): string[]
          getInstanceState(): { isFocused: boolean }
        }
        return {
          selected: ed.getSelectedShapeIds(),
          focused: ed.getInstanceState().isFocused,
          inCanvas: !!document.activeElement?.closest('.tl-container'),
        }
      }),
    )
    .toEqual({ selected: [noteId], focused: true, inCanvas: true })

  // DANA-13: Lobby is English only, so the board menu offers no Language submenu.
  await openBoardMenu(a.page)
  await expect(a.page.getByTestId('main-menu-sub.preferences-button')).toBeVisible()
  await expect(a.page.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeVisible()
  await expect(a.page.locator('[data-testid^="main-menu-sub.help menu language"]')).toHaveCount(0)
  await expect(a.page.getByRole('menuitem', { name: 'Language', exact: true })).toHaveCount(0)
  await capture('shell2-board-menu.png', a.page, testInfo)
})
