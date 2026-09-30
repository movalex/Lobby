// OWNER: 2C. Helpers for the ported guest specs (guests-join.spec.ts, guests-sharing.spec.ts) on the
// Excalidraw board page: the tldraw suite's guests*.spec.ts flows (a name-only link from the Share dialog,
// joining through the invite page in a fresh context) with the board waits on the facade instead of
// window.editor. The invite page, the Share dialog and the guest screens are shared by both engines' pages
// (docs/research/excalidraw/WAVE-3.md §5 "outside the canvas"); what differs is the canvas under them.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { expect, waitForCanvas } from '../tests/support/canvas.ts'
import {
  closeShare,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
} from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'

export const ORIGIN = { origin: WEB_URL }

/** The invitation token at the end of an /invite/<token> URL. */
export const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/** The Excalidraw board is open: the facade has the first welcome and the connection pill says online. */
export async function waitForLobbyBoard(page: Page): Promise<void> {
  await expect(page.getByTestId('lobby-board')).toHaveAttribute('data-engine', 'excalidraw', {
    timeout: 30_000,
  })
  await waitForCanvas(page)
  await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
}

/** Whether the page scrolls sideways (it never may, on any width). */
export const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/** One person's avatar button in the top bar's people list (3c's `people` item on this page). */
export const avatarButton = (page: Page, userId: string): Locator =>
  page.locator(`[data-testid="presence-user"][data-user-id="${userId}"] button`)

/** A remote person's cursor on the canvas overlay (the board page's cursors, chrome.tsx). */
export const cursorOf = (page: Page, userId: string): Locator =>
  page.locator(`[data-testid="cursor"][data-uid="${userId}"]`)

/** alice opens `board` and creates a guest-enabled link from the Share dialog; returns its URL. */
export async function createGuestLink(
  page: Page,
  board: string,
  kind: 'review' | 'workshop',
): Promise<string> {
  await page.goto(`/b/${board}`)
  await waitForLobbyBoard(page)
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  // DANA-03: the workshop link sits under "More ways to share".
  if (kind === 'workshop') await openMoreWaysToShare(page)
  const guests = dialog.getByTestId(kind === 'review' ? 'review-link-guests' : 'workshop-link-guests')
  // On by default for a client (review) link, off for a workshop (edit) link; the label says what it
  // does, and it sits above the Create button it applies to.
  if (kind === 'review') await expect(guests).toBeChecked()
  else await expect(guests).not.toBeChecked()
  await expect(guests).toHaveAccessibleName('Anyone with the link can join with just a name (no account)')
  const create = dialog.getByTestId(kind === 'review' ? 'review-link-create' : 'workshop-link-create')
  expect((await guests.boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    (await create.boundingBox())?.y ?? 0,
  )
  await guests.check()
  if (kind === 'review') await dialog.getByTestId('review-link-role').selectOption('commenter')
  await create.click()
  const row = dialog.getByTestId(kind === 'review' ? 'review-link-row' : 'workshop-link-row')
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-allow-guests', 'true')
  await expect(row.getByTestId('link-guests-allowed')).toBeVisible()
  const url = await row.getByTestId('review-link-url').inputValue()
  expect(url).toMatch(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
  await closeShare(page)
  return url
}

/** A fresh browser context (no sign-in at all) that joins `link` through the invite page as `name`. */
export async function joinAsGuest(
  browser: Browser,
  link: string,
  name: string,
  opts: { viewport?: { width: number; height: number }; colorScheme?: 'light' | 'dark' } = {},
): Promise<{ context: BrowserContext; page: Page; id: string }> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 820 },
    colorScheme: opts.colorScheme ?? 'light',
  })
  expect(await context.cookies()).toEqual([])
  const page = await context.newPage()
  await page.goto(link)
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
  await expect(page.getByTestId('invite-signin')).toHaveText('Sign in instead')
  const input = page.getByTestId('invite-guest-name')
  await expect(input).toHaveAccessibleName('Your name')
  // An empty name is refused here (the API refuses it too), with the reason next to the field.
  await page.getByTestId('invite-guest-join').click()
  await expect(page.getByTestId('invite-guest-name-error')).toHaveText('Enter your name.')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await input.fill(name)
  await expect(page.getByTestId('invite-guest-form')).toContainText(`“${name} (guest)”`)
  await page.getByTestId('invite-guest-join').click()
  // A guest lands straight on the board: the Excalidraw page.
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForLobbyBoard(page)
  const menu = page.getByTestId('user-menu')
  await expect(menu).toHaveAttribute('data-kind', 'guest')
  await expect(menu.getByTestId('guest-tag')).toHaveText('Guest')
  const id = (await menu.getAttribute('data-user-id')) ?? ''
  expect(id).toMatch(/^usr_/)
  return { context, page, id }
}

/** A fresh browser (no account) joins `token` as a name-only guest through the api; its page on the board. */
export async function guestOn(
  context: BrowserContext,
  token: string,
  name: string,
): Promise<{ page: Page; id: string; boardId: string }> {
  const res = await context.request.post(`${WEB_URL}/api/invitations/${token}/guest`, {
    headers: ORIGIN,
    data: { name },
  })
  expect(res.status(), await res.text()).toBe(201)
  const joined = (await res.json()) as { boardId: string; user: { id: string } }
  const page = await context.newPage()
  await page.goto(`/b/${joined.boardId}`)
  await waitForLobbyBoard(page)
  return { page, id: joined.user.id, boardId: joined.boardId }
}
