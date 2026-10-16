// Wave R (WS2): helpers for the chat notification specs (r3-chat-*.spec.ts). The stack's api gets a webhook secret and the
// fake receiver's origin (DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: local dev only), so the suite never calls the real Slack or
// Teams. The receiver itself is e2e/tests/support/chat-hooks.ts; its port is base + 11 of this run's range.
import { expect, type Page } from '@playwright/test'
import { API_URL, HOST, PORT_BASE, WEB_URL } from '../tests/support/ports.ts'

export { type FakeReceiver, slackHookUrl, startFakeReceiver } from '../tests/support/chat-hooks.ts'

/** base + 11: inside this run's own range (next to the AI fakes on base + 3 and base + 10). */
export const CHAT_RECEIVER_PORT = PORT_BASE === null ? 5911 : PORT_BASE + 11
export const CHAT_RECEIVER_ORIGIN = `http://${HOST}:${CHAT_RECEIVER_PORT}`
export const CHAT_WEBHOOK_SECRET = 'e2e-webhook-secret-0123456789abcdefghijklmnop'

/** The api env of the chat suite's stack: the secret (hooks are off without it) and the fake receiver’s origin. */
export const CHAT_API_ENV: Record<string, string> = {
  DRAFTROOM_WEBHOOK_SECRET: CHAT_WEBHOOK_SECRET,
  DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: CHAT_RECEIVER_ORIGIN,
}

/** The secret part of the Slack URL the specs paste (slackHookUrl's default suffix): it must never be shown or sent back. */
export const SLACK_SECRET_PART = 'abcdEFGH1234'

/** Every request of `page` that leaves Lobby's own origins (none may: the e2e network assertion). */
export function foreignRequests(page: Page): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

/** Opens the "Chat notifications" dialog from the dashboard's bell (the bell opens first when its panel is shut). */
export async function openChatDialog(page: Page, tab?: 'mine' | 'channels') {
  const entry = page.getByTestId('chat-notifications-open')
  if (!(await entry.isVisible())) await page.getByTestId('dashboard-bell').click()
  await entry.click()
  const dialog = page.getByTestId('chat-notifications-dialog')
  await expect(dialog).toBeVisible()
  if (tab && (await page.getByTestId(`chat-tab-${tab}`).count())) await page.getByTestId(`chat-tab-${tab}`).click()
  return dialog
}

export async function closeChatDialog(page: Page) {
  await page.getByTestId('chat-notifications-close').click()
  await expect(page.getByTestId('chat-notifications-dialog')).toHaveCount(0)
}
