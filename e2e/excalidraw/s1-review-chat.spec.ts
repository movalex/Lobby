// Wave S, WS1 (docs/WAVE-S-CONTRACTS.md §2.5): a review status reaches a Slack channel through the wave R hooks, end to
// end against the FAKE receiver (never the real Slack or Teams). The owner opts in to "review_status" (a rev-3 build's
// choice); a name-only guest approves from the badge; the receiver gets ONE message for the event: "Ana (guest)
// approved an item on a private board", without the item's label (the hook's text switch is off) and without the note.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/s1-review-chat.spec.ts --project=chromium --workers=1

import { expect, select, test } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import {
  CHAT_API_ENV,
  CHAT_RECEIVER_PORT,
  type FakeReceiver,
  slackHookUrl,
  startFakeReceiver,
} from './r3-chat-kit.ts'
import {
  badgeOf,
  frameNamed,
  guestReviewTab,
  ORIGIN,
  openReviewBoard,
  popover,
  reviewLinkToken,
} from './s1-kit.ts'

/** @draftroom/contracts CHAT_HIDDEN_BOARD_TITLE (the suites do not depend on the contracts) */
const CHAT_HIDDEN_BOARD_TITLE = 'a private board'

test.use({ apiEnv: CHAT_API_ENV })
test.describe.configure({ mode: 'serial' })

let receiver: FakeReceiver
test.beforeAll(async () => {
  receiver = await startFakeReceiver(CHAT_RECEIVER_PORT)
})
test.afterAll(async () => {
  await receiver.close()
})

const blockText = (post: { body: Record<string, unknown> | null } | undefined) =>
  ((post?.body?.blocks as { text?: { text?: string } }[] | undefined)?.[0]?.text?.text ?? '') as string

test('one Slack message for a guest’s approval, through the fake receiver: who, never the label or the note', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(150_000)
  receiver.reset()
  const alice = await users.get('alice')
  const aliceApi = await users.api('alice')
  const bob = await users.grant(board, 'bob', 'editor')
  // the owner adds the channel and opts in to review_status (a rev-3 build's choice)
  const made = await aliceApi.fetch('POST', `/api/workspaces/${users.devStudioId}/chat-hooks`, {
    name: '#lobby-reviews',
    provider: 'slack',
    url: slackHookUrl(receiver.origin),
  })
  expect(made.status(), await made.text()).toBe(201)
  const hookId = ((await made.json()) as { id: string }).id
  for (const api of [aliceApi, await users.api('bob')]) {
    const put = await api.request.fetch(`${WEB_URL}/api/me/chat-prefs`, {
      method: 'PUT',
      headers: { ...ORIGIN, 'x-lobby-client': '3' },
      data: { workspaceId: users.devStudioId, prefs: [{ hookId, kinds: ['review_status'] }] },
    })
    expect(put.status(), await put.text()).toBe(200)
  }
  const member = await openReviewBoard(browser, board, bob)
  const owner = await openReviewBoard(browser, board, alice)
  const ana = await guestReviewTab(browser, await reviewLinkToken(aliceApi, board, 'commenter'), 'Ana')
  try {
    const frame = await frameNamed(member.page, 'Key art B', { x: 140, y: 180 })
    await select(member.page, [frame])
    await member.page.getByTestId('selection-review-mark').click()
    await expect(badgeOf(ana.page, frame)).toContainText('Awaiting review')
    await badgeOf(ana.page, frame).click()
    await popover(ana.page).getByTestId('review-note').fill('The secret note words')
    await popover(ana.page).getByTestId('review-set-approved').click()
    await expect(badgeOf(owner.page, frame)).toContainText('Approved · Ana (guest)')

    // the owner and the member who marked it are both told, and both opted in: ONE message for the hook
    await expect.poll(() => receiver.posts.length, { timeout: 20_000 }).toBe(1)
    const post = receiver.posts[0]
    expect(blockText(post)).toContain(`Ana (guest) approved an item on ${CHAT_HIDDEN_BOARD_TITLE}`)
    expect(post?.raw).not.toContain('Key art B')
    expect(post?.raw).not.toContain('secret note words')
    await new Promise((r) => setTimeout(r, 4_000))
    expect(receiver.posts).toHaveLength(1)
  } finally {
    for (const t of [member, owner, ana]) await t.context.close()
  }
})
