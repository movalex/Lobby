// Wave R (WS2, R2-1..R2-3): notifications to Slack, end to end against the FAKE receiver (never the real Slack or Teams).
//
//   1. An admin adds a hook and sends a test message; the receiver gets one Slack-shaped POST and the page never shows
//      the URL again (only its hint); the browser asks nobody outside Lobby.
//   2. Ben opts in to mentions; Ana mentions him; the receiver gets one POST: no comment text, and a private board is
//      "a private board". The admin turns the text switch on: the next one carries the title and the first words.
//   3. Ben opts out: the next mention sends nothing.
//   4. A 500 is tried again 30 s later (backoff), and the same message arrives.
//   5. A 404 switches the hook off with its reason; "Turn back on" and the next mention reaches the channel.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/r3-chat-hooks.spec.ts --project=chromium --workers=1

import { expect, test } from '../tests/support/canvas.ts'
import { commentsApi, mentionToken } from '../tests/support/comments.ts'
import { openDashboard, signedInContext } from '../tests/support/dashboard-share.ts'
import type { Users } from '../tests/support/users.ts'
import {
  CHAT_API_ENV,
  CHAT_RECEIVER_PORT,
  closeChatDialog,
  type FakeReceiver,
  foreignRequests,
  openChatDialog,
  SLACK_SECRET_PART,
  slackHookUrl,
  startFakeReceiver,
} from './r3-chat-kit.ts'

test.use({ apiEnv: CHAT_API_ENV })
test.describe.configure({ mode: 'serial' })

let receiver: FakeReceiver
test.beforeAll(async () => {
  receiver = await startFakeReceiver(CHAT_RECEIVER_PORT)
})
test.afterAll(async () => {
  await receiver.close()
})

const textOf = (post: { body: Record<string, unknown> | null } | undefined) => String(post?.body?.text ?? '')
const blockText = (post: { body: Record<string, unknown> | null } | undefined) =>
  ((post?.body?.blocks as { text?: { text?: string } }[] | undefined)?.[0]?.text?.text ?? '') as string

/** Ana (alice, who owns Dev Studio) mentions Ben (bob) in a new thread on `board`. */
async function mentionBen(users: Users, board: string, words: string) {
  const alice = await users.api('alice')
  const bob = await users.get('bob')
  return commentsApi(alice).createThread(
    board,
    { kind: 'point', x: 10, y: 10 },
    `${words} ${mentionToken('Bob Chen', bob.id)}`,
  )
}

test('an admin adds a Slack channel and sends a test message; the URL never comes back and nobody outside Lobby is asked', async ({
  browser,
  users,
}) => {
  test.setTimeout(120_000)
  receiver.reset()
  const alice = await signedInContext(browser, 'alice')
  const foreign = foreignRequests(alice.page)
  try {
    await openDashboard(alice.page, users.devStudioId, 'all')
    await openChatDialog(alice.page, 'channels')
    await expect(alice.page.getByTestId('chat-hooks-warning')).toContainText('guests of that channel')

    await alice.page.getByTestId('chat-hook-add-name').fill('#lobby-pitches')
    await alice.page.getByTestId('chat-hook-add-url').fill(slackHookUrl(receiver.origin))
    await alice.page.getByTestId('chat-hook-add-submit').click()
    const row = alice.page.getByTestId('chat-hook-row')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('chat-hook-name')).toHaveText('#lobby-pitches')
    await expect(row.getByTestId('chat-hook-hint')).toHaveText('hooks.slack.com/…/•••1234')
    // the URL left the field at once and is nowhere on the page
    await expect(alice.page.getByTestId('chat-hook-add-url')).toHaveValue('')
    expect(await alice.page.content()).not.toContain(SLACK_SECRET_PART)

    await row.getByTestId('chat-hook-test').click()
    await expect(row.getByTestId('chat-hook-result')).toContainText('Test message sent')
    await expect.poll(() => receiver.posts.length, { timeout: 15_000 }).toBe(1)
    const post = receiver.posts[0]
    expect(post?.path).toBe(`/services/T0000000A/B0000000B/${SLACK_SECRET_PART}`)
    expect(post?.body).toMatchObject({ unfurl_links: false, unfurl_media: false })
    expect(textOf(post)).toBe('Alice Park is testing Lobby notifications for this channel.')
    await expect(row.getByTestId('chat-hook-status')).toContainText('Last sent')
    expect(await alice.page.content()).not.toContain(SLACK_SECRET_PART)
    expect(foreign, 'the browser asked someone outside Lobby').toEqual([])
  } finally {
    await alice.context.close()
  }
})

