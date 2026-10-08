// Wave K (K4-5): the Feedback pill and the What's new card on the dashboard, in a real browser against the real
// api. Zero real feedback items arrived in the first week; pilot users had no way to learn what wave K moved.
//   - the pill opens the existing dialog, and what is sent arrives at the api with its context and its author;
//   - the card lists its items, "Try it" goes to each place, "Tell us" opens the same dialog;
//   - dismissing the card is remembered for that person in that browser (a reload keeps it hidden; another
//     person on the browser, and a cleared storage, see it again), and a browser whose storage throws still
//     renders the page.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw k4-feedback-card
import { Api } from '../tests/support/api.ts'
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

    await test.step('Try it: the template row, the picker and the workspace menu', async () => {
      await card.locator('[data-action="start-row"]').click()
      await expect(p.page.locator('[data-testid="start-tile"]').first()).toBeFocused()
      await card.locator('[data-action="templates"]').click()
      await expect(p.page.getByTestId('create-board-dialog')).toBeVisible()
      await p.page.keyboard.press('Escape')
      await expect(p.page.getByTestId('create-board-dialog')).toHaveCount(0)
      await card.locator('[data-action="workspace-menu"]').click()
      await expect(p.page.getByTestId('workspace-menu')).toBeVisible()
      await expect(p.page.getByTestId('internal-only')).toBeVisible()
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
    // nothing about the template row or the new templates, which this person does not get
    await expect(card.locator('[data-item-id="start-row"]')).toHaveCount(0)
    await expect(card.locator('[data-item-id="agency-templates"]')).toHaveCount(0)
    await expect(card.locator('[data-action="templates"]')).toHaveCount(0)
  } finally {
    await p.context.close()
  }
})

// ---- K4-5 review: every item is true for the person, and every "Try it" does something they can see ------------

