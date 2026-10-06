// F10 on the Excalidraw board page (ported from tests/comment-privacy.spec.ts): team-only comments. While a client link is live, the team's composer starts with "Team only"
// on; the thread shows a "Team only" badge. A name-only guest who joins through the link never sees
// a team thread: not as a pin, not in the Comments panel, not through the API, and not live when the
// team posts another one; they cannot resolve the team's threads either.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { expect, setViewport, test, viewport, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import {
  commentsApi,
  emptyCanvasPoint,
  newCommentPopover,
  openCommentsPanel,
  pin,
  pins,
  pressCommentTool,
  threadPopover,
} from './comments-kit.ts'

const ORIGIN = { origin: WEB_URL }

async function joinAsGuest(browser: Browser, link: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForCanvas(page)
  return { context, page }
}

/**
 * Starts a new comment at an empty spot and sets "Team only" before posting. `startsOn`: what the
 * switch must show before it is touched (it is chosen per comment, so it starts from the default).
 */
async function postComment(
  page: Page,
  text: string,
  teamOnly: boolean,
  dx: number,
  opts: { startsOn?: boolean } = {},
) {
  await pressCommentTool(page)
  const p = await emptyCanvasPoint(page)
  await page.mouse.click(p.x + dx, p.y)
  const toggle = newCommentPopover(page).getByTestId('new-comment-team-only')
  await expect(toggle).toBeVisible()
  if (opts.startsOn !== undefined) await expect(toggle).toBeChecked({ checked: opts.startsOn })
  if ((await toggle.isChecked()) !== teamOnly) await toggle.click()
  await expect(toggle).toBeChecked({ checked: teamOnly })
  const composer = newCommentPopover(page).getByTestId('comment-composer')
  await composer.fill(text)
  await composer.press('Enter')
  await expect(newCommentPopover(page)).toHaveCount(0)
  const popover = threadPopover(page)
  await expect(popover).toBeVisible()
  const id = (await popover.getAttribute('data-thread-id')) ?? ''
  await expect(popover.getByTestId('thread-team-only')).toHaveCount(teamOnly ? 1 : 0)
  await page.keyboard.press('Escape')
  await expect(threadPopover(page)).toHaveCount(0)
  return id
}

test('team-only comments: on by default while a client link is live, never shown to the guest who joins through it', async ({
  browser,
  board,
  canvasSession,
  users,
}) => {
  const contexts: BrowserContext[] = []
  try {
    const alice = await canvasSession('alice')
    const a = alice.page
    const aliceApi = await users.api('alice')
    const created = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'commenter',
      allowGuests: true,
    })
    expect(created.status()).toBe(201)
    const link = ((await created.json()) as { url: string }).url
    // The board now has a client link: reload so the comments list says so.
    await a.reload()
    await waitForCanvas(a)

    // The composer starts with "Team only" on for the team.
    await pressCommentTool(a)
    const spot = await emptyCanvasPoint(a)
    await a.mouse.click(spot.x, spot.y)
    const toggle = newCommentPopover(a).getByTestId('new-comment-team-only')
    await expect(toggle).toBeChecked()
    await expect(newCommentPopover(a).getByTestId('new-comment-team-only-row')).toContainText(
      'People outside Dark Burn / TPG won’t see it',
    )
    await a.keyboard.press('Escape')
    await expect(newCommentPopover(a)).toHaveCount(0)

    const internal = await postComment(a, 'Hero for option B? Internal only', true, -90)
    const shared = await postComment(a, 'Which cup colour do you prefer?', false, -30)
    await pin(a, internal).click()
    await expect(threadPopover(a, internal).getByTestId('thread-team-only')).toHaveText('Team only')
    await a.keyboard.press('Escape')

    // The guest joins on a phone: one pin, one row, and the API agrees.
    const guest = await joinAsGuest(browser, link, 'Dana Whitfield')
    contexts.push(guest.context)
    const g = guest.page
    // Look where alice commented (pins off screen are not drawn).
    const shown = (await commentsApi(aliceApi).threads(board)).threads.find((t) => t.id === shared)
    const at = shown?.anchor.kind === 'point' ? { x: shown.anchor.x, y: shown.anchor.y } : { x: 0, y: 0 }
    const v = await viewport(g)
    await setViewport(g, { x: at.x - v.width / 2, y: at.y - v.height / 2 })
    await expect(pins(g)).toHaveCount(1)
    await expect(pin(g, shared)).toHaveCount(1)
    await expect(pin(g, internal)).toHaveCount(0)
    const panel = await openCommentsPanel(g)
    await expect(panel.getByTestId('comment-row')).toHaveCount(1)
    await expect(panel).not.toContainText('Internal only')
    const byGuest = await g.request.get(`/api/boards/${board}/threads?status=all`)
    expect(byGuest.status()).toBe(200)
    const body = await byGuest.text()
    expect(body).not.toContain('Internal only')
    expect(body).not.toContain(internal)
    expect(
      (
        await g.request.post(`/api/threads/${internal}/comments`, { data: { body: 'hi' }, headers: ORIGIN })
      ).status(),
    ).toBe(404)
    // The guest cannot resolve the team's thread (no button; the API refuses too).
    await panel.getByTestId('comment-row').first().click()
    const popover = threadPopover(g, shared)
    await expect(popover).toBeVisible()
    await expect(popover.getByTestId('thread-resolve')).toHaveCount(0)
    await expect(popover.getByTestId('thread-visibility')).toHaveCount(0)
    expect((await g.request.post(`/api/threads/${shared}/resolve`, { headers: ORIGIN })).status()).toBe(403)

    // Live: another team-only thread never reaches the guest; the next shared one does (so the first
    // would have arrived by then).
    await a.bringToFront()
    // The shared comment above turned the switch off for itself only: this one starts on again.
    await postComment(a, 'Internal: push the budget talk', true, 30, { startsOn: true })
    const later = await postComment(a, 'Here is option C', false, 90)
    await expect(pin(g, later)).toHaveCount(1)
    await expect(pins(g)).toHaveCount(2)
    const all = await commentsApi(aliceApi).threads(board)
    expect(all.threads).toHaveLength(4)
  } finally {
    for (const c of contexts) await c.close()
  }
})
