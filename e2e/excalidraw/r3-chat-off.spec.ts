// Wave R (WS2): with no DRAFTROOM_WEBHOOK_SECRET chat notifications are off, whatever else is configured. The api answers
// every route 404 CHAT_HOOKS_OFF (for the owner too), the dashboard shows no entry for them, and nothing can be sent. This
// stack has the fake receiver's origin but no secret.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/r3-chat-off.spec.ts --project=chromium --workers=1
import { expect, test } from '../tests/support/canvas.ts'
import { openDashboard, signedInContext } from '../tests/support/dashboard-share.ts'
import { CHAT_API_ENV, CHAT_WEBHOOK_SECRET, slackHookUrl } from './r3-chat-kit.ts'

// the receiver's origin, but not the secret
const { DRAFTROOM_WEBHOOK_SECRET: _secret, ...WITHOUT_SECRET } = CHAT_API_ENV
test.use({ apiEnv: WITHOUT_SECRET })

test('secret unset: every route is 404 CHAT_HOOKS_OFF and the bell offers no chat notifications', async ({
  browser,
  users,
}) => {
  test.setTimeout(120_000)
  expect(CHAT_WEBHOOK_SECRET.length).toBeGreaterThan(32)
  const alice = await users.api('alice')
  const hooks = `/api/workspaces/${users.devStudioId}/chat-hooks`
  const calls: [string, string, unknown?][] = [
    ['GET', hooks],
    ['POST', hooks, { name: '#x', provider: 'slack', url: slackHookUrl('http://127.0.0.1:1') }],
    ['PATCH', `${hooks}/chk_0123456789abcdefghij`, { name: '#y' }],
    ['DELETE', `${hooks}/chk_0123456789abcdefghij`],
    ['POST', `${hooks}/chk_0123456789abcdefghij/test`, {}],
    ['GET', `/api/me/chat-prefs?workspace=${users.devStudioId}`],
    ['PUT', '/api/me/chat-prefs', { workspaceId: users.devStudioId, prefs: [] }],
  ]
  for (const [method, path, body] of calls) {
    const res = await alice.fetch(method, path, body)
    expect(res.status(), `${method} ${path}`).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CHAT_HOOKS_OFF')
  }

  const person = await signedInContext(browser, 'alice')
  try {
    await openDashboard(person.page, users.devStudioId, 'all')
    await person.page.getByTestId('dashboard-bell').click()
    await expect(person.page.getByTestId('dashboard-notifications')).toBeVisible()
    // the entry asks the api once and stays away
    await expect(person.page.getByTestId('notifications-note')).toBeVisible()
    await person.page.waitForTimeout(1_000)
    await expect(person.page.getByTestId('chat-notifications-open')).toHaveCount(0)
  } finally {
    await person.context.close()
  }
})