test('a plain workspace member is not sent to an Internal only control that is not theirs; once it is on, they are', async ({
  browser,
  users,
}) => {
  test.setTimeout(180_000)
  // a real member-role account: dev sign-in puts every new user into Dev Studio, which alice owns
  const p = await signedInContext(browser, freshHandle('k4w'), { name: 'Wes Member', email: CREATOR })
  const devStudio = users.devStudioId
  const alice = await users.api('alice')
  try {
    expect(p.me.workspaces.find((w) => w.id === devStudio)?.role).toBe('member')
    const settings = p.page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/workspaces/${devStudio}/internal-only`,
    )
    await openDashboard(p.page, devStudio)
    const card = p.page.getByTestId('whats-new')
    await expect(card).toBeVisible()
    const read = await settings
    expect(await read.json()).toMatchObject({ workspace: false, canChange: false })
    // the card was drawn from the same facts as the menu: the other items are there, the Internal only one is not
    await expect(card.locator('[data-item-id="start-row"]')).toBeVisible()
    await expect(card.locator('[data-item-id="workspace-menu"]')).toHaveCount(0)
    await expect(card.locator('[data-action="workspace-menu"]')).toHaveCount(0)

    await test.step('an owner turns it on: the member’s menu now shows the state, and so does the card', async () => {
      const put = await alice.fetch('PUT', `/api/workspaces/${devStudio}/internal-only`, {
        internalOnly: true,
      })
      expect(put.status(), await put.text()).toBe(200)
      await p.page.reload()
      await expect(p.page.getByTestId('workspace-internal-badge')).toBeVisible()
      const item = card.locator('[data-item-id="workspace-menu"]')
      await expect(item).toBeVisible()
      await item.getByTestId('whats-new-try').click()
      const menu = p.page.getByTestId('workspace-menu')
      await expect(menu).toBeVisible()
      // read only for a member; the keyboard went to the tile, so Escape puts it away again
      await expect(menu.getByTestId('internal-only-state')).toBeVisible()
      await expect(menu.getByTestId('internal-only-switch')).toHaveCount(0)
      await expect(p.page.getByTestId('workspace-switcher')).toBeFocused()
      await p.page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })
  } finally {
    await alice.fetch('PUT', `/api/workspaces/${devStudio}/internal-only`, { internalOnly: false })
    await p.context.close()
  }
})

test('Try it on the template row brings the row back when a search hides it; the row item is gone for someone who asked to be spared templates', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const p = await signedInContext(browser, freshHandle('k4r'), { name: 'Ro Row', email: CREATOR })
  const wid = personalWorkspace(p.me)
  try {
    await new Api(p.context.request).createBoard(wid, 'Findable board')
    await openDashboard(p.page, wid)
    const card = p.page.getByTestId('whats-new')
    const row = p.page.getByTestId('start-row')
    const search = p.page.getByTestId('dashboard-search')
    await expect(row).toBeVisible()

    await test.step('a search hides the row; the card still says it is there, and Try it shows it again', async () => {
      await search.fill('Findable')
      await expect(row).toHaveCount(0)
      await expect(card.locator('[data-item-id="start-row"]')).toBeVisible()
      await card.locator('[data-action="start-row"]').click()
      await expect(search).toHaveValue('')
      await expect(row).toBeVisible()
      await expect(p.page.locator('[data-testid="start-tile"]').first()).toBeFocused()
    })

    await test.step('for someone who hid templates there is no row, so the card does not mention it', async () => {
      await p.page.evaluate(
        (key) => localStorage.setItem(key, '1'),
        `draftroom:template-picker-hidden:${p.me.user.id}`,
      )
      await p.page.reload()
      await expect(card).toBeVisible()
      await expect(row).toHaveCount(0)
      await expect(card.locator('[data-item-id="start-row"]')).toHaveCount(0)
      // the new templates are still in the picker, and Try it opens it
      await card.locator('[data-action="templates"]').click()
      await expect(p.page.getByTestId('create-board-dialog')).toBeVisible()
    })
  } finally {
    await p.context.close()
  }
})

test('Try it on the board’s top bar opens the board they opened last and makes nothing; with no board at all it makes one tour, once', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const p = await signedInContext(browser, freshHandle('k4b'), { name: 'Bo Board', email: CREATOR })
  const wid = personalWorkspace(p.me)
  const api = new Api(p.context.request)
  try {
    await openDashboard(p.page, wid)
    expect(await api.listBoards(wid)).toHaveLength(0)

    await test.step('no board yet: a double click makes exactly one Lobby tour and opens it', async () => {
      await p.page.getByTestId('whats-new').locator('[data-action="board"]').dblclick()
      await expect(p.page).toHaveURL(/\/b\/b-[0-9a-z]{10}/, { timeout: 30_000 })
      await expect.poll(async () => (await api.listBoards(wid)).length).toBe(1)
      // give a late second request the time it would need to land
      await p.page.waitForTimeout(1500)
      const boards = await api.listBoards(wid)
      expect(boards.map((b) => b.title)).toEqual(['Lobby tour'])
    })

    await test.step('with a board: Try it opens it and creates nothing', async () => {
      const [only] = await api.listBoards(wid)
      await openDashboard(p.page, wid)
      await p.page.getByTestId('whats-new').locator('[data-action="board"]').click()
      await expect(p.page).toHaveURL(new RegExp(`/b/${only?.id}`), { timeout: 30_000 })
      await p.page.waitForTimeout(1000)
      expect(await api.listBoards(wid)).toHaveLength(1)
    })
  } finally {
    await p.context.close()
  }
})

test('on a phone, Try it on the Internal only item opens the folded menu and the workspace panel, with the keyboard on the tile', async ({
  browser,
}) => {
  const p = await signedInContext(browser, freshHandle('k4p'), {
    name: 'Pia Phone',
    email: CREATOR,
    viewport: { width: 375, height: 812 },
  })
  try {
    await openDashboard(p.page, personalWorkspace(p.me))
    const toggle = p.page.getByTestId('side-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // the tile is inside the folded menu: not there to look at yet
    await expect(p.page.getByTestId('workspace-switcher')).toBeHidden()
    await p.page
      .getByTestId('whats-new')
      .locator('[data-item-id="workspace-menu"]')
      .getByTestId('whats-new-try')
      .click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(p.page.getByTestId('workspace-menu')).toBeVisible()
    await expect(p.page.getByTestId('internal-only')).toBeVisible()
    await expect(p.page.getByTestId('workspace-switcher')).toBeFocused()
    // Escape puts the panel away first (not the whole folded menu), then the menu
    await p.page.keyboard.press('Escape')
    await expect(p.page.getByTestId('workspace-menu')).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(p.page.getByTestId('workspace-switcher')).toBeFocused()
  } finally {
    await p.context.close()
  }
})
