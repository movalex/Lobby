// Wave S, WS1 (docs/WAVE-S-CONTRACTS.md §2): review status end to end, with the status switch on (localStorage, a
// dev-auth build only).
//
//   1. A member (an editor with an account) marks a frame for review from the selection bar; a name-only guest on a
//      commenter link approves it from the badge's popover and the pill reads "Approved · Ana (guest)"; the owner's
//      second tab shows the same pill live, without a reload; the owner's bell says "Ana (guest) approved Key art B".
//   2. A name-only guest on a viewer link sees the pill and the history but no buttons, and the server refuses its
//      write (403); a guest is refused marking (403 GUEST_ACCOUNT_REQUIRED). Nothing leaves Lobby's origins.
//   3. "Request changes" asks for a note; the note is an everyone thread on the board.
//   4. The member starts a round from the panel: the item goes back to Awaiting review and a named checkpoint
//      "Review round 1 sent" is saved; closing the round is offered after.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/s1-review-status.spec.ts --project=chromium --workers=1

import { expect, select, selectNone, test } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { foreignRequests } from './r3-chat-kit.ts'
import {
  badgeOf,
  frameNamed,
  guestReviewTab,
  ORIGIN,
  openReviewBoard,
  openReviewPanel,
  popover,
  reviewLinkToken,
} from './s1-kit.ts'

test.describe.configure({ mode: 'serial' })

