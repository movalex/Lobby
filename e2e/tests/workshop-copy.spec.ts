// Workshops and copy (docs/BACKLOG.md, second review), in real browsers:
// - R2-11: the Share dialog's retro path to an editable guest link sits right under the client card, and
//   opens the workshop link with guests let in; a commenting guest gets no badge for the workshop link;
// - R2-09: two reveals leave two automatic checkpoints named after their prompts;
// - R2-08: History's times use the same locale formatter as the link badge ("until 11:10 AM");
// - F14: a phone guest reads their own name as "(guest, you)", with no keyboard hints;
// - DANA2-07: a revoked guest reads one message, the same on both screens, with no dead-end button.
import type { BrowserContext, Page } from '@playwright/test'
import { edit, waitForBoard } from './support/board.ts'
import { commentsApi } from './support/comments.ts'
import { expect, test } from './support/fixtures.ts'
import { expectServerHasTab, openHistory } from './support/history.ts'
import { WEB_URL } from './support/ports.ts'

const ORIGIN = { origin: WEB_URL }
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/** A fresh browser (no account) that joins `token` as a name-only guest; returns its page on the board. */
async function guestOn(context: BrowserContext, token: string, name: string) {
  const res = await context.request.post(`/api/invitations/${token}/guest`, {
    headers: ORIGIN,
    data: { name },
  })
  expect(res.status(), await res.text()).toBe(201)
  const joined = (await res.json()) as { boardId: string; user: { id: string } }
  const page = await context.newPage()
  await page.goto(`/b/${joined.boardId}`)
  await waitForBoard(page)
  return { page, id: joined.user.id }
}

/**
 * How the page writes the moment `iso` as seen at the page's time `at` (ms; now when omitted), the way
 * the sharing badge (features/sharing/model.ts shortTime) and History (checkpoints-model.ts
 * checkpointTime) do: the time of day in the page's own format, whether it falls on the same local day,
 * and the date they add when it does not ("Sep 29", or "Sep 29, 2027" in another year).
 */
