// OWNER: WS1 (wave S, review status). Helpers of the s1-*.spec.ts suite: board pages with the review status switch on
// (a dev-auth build reads localStorage `lobby.reviewStatus`; set by an init script before the page loads), people on
// review links (name-only guests joined through the api, like the invite page does), and the review UI's handles.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { canvasCall, expect, expectSaved, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import type { TestUser } from '../tests/support/users.ts'

export const ORIGIN = { origin: WEB_URL }

/** features/review/flags.ts REVIEW_FLAG_KEYS.status */
export const REVIEW_STATUS_FLAG = 'lobby.reviewStatus'

export async function withReviewSwitch(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // a blocked store: the switch stays off and the spec fails on the missing UI
    }
  }, REVIEW_STATUS_FLAG)
}

export interface ReviewTab {
  readonly context: BrowserContext
  readonly page: Page
  readonly id: string
}

/** `user` signed in, on `board` with the review switch on, the canvas ready and the review loaded. */
export async function openReviewBoard(
  browser: Browser,
  board: string,
  user: TestUser,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<ReviewTab> {
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1360, height: 860 } })
  await withReviewSwitch(context)
  await signInContext(context, user.handle, user.name)
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  await reviewReady(page)
  return { context, page, id: user.id }
}

/** A name-only guest on `token`'s link (joined through the api), on its board with the review switch on. */
export async function guestReviewTab(
  browser: Browser,
  token: string,
  name: string,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<ReviewTab & { boardId: string }> {
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 820 } })
  await withReviewSwitch(context)
  const res = await context.request.post(`${WEB_URL}/api/invitations/${token}/guest`, {
    headers: ORIGIN,
    data: { name },
  })
  expect(res.status(), await res.text()).toBe(201)
  const joined = (await res.json()) as { boardId: string; user: { id: string } }
  const page = await context.newPage()
  await page.goto(`/b/${joined.boardId}`)
  await waitForCanvas(page)
  await reviewReady(page)
  return { context, page, id: joined.user.id, boardId: joined.boardId }
}

/** The review feature mounted and its first GET answered (the debug handle, local dev only). */
export async function reviewReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __lobbyReview?: { store: { loaded: { get(): boolean } } } }
            ).__lobbyReview?.store.loaded.get() === true,
        ),
      { message: 'the review store loaded', timeout: 30_000 },
    )
    .toBe(true)
}

/** A review (commenter or viewer) link of `board` that lets name-only guests in, made by `api`'s person. */
export async function reviewLinkToken(
  request: {
    fetch: (method: string, path: string, data?: unknown) => Promise<import('@playwright/test').APIResponse>
  },
  board: string,
  role: 'commenter' | 'viewer' | 'editor',
): Promise<string> {
  const res = await request.fetch('POST', `/api/boards/${board}/review-links`, { role, allowGuests: true })
  expect(res.status(), await res.text()).toBe(201)
  const url = ((await res.json()) as { url: string }).url
  return url.slice(url.lastIndexOf('/') + 1)
}

export const badgeOf = (page: Page, elementId: string) =>
  page.locator(`[data-testid="review-badge"][data-element-id="${elementId}"]`)

export const popover = (page: Page) => page.getByTestId('review-popover')

/** Opens the Review dock panel. */
export async function openReviewPanel(page: Page) {
  const panel = page.getByTestId('review-panel')
  if (!(await panel.isVisible())) {
    const toggle = page.getByTestId('dock-rail-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await page.getByTestId('dock-tab-review').click()
  }
  await expect(panel).toBeVisible()
  return panel
}

/** A frame named `name` made through the facade, saved. */
export async function frameNamed(
  page: Page,
  name: string,
  at: { x: number; y: number; width?: number; height?: number },
): Promise<string> {
  const id = (await canvasCall(page, 'create', 'frame', {
    x: at.x,
    y: at.y,
    width: at.width ?? 360,
    height: at.height ?? 240,
    name,
  })) as string
  await expectSaved(page)
  return id
}