test('a member marks, a commenter-link guest approves as "(guest)", a viewer is refused; badges live on a second tab; the bell', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(150_000)
  const bob = await users.grant(board, 'bob', 'editor')
  const alice = await users.get('alice')
  const aliceApi = await users.api('alice')
  const member = await openReviewBoard(browser, board, bob)
  const owner = await openReviewBoard(browser, board, alice)
  const commenterToken = await reviewLinkToken(aliceApi, board, 'commenter')
  const viewerToken = await reviewLinkToken(aliceApi, board, 'viewer')
  const ana = await guestReviewTab(browser, commenterToken, 'Ana')
  const vic = await guestReviewTab(browser, viewerToken, 'Vic')
  const foreign = [...[member, owner, ana, vic].map((t) => foreignRequests(t.page))]
  try {
    // 1. the member marks the frame from the selection bar
    const frame = await frameNamed(member.page, 'Key art B', { x: 120, y: 160 })
    await select(member.page, [frame])
    await member.page.getByTestId('selection-review-mark').click()
    await expect(member.page.getByTestId('review-marked')).toContainText('In review: Key art B')
    await expect(badgeOf(member.page, frame)).toHaveAttribute('data-status', 'pending')
    // every tab gets the badge from the board event (no reload)
    for (const t of [owner, ana, vic]) await expect(badgeOf(t.page, frame)).toContainText('Awaiting review')

    // the guest approves from the badge's popover
    await badgeOf(ana.page, frame).click()
    await expect(popover(ana.page)).toBeVisible()
    await popover(ana.page).getByTestId('review-set-approved').click()
    await expect(badgeOf(ana.page, frame)).toContainText('Approved · Ana (guest)')
    // the owner's tab: the same pill, live
    await expect(badgeOf(owner.page, frame)).toHaveAttribute('data-status', 'approved', { timeout: 5_000 })
    await expect(badgeOf(owner.page, frame)).toContainText('Approved · Ana (guest)')
    await expect(badgeOf(member.page, frame)).toContainText('Approved · Ana (guest)')

    // the owner's bell (the board's own: no board name)
    // stored for the owner at once (never for the actor)...
    await expect
      .poll(async () => {
        const res = await aliceApi.request.fetch(`${WEB_URL}/api/me/notifications`, {
          headers: { 'x-lobby-client': '3' },
        })
        const body = (await res.json()) as { notifications: { kind: string }[] }
        return body.notifications.filter((n) => n.kind === 'review_status').length
      })
      .toBe(1)
    // ...and the bell shows it at its next refresh: the minute poll, or the tab coming back into focus
    await owner.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const bell = owner.page.getByTestId('notifications-bell')
    await expect(bell).not.toHaveAttribute('data-unread', '0', { timeout: 75_000 })
    await bell.click()
    const item = owner.page.locator('[data-testid="notification-item"][data-kind="review_status"]')
    await expect(item.first()).toContainText('Ana (guest) approved Key art B')
    await owner.page.keyboard.press('Escape')

    // 2. the viewer link: the pill and the history, no buttons; the server refuses the write
    await badgeOf(vic.page, frame).click()
    await expect(popover(vic.page)).toBeVisible()
    await expect(popover(vic.page).getByTestId('review-readonly')).toBeVisible()
    await expect(popover(vic.page).getByTestId('review-set-approved')).toHaveCount(0)
    await expect(popover(vic.page).getByTestId('review-history')).toContainText('Approved by Ana (guest)')
    const itemId = (await popover(vic.page).getAttribute('data-item-id')) as string
    const refused = await vic.context.request.post(`/api/boards/${board}/review/items/${itemId}/status`, {
      headers: ORIGIN,
      data: { status: 'changes_requested' },
    })
    expect(refused.status()).toBe(403)
    const marking = await ana.context.request.post(`/api/boards/${board}/review/items`, {
      headers: ORIGIN,
      data: { elementId: 'frame-x', kind: 'frame', label: 'x' },
    })
    expect(marking.status()).toBe(403)
    expect(((await marking.json()) as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    // the guest's tab offers no marking
    await select(ana.page, [frame])
    await expect(ana.page.getByTestId('selection-review-mark')).toHaveCount(0)

    // 3. "Request changes" asks for a note, and the note is a comment everyone sees
    await popover(vic.page).getByRole('button', { name: 'Close' }).click()
    // the selection bar sits over the frame's name band: nothing selected, the pill is free
    await selectNone(member.page)
    await badgeOf(member.page, frame).click()
    const pop = popover(member.page)
    await pop.getByTestId('review-set-changes_requested').click()
    await expect(pop.getByTestId('review-ask')).toContainText('Say what should change')
    await pop.getByTestId('review-note').fill('Logo larger, please')
    await pop.getByTestId('review-set-changes_requested').click()
    await expect(badgeOf(member.page, frame)).toHaveAttribute('data-status', 'changes_requested')
    await expect(badgeOf(ana.page, frame)).toContainText('Changes requested · Bob')
    const threads = await aliceApi.fetch('GET', `/api/boards/${board}/threads`)
    const bodies = ((await threads.json()) as { threads: { comments: { body: string }[] }[] }).threads.map(
      (t) => t.comments[0]?.body,
    )
    expect(bodies).toContain('Logo larger, please')

    for (const list of foreign) expect(list, 'the browser asked someone outside Lobby').toEqual([])
  } finally {
    for (const t of [member, owner, ana, vic]) await t.context.close()
  }
})

test('a round starts from the panel with its named checkpoint, resets the item, and closes', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  const bob = await users.grant(board, 'bob', 'editor')
  const member = await openReviewBoard(browser, board, bob)
  const bobApi = await users.api('bob')
  try {
    const frame = await frameNamed(member.page, 'Poster A', { x: 100, y: 140 })
    await select(member.page, [frame])
    const panel = await openReviewPanel(member.page)
    await panel.getByTestId('review-mark-selection').click()
    await expect(panel.getByTestId('review-row')).toHaveCount(1)
    await expect(panel.getByTestId('review-progress')).toHaveText('0 of 1 approved')
    // approve it, then start a round that does not keep approved items approved
    // the selection bar sits over the frame's name band: nothing selected, the pill is free
    await selectNone(member.page)
    await badgeOf(member.page, frame).click()
    await popover(member.page).getByTestId('review-set-approved').click()
    await expect(panel.getByTestId('review-progress')).toHaveText('1 of 1 approved')
    await popover(member.page).getByRole('button', { name: 'Close' }).click()
    await panel.getByTestId('review-keep-approved').uncheck()
    await panel.getByTestId('review-round-start').click()
    await expect(member.page.getByTestId('review-round-started')).toContainText('Review round 1 sent')
    await expect(panel.getByTestId('review-round-open')).toContainText('Round 1')
    await expect(badgeOf(member.page, frame)).toHaveAttribute('data-status', 'pending')
    // the checkpoint is in History under its name
    const snaps = await bobApi.fetch('GET', `/api/boards/${board}/snapshots`)
    const names = ((await snaps.json()) as { snapshots: { name: string; kind: string }[] }).snapshots
    expect(names).toContainEqual(expect.objectContaining({ name: 'Review round 1 sent', kind: 'manual' }))
    // the filters
    await panel.getByTestId('review-filter-approved').click()
    await expect(panel.getByTestId('review-empty')).toBeVisible()
    await panel.getByTestId('review-filter-pending').click()
    await expect(panel.getByTestId('review-row')).toHaveCount(1)
    // close the round
    await panel.getByTestId('review-round-close').click()
    await expect(panel.getByTestId('review-round-start')).toBeVisible()
  } finally {
    await member.context.close()
  }
})