const whenInPage = (page: Page, iso: string, at?: number) =>
  page.evaluate(
    ([i, n]) => {
      const d = new Date(i)
      const now = n === null ? new Date() : new Date(n)
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const md = `${months[d.getMonth()]} ${d.getDate()}`
      return {
        time: d.toLocaleTimeString(undefined, { timeStyle: 'short' }),
        sameDay: d.toDateString() === now.toDateString(),
        date: d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`,
      }
    },
    [iso, at ?? null] as const,
  )

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The texts `format` gives for `iso` at any moment since `since` (ms, page time): the page drew it at
 * one of them, and within a test the local day changes at most once, so those are the day at `since`
 * and the day now. A run around midnight (a 3-hour link made after 21:00 local ends the next day, and
 * the badge then adds the date) is as correct as one at noon, and the assertion stays exact.
 */
async function drawnAs(
  page: Page,
  iso: string,
  since: number,
  format: (w: { time: string; sameDay: boolean; date: string }) => string,
): Promise<RegExp> {
  const forms = new Set([format(await whenInPage(page, iso, since)), format(await whenInPage(page, iso))])
  return new RegExp(`(?:${[...forms].map(escapeRegExp).join('|')})`)
}

test('R2-11, R2-09, R2-08: the retro link path in Share; reveals named after their prompts, in the badge’s time format', async ({
  session,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const alice = await session('alice')
  const page = alice.page
  await page.setViewportSize({ width: 1440, height: 900 })
  // Everything this test reads a time of day from is made after this moment (page time).
  const startedAt = await page.evaluate(() => Date.now())

  await test.step('R2-11: "Workshop link (guests can edit)" is in view under the client card and opens that link', async () => {
    await page.getByTestId('share-button').click()
    const dialog = page.getByTestId('share-dialog')
    await expect(dialog).toBeVisible()
    const shortcut = dialog.getByTestId('share-workshop-shortcut')
    await expect(shortcut).toBeInViewport()
    await expect(shortcut).toContainText('A client link only lets people comment')
    const [card, line] = await Promise.all([
      dialog.getByTestId('share-client').boundingBox(),
      shortcut.boundingBox(),
    ])
    expect((line?.y ?? 0) - ((card?.y ?? 0) + (card?.height ?? 0))).toBeLessThan(24) // right under it
    await expect(dialog.getByTestId('workshop-links')).toBeHidden() // behind "More ways to share"
    await shortcut.getByTestId('share-workshop-open').click()
    await expect(dialog.getByTestId('share-more')).toHaveAttribute('open', '')
    await expect(dialog.getByTestId('workshop-link-guests')).toBeChecked()
    await expect(dialog.getByTestId('workshop-link-create')).toBeFocused()
    await expect(dialog.getByTestId('workshop-link-create')).toBeInViewport()
    await expect(dialog.getByTestId('workshop-link-hint')).toContainText('with just a name or an account')
    await dialog.getByTestId('workshop-link-create').click()
    await expect(dialog.getByTestId('workshop-link-row')).toHaveCount(1)
    await expect(dialog.getByTestId('workshop-link-row')).toHaveAttribute('data-allow-guests', 'true')
    await expect(shortcut).toHaveCount(0) // the open link's section shows by itself from now on
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  const frame = { id: 'shape:wc-retro', x: 100, y: 100, w: 800, h: 500 }
  await edit(
    page,
    (editor, f) =>
      editor.createShape({
        id: f.id,
        type: 'frame',
        x: f.x,
        y: f.y,
        props: { w: f.w, h: f.h, name: 'Retro' },
      }),
    frame,
  )
  await expectServerHasTab(aliceApi, board, page)
  const pageId = await page.evaluate(() =>
    (window.editor as unknown as { getCurrentPageId(): string }).getCurrentPageId(),
  )
  for (const prompt of ['What went well?', 'What slowed us down?']) {
    const started = await aliceApi.fetch('POST', `/api/boards/${board}/private-brainstorm`, {
      prompt,
      anonymous: false,
      target: { frameId: frame.id, pageId, x: frame.x, y: frame.y, w: frame.w, h: frame.h },
    })
    expect(started.status()).toBe(201)
    const sid = ((await started.json()) as { session: { id: string } }).session.id
    const added = await aliceApi.fetch('POST', `/api/private-brainstorms/${sid}/notes`, {
      text: `${prompt} (a note)`,
      color: 'yellow',
    })
    expect(added.status()).toBe(201)
    expect((await aliceApi.fetch('POST', `/api/private-brainstorms/${sid}/reveal`)).status()).toBe(200)
    await expect(page.getByText(`${prompt} (a note)`).first()).toBeVisible({ timeout: 20_000 })
  }

  await test.step('R2-09 and R2-08: two automatic checkpoints, told apart, with times in the badge’s format', async () => {
    await openHistory(page)
    const details = page.getByTestId('checkpoint-auto')
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
      await page.getByTestId('checkpoint-auto-toggle').click()
    const rows = page.getByTestId('checkpoint-auto-row')
    await expect(rows).toHaveCount(2, { timeout: 20_000 })
    await expect(rows.nth(0)).toContainText('Before revealing private notes: “What slowed us down?”')
    await expect(rows.nth(1)).toContainText('Before revealing private notes: “What went well?”')
    const listed = (await (await aliceApi.fetch('GET', `/api/boards/${board}/snapshots`)).json()) as {
      snapshots: { createdAt: string; kind: string }[]
    }
    const auto = listed.snapshots.find((s) => s.kind === 'auto')
    // "Today 11:10 PM" (a checkpoint made a moment ago; the date form only if midnight passed since).
    await expect(rows.nth(0)).toContainText(
      await drawnAs(page, auto?.createdAt ?? '', startedAt, (w) =>
        w.sameDay ? `Today ${w.time}` : `${w.date}, ${w.time}`,
      ),
    )
    // The badge's "until …" uses the very same time format. The 3-hour link ends on another day when
    // it was made after 21:00 local; the badge then says "until Sep 29, 2:25 AM", which is right too.
    const link = (await (await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)).json()) as {
      invitations: { kind: string; role: string; expiresAt: string }[]
    }
    const workshop = link.invitations.find((i) => i.kind === 'review' && i.role === 'editor')
    await expect(page.getByTestId('share-badge')).toContainText(
      await drawnAs(page, workshop?.expiresAt ?? '', startedAt, (w) =>
        w.sameDay ? `until ${w.time}` : `until ${w.date}, ${w.time}`,
      ),
    )
  })
})

test('F14, R2-11, DANA2-07: a commenting phone guest: no link badge, "(guest, you)", no key hints; revoked, one message', async ({
  browser,
  board,
  users,
}) => {
  const aliceApi = await users.api('alice')
  expect(
    (
      await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, { role: 'editor', expiresInHours: 3 })
    ).status(),
  ).toBe(201)
  const review = (await (
    await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'commenter',
      expiresInDays: 14,
      allowGuests: true,
    })
  ).json()) as { id: string; url: string }
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  try {
    const { page } = await guestOn(ctx, tokenOf(review.url), 'Dana Whitfield')
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

    // R2-11: the workshop link's "Link: edit · until …" is not this commenter's access.
    await page.getByTestId('topbar-overflow').click()
    const menu = page.getByTestId('topbar-overflow-panel')
    await expect(menu).toHaveAttribute('data-open', 'true')
    await expect(menu).toContainText('Your account')
    await expect(page.getByTestId('share-badge')).toHaveCount(0)
    await expect(menu.locator('[data-feature="sharing"]')).toBeHidden() // no empty "Sharing" row either
    await expect(menu).not.toContainText('Link:', { useInnerText: true })
    await page.keyboard.press('Escape')

    // F14: her own comment reads "(guest, you)"; no keyboard hints on a phone.
    const guestApi = {
      fetch: (method: string, path: string, data?: unknown) =>
        ctx.request.fetch(path, { method, data, headers: ORIGIN }),
    }
    await commentsApi(guestApi as never).createThread(
      board,
      { kind: 'point', x: 200, y: 200 },
      'This ember one is the mood for the cups.',
    )
    // On a phone the rail is folded behind one button (R13).
    const railToggle = page.getByTestId('dock-rail-toggle')
    if (await railToggle.isVisible()) await railToggle.click()
    await page.getByTestId('dock-tab-comments').click()
    const panel = page.getByTestId('comments-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.dr-cpanel__check kbd')).toBeHidden()
    await panel.getByTestId('comment-row').first().click()
    const item = page.getByTestId('comment-item').first()
    await expect(item).toContainText('Dana Whitfield (guest, you)')
    await expect(item).not.toContainText('(guest) (you)')
    await expect(page.locator('.dr-ccomposer__hint')).toBeHidden()
    await expect(page.getByTestId('comment-submit')).toBeVisible()

    // DANA2-07: revoked, one message on both screens, and no button that leads nowhere.
    expect(
      (await aliceApi.fetch('POST', `/api/boards/${board}/review-links/${review.id}/revoke`)).status(),
    ).toBeLessThan(300)
    const first = page.getByTestId('guest-no-access').or(page.getByTestId('guest-ended'))
    await expect(first).toBeVisible({ timeout: 20_000 })
    const main = page.locator('main')
    const expectOneMessage = async () => {
      await expect(main.getByRole('heading', { level: 1 })).toHaveText('Your guest access has ended')
      await expect(main).toContainText('ask whoever shared the link with you for a new one')
      await expect(main.getByRole('link', { name: 'Go to your boards' })).toHaveCount(0)
      await expect(main.getByRole('button', { name: /Go to your boards|request/i })).toHaveCount(0)
      await expect(main.locator('.dr-btn')).toHaveCount(0) // only the quiet "Sign in" link
      await expect(main.getByRole('button', { name: 'Sign in' })).toBeVisible()
    }
    await expectOneMessage()
    await expect(page.getByTestId('guest-ended')).toBeVisible({ timeout: 20_000 })
    await expectOneMessage()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    await ctx.close()
  }
})
