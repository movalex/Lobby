// Wave K (K4-5): the Feedback pill and the What's new card on the dashboard, in a real browser against the real
// api. Zero real feedback items arrived in the first week; pilot users had no way to learn what wave K moved.
//   - the pill opens the existing dialog, and what is sent arrives at the api with its context and its author;
//   - the card lists its items, "Tell us" opens the same dialog (wave M, M3-3: the card is wave L's now, its "Try it" of each item
//     is m3-whats-new.spec.ts; the wave K items and their Try it tests went with them);
//   - dismissing the card is remembered for that person in that browser (a reload keeps it hidden; another
//     person on the browser, and a cleared storage, see it again), and a browser whose storage throws still
//     renders the page.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-feedback-card
import { expect, test } from '../tests/support/canvas.ts'
import {
  freshHandle,
  openDashboard,
  personalWorkspace,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { capture } from '../tests/support/screenshots.ts'

// alice is the first dev user and the only inbox reader (the same set-up as feedback.spec.ts)
test.use({ apiEnv: { DRAFTROOM_FEEDBACK_ADMINS: 'alice@dev.invalid' } })
test.use({ viewport: { width: 1360, height: 860 } })

const CREATOR = 'lobby-test-k4f@darkburn.com'

test('the Feedback pill opens the dialog and one item reaches the api; the What’s new card dismisses and stays dismissed', async ({
  browser,
  users,
}, testInfo) => {
  test.setTimeout(180_000)
  const p = await signedInContext(browser, freshHandle('k4f'), { name: 'Fay Feedback', email: CREATOR })
  const wid = personalWorkspace(p.me)
  const marker = `k4 pill ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  try {
    await openDashboard(p.page, wid)
    const card = p.page.getByTestId('whats-new')
    const pill = p.page.getByTestId('feedback-pill')

    await test.step('the card lists three to five items with a way to try each, and a Tell us button', async () => {
      await expect(card).toBeVisible()
      const items = card.getByTestId('whats-new-item')
      expect(await items.count()).toBeGreaterThanOrEqual(3)
      expect(await items.count()).toBeLessThanOrEqual(5)
      expect(await card.getByTestId('whats-new-try').count()).toBeGreaterThanOrEqual(3)
      await expect(card.getByTestId('whats-new-tell-us')).toHaveText('Tell us')
      await expect(pill).toBeVisible()
      await capture('k4-whats-new.png', p.page, testInfo)
    })

    await test.step('each Try it goes to a board with a hint (wave L, M3-3: m3-whats-new.spec.ts follows them)', async () => {
      expect(
        await card
          .getByTestId('whats-new-try')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-action'))),
      ).toEqual([
        'board-hint:palette',
        'board-hint:ask',
        'board-hint:diagram',
        'board-hint:time-travel',
        'board-hint:run-of-show',
      ])
    })

    await test.step('Tell us opens the feedback dialog, and Escape closes it', async () => {
      await card.getByTestId('whats-new-tell-us').click()
      await expect(p.page.getByTestId('feedback-dialog')).toBeVisible()
      await p.page.keyboard.press('Escape')
      await expect(p.page.getByTestId('feedback-dialog')).toHaveCount(0)
    })

    await test.step('the pill opens the dialog; sending it posts one item, with the page and the author from the session', async () => {
      await pill.click()
      const dialog = p.page.getByTestId('feedback-dialog')
      await expect(dialog).toBeVisible()
      await expect(p.page.getByTestId('feedback-context-page')).toContainText(`/w/${wid}`)
      await expect(p.page.getByTestId('feedback-context-board')).toHaveCount(0)
      await p.page.getByTestId('feedback-text').fill(`${marker}: the row is easy to find`)
      await p.page.getByTestId('feedback-submit').click()
      await expect(p.page.getByTestId('feedback-sent')).toBeVisible()
      await p.page.getByTestId('feedback-close').click()
      await expect(dialog).toHaveCount(0)
      await expect(pill).toBeFocused()

      const alice = await users.api('alice')
      const res = await alice.request.get(`${WEB_URL}/api/feedback?status=all&limit=200`)
      expect(res.status(), await res.text()).toBe(200)
      const list = (await res.json()) as {
        items: { userId: string; kind: string; text: string; context: Record<string, unknown> }[]
      }
      const sent = list.items.filter((i) => i.text.startsWith(marker))
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ userId: p.me.user.id, kind: 'account' })
      expect(String(sent[0]?.context.path)).toBe(`/w/${wid}`)
    })

    await test.step('Dismiss: the card goes, a reload keeps it gone, the pill stays', async () => {
      await card.getByTestId('whats-new-dismiss').click()
      await expect(card).toHaveCount(0)
      await p.page.reload()
      await expect(p.page.getByTestId('dashboard')).toBeVisible()
      await expect(p.page.getByTestId('whats-new')).toHaveCount(0)
      await expect(p.page.getByTestId('feedback-pill')).toBeVisible()
    })

    await test.step('it is remembered for this person: a cleared storage shows it again', async () => {
      await p.page.evaluate(() => localStorage.clear())
      await p.page.reload()
      await expect(p.page.getByTestId('whats-new')).toBeVisible()
    })
  } finally {
    await p.context.close()
  }
})

test('a browser whose storage throws still renders the dashboard, with the card', async ({ browser }) => {
  const p = await signedInContext(browser, freshHandle('k4t'), { name: 'Tess Throws', email: CREATOR })
  try {
    // a private window or blocked site data: touching localStorage throws
    await p.context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError')
        },
      })
    })
    await openDashboard(p.page, personalWorkspace(p.me))
    await expect(p.page.getByTestId('dashboard')).toBeVisible()
    await expect(p.page.getByTestId('whats-new')).toBeVisible()
    await p.page.getByTestId('whats-new-dismiss').click()
    // it goes for now; nothing could be remembered
    await expect(p.page.getByTestId('whats-new')).toHaveCount(0)
    await expect(p.page.getByTestId('feedback-pill')).toBeVisible()
  } finally {
    await p.context.close()
  }
})

test('the card is not shown to a person who cannot create, and what it shows is true for them', async ({
  browser,
}) => {
  const p = await signedInContext(browser, freshHandle('k4m'), { name: 'Mo Member', email: CREATOR })
  try {
    // a member who may not create (the UI hides what they cannot use; the api still decides)
    const outside = { creator: false, reason: 'outside', email: 'client@client.example.test' }
    for (const url of ['**/api/auth/me', '**/api/me'])
      await p.page.route(url, async (route) => {
        const res = await route.fetch()
        if (res.status() !== 200) return route.fulfill({ response: res })
        const body = (await res.json()) as Record<string, unknown>
        return route.fulfill({ response: res, json: { ...body, access: outside } })
      })
    await openDashboard(p.page, personalWorkspace(p.me))
    const card = p.page.getByTestId('whats-new')
    await expect(card).toBeVisible()
    // wave L: what a person who cannot create can use is the palette, Ask and Time travel; the items that build on
    // a board (diagrams, the run of show) are for people who can make boards
    expect(
      await card
        .getByTestId('whats-new-item')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-item-id'))),
    ).toEqual(['palette', 'ask', 'time-travel'])
  } finally {
    await p.context.close()
  }
})