test('Ben opts in; Ana mentions him; the receiver gets one POST without the comment text, and a private board is not named until the admin allows it', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  receiver.reset()
  await users.grant(board, 'bob', 'editor')
  const bob = await signedInContext(browser, 'bob')
  const alice = await signedInContext(browser, 'alice')
  try {
    await openDashboard(bob.page, users.devStudioId, 'all')
    await openChatDialog(bob.page)
    // a member has no "Channels" tab, and every kind starts off
    await expect(bob.page.getByTestId('chat-tab-channels')).toHaveCount(0)
    const hook = bob.page.getByTestId('chat-prefs-hook')
    await expect(hook).toHaveCount(1)
    for (const box of await hook.locator('input[type=checkbox]').all()) await expect(box).not.toBeChecked()
    const hookId = (await hook.getAttribute('data-hook-id')) as string
    await bob.page.getByTestId(`chat-pref-${hookId}-mention`).check()
    await bob.page.getByTestId('chat-prefs-save').click()
    await expect(bob.page.getByTestId('chat-prefs-saved')).toHaveText('Saved.')
    await closeChatDialog(bob.page)

    await mentionBen(users, board, 'The secret launch plan is attached.')
    await expect.poll(() => receiver.posts.length, { timeout: 15_000 }).toBe(1)
    const first = receiver.posts[0]
    expect(textOf(first)).toBe('Alice Park mentioned Bob Chen on a private board')
    expect(first?.raw).not.toContain('secret launch plan')
    expect(blockText(first)).toContain(`/b/${board}?thread=`)
    // one POST, not two
    await new Promise((r) => setTimeout(r, 4_000))
    expect(receiver.posts).toHaveLength(1)

    // the admin allows comment text and private titles for this channel
    await openDashboard(alice.page, users.devStudioId, 'all')
    await openChatDialog(alice.page, 'channels')
    await alice.page.getByTestId('chat-hook-edit').click()
    await alice.page.getByTestId('chat-hook-edit-text').check()
    await alice.page.getByTestId('chat-hook-edit-submit').click()
    await expect(alice.page.getByTestId('chat-hook-edit-form')).toHaveCount(0)

    const title = ((await (await users.api('alice')).getBoard(board)) as { board: { title: string } }).board
      .title
    await mentionBen(users, board, 'The secret launch plan is attached.')
    await expect.poll(() => receiver.posts.length, { timeout: 15_000 }).toBe(2)
    const second = receiver.posts[1]
    expect(textOf(second)).toBe(`Alice Park mentioned Bob Chen on ${title}`)
    const quote = blockText(second).split('\n>')[1] ?? ''
    expect(quote).toContain('The secret launch plan is attached.')
    expect([...quote].length).toBeLessThanOrEqual(140)
  } finally {
    await bob.context.close()
    await alice.context.close()
  }
})

test('Ben opts out: the next mention sends nothing', async ({ browser, board, users }) => {
  test.setTimeout(120_000)
  receiver.reset()
  await users.grant(board, 'bob', 'editor')
  const bob = await signedInContext(browser, 'bob')
  try {
    await openDashboard(bob.page, users.devStudioId, 'all')
    await openChatDialog(bob.page)
    const hookId = (await bob.page.getByTestId('chat-prefs-hook').getAttribute('data-hook-id')) as string
    const mention = bob.page.getByTestId(`chat-pref-${hookId}-mention`)
    await expect(mention).toBeChecked()
    await mention.uncheck()
    await bob.page.getByTestId('chat-prefs-save').click()
    await expect(bob.page.getByTestId('chat-prefs-saved')).toHaveText('Saved.')
    await mentionBen(users, board, 'Nothing should reach the channel.')
    await new Promise((r) => setTimeout(r, 6_000))
    expect(receiver.posts).toEqual([])
    // back on, for the tests that follow
    await mention.check()
    await bob.page.getByTestId('chat-prefs-save').click()
    await expect(bob.page.getByTestId('chat-prefs-saved')).toHaveText('Saved.')
  } finally {
    await bob.context.close()
  }
})

test('a 500 is tried again after the first backoff (30 s) and the same message arrives', async ({
  board,
  users,
}) => {
  test.setTimeout(150_000)
  receiver.reset()
  await users.grant(board, 'bob', 'editor')
  receiver.next({ status: 500, body: 'try again later' })
  await mentionBen(users, board, 'Retry me.')
  await expect.poll(() => receiver.posts.length, { timeout: 15_000 }).toBe(1)
  await expect.poll(() => receiver.posts.length, { timeout: 70_000, intervals: [1_000] }).toBe(2)
  const [first, second] = receiver.posts
  expect(second && first ? second.at - first.at : 0).toBeGreaterThanOrEqual(28_000)
  expect(textOf(second)).toBe(textOf(first))
  // no third try: the second one was accepted
  await new Promise((r) => setTimeout(r, 4_000))
  expect(receiver.posts).toHaveLength(2)
  const alice = await users.api('alice')
  const hooks = (await (
    await alice.fetch('GET', `/api/workspaces/${users.devStudioId}/chat-hooks`)
  ).json()) as {
    hooks: { lastOkAt: string | null; lastErrorCode: string | null }[]
  }
  expect(hooks.hooks[0]?.lastOkAt).not.toBeNull()
  expect(hooks.hooks[0]?.lastErrorCode).toBeNull()
})

test('a 404 switches the hook off with its reason; "Turn back on" and the next mention reaches the channel again', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(120_000)
  receiver.reset()
  await users.grant(board, 'bob', 'editor')
  const alice = await signedInContext(browser, 'alice')
  try {
    receiver.next({ status: 404 })
    await mentionBen(users, board, 'Where did the channel go?')
    await expect.poll(() => receiver.posts.length, { timeout: 15_000 }).toBe(1)
    await openDashboard(alice.page, users.devStudioId, 'all')
    await openChatDialog(alice.page, 'channels')
    const row = alice.page.getByTestId('chat-hook-row')
    await expect(row.getByTestId('chat-hook-status')).toContainText(
      'Switched off: Slack could not find the channel',
    )
    // nothing more is sent while it is off
    await mentionBen(users, board, 'Still off.')
    await new Promise((r) => setTimeout(r, 5_000))
    expect(receiver.posts).toHaveLength(1)

    await row.getByTestId('chat-hook-enable').click()
    await expect(row.getByTestId('chat-hook-enable')).toHaveCount(0)
    await mentionBen(users, board, 'Back again.')
    await expect.poll(() => receiver.posts.length, { timeout: 15_000 }).toBe(2)
    expect(textOf(receiver.posts[1])).toContain('mentioned Bob Chen')
  } finally {
    await alice.context.close()
  }
})
