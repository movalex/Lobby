// PORTED from e2e/tests/sharing-polish.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 2C: the Share dialog opened from this page, the guest link it makes, and the
// page's own sharing events). Wave 4 demo polish, sharing (DANA-03 / F3 / R15, F4, F9):
// - K5-5 (wave K): the dialog opens on "Invite people"; "Share with a client" sits in the collapsed
//   "Guests and clients" (with the workshop link, invite by email and one-time links), which opens by itself
//   while a client or workshop link is open (a running workshop link first): comment, 14 days, "join with just a name" ticked ABOVE the one button that
//   creates and copies the link, and the link it makes lets a client in with just a name. The workshop
//   hint says "after signing in" only while guests are not allowed. Export and download is in the collapsed
//   "Advanced".
// - @mentions: someone given access while the board is open can be mentioned without a reload (3c's
//   comment composer on this page).
// - The Export dialog's sentence says who may export under the board's current policy (3e's dialog).
//
// Differences from the tldraw spec: `canvasSession` opens the board (the facade's welcome instead of
// window.editor), and the comment steps use the ported comments kit.

import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import {
  closeShare,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
} from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { emptyCanvasPoint, newCommentPopover, pressCommentTool } from './comments-kit.ts'
import { openBoardExport } from './present-kit.ts'

const top = async (l: Locator) => (await l.boundingBox())?.y ?? Number.NaN

test('share with a client: under "Guests and clients" (Invite people leads the dialog), guests on above one Create-and-copy button, and the link lets a client in with just a name', async ({
  board,
  canvasSession,
  browser,
  users,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 1440, height: 900 })
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  const client = dialog.getByTestId('share-client')

  await test.step('K5-5: Invite people leads the dialog; the client link, the workshop link, invite by email and one-time links are collapsed under "Guests and clients"', async () => {
    await expect(dialog.locator('.dr-share > *').first()).toHaveAttribute('data-testid', 'share-invite')
    const more = dialog.getByTestId('share-more')
    await expect(more).toHaveAttribute('data-loaded', 'true')
    await expect(more).not.toHaveAttribute('open', /.*/)
    await expect(dialog.getByTestId('share-more-toggle')).toContainText('Guests and clients')
    await expect(dialog.getByTestId('share-more-summary')).toHaveText(
      'Client review link, workshop link for a live session, invite by email, one-time invite links',
    )
    for (const id of ['review-link-create', 'workshop-link-create', 'share-email-input', 'invite-create'])
      await expect(dialog.getByTestId(id)).toBeHidden()
  })

  await test.step('opened, the client block comes first in it, in view, with the client defaults', async () => {
    await openMoreWaysToShare(page)
    await expect(dialog.locator('[data-testid="share-more"] > .dr-share__section').first()).toHaveAttribute(
      'data-testid',
      'share-client',
    )
    await client.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(client).toBeInViewport({ ratio: 1 })
    await expect(client.getByRole('heading', { name: 'Share with a client' })).toBeVisible()
    await expect(client.getByTestId('review-link-role')).toHaveValue('commenter')
    await expect(client.getByTestId('review-link-expiry')).toHaveValue('14')
    const guests = client.getByTestId('review-link-guests')
    await expect(guests).toBeChecked()
    // Above the button it applies to (F3: it used to sit below Create and miss the link).
    expect(await top(guests)).toBeLessThan(await top(client.getByTestId('review-link-create')))
    await expect(client.getByTestId('review-link-hint')).toContainText('No account needed')
    await expect(client.getByTestId('review-link-hint')).not.toContainText('sign')
    await guests.uncheck()
    await expect(client.getByTestId('review-link-hint')).toContainText('They sign in to open it')
    await guests.check()
  })

  await test.step('the workshop link, invite by email and one-time links are in the same section', async () => {
    for (const id of ['workshop-link-create', 'share-email-input', 'invite-create'])
      await expect(dialog.getByTestId(id)).toBeAttached()
    await expect(dialog.getByTestId('workshop-links')).toBeVisible()
  })

  let url = ''
  await test.step('one click creates the link and copies it; it lets guests in', async () => {
    await client.getByTestId('review-link-create').click()
    const row = client.getByTestId('review-link-row')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-allow-guests', 'true')
    await expect(row.getByTestId('link-guests-allowed')).toBeVisible()
    await expect(row.getByTestId('review-link-copy')).toHaveText('Copied')
    url = await row.getByTestId('review-link-url').inputValue()
    expect(url).toMatch(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
    const aliceApi = await users.api('alice')
    const res = await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)
    const body = (await res.json()) as { invitations: { kind: string; role: string; allowGuests: boolean }[] }
    expect(body.invitations).toEqual([
      expect.objectContaining({ kind: 'review', role: 'commenter', allowGuests: true }),
    ])
  })

  await test.step('the client opening it gets the name form, not a sign-in wall', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    try {
      const p = await context.newPage()
      await p.goto(url)
      await expect(p.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
      await expect(p.getByTestId('invite-guest-name')).toBeVisible()
      await expect(p.getByTestId('invite-signin')).toHaveText('Sign in instead')
    } finally {
      await context.close()
    }
  })

  await test.step('R15: the workshop guest option sits above its Create button and the hint follows it', async () => {
    await openMoreWaysToShare(page)
    const workshop = dialog.getByTestId('workshop-links')
    const guests = workshop.getByTestId('workshop-link-guests')
    await expect(guests).not.toBeChecked() // an edit link: guests stay an explicit choice
    expect(await top(guests)).toBeLessThan(await top(workshop.getByTestId('workshop-link-create')))
    const hint = workshop.getByTestId('workshop-link-hint')
    await expect(hint).toContainText('after signing in')
    await guests.check()
    await expect(hint).toContainText('with just a name or an account')
    await expect(hint).not.toContainText('sign')
    await workshop.getByTestId('workshop-link-create').click()
    await expect(workshop.getByTestId('workshop-link-row')).toHaveAttribute('data-allow-guests', 'true')
    await closeShare(page)
  })

  await test.step('while links are open, "Guests and clients" opens by itself, says what is open, and shows the running workshop link first', async () => {
    await openShareFromButton(page)
    const more = dialog.getByTestId('share-more')
    await expect(more).toHaveAttribute('data-loaded', 'true')
    await expect(more).toHaveAttribute('open', '')
    await expect(dialog.getByTestId('share-more-summary')).toHaveText(
      '1 client link open · 1 workshop link open',
    )
    await expect(dialog.getByTestId('workshop-link-row')).toBeVisible()
    await expect(dialog.getByTestId('workshop-link-row')).toBeInViewport()
    await expect(dialog.locator('[data-testid="share-more"] > .dr-share__section').first()).toHaveAttribute(
      'data-testid',
      'workshop-links',
    )
    // The person's own toggle wins after that.
    await dialog.getByTestId('share-more-toggle').click()
    await expect(more).not.toHaveAttribute('open', /.*/)
    await expect(dialog.getByTestId('workshop-link-row')).toBeHidden()
    await closeShare(page)
  })
})

test('F4: someone given access while the board is open can be @mentioned at once, without a reload', async ({
  canvasSession,
  users,
  board,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  const dave = await users.get('dave') // a Dev Studio member without access to this board
  const bob = await users.get('bob')
  const composer = newCommentPopover(page).getByTestId('comment-composer')
  const option = (id: string) => page.locator(`[data-testid="mention-option"][data-user-id="${id}"]`)

  await test.step('the list is loaded (and dave is not on it yet)', async () => {
    await pressCommentTool(page)
    const p = await emptyCanvasPoint(page)
    await page.mouse.click(p.x, p.y)
    await composer.pressSequentially('Hi @Dav')
    await expect(page.getByTestId('mention-no-match')).toBeVisible()
    await composer.fill('')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  await test.step('alice adds dave in the Share dialog: @Dav finds him right away', async () => {
    await openShareFromButton(page)
    const dialog = shareDialog(page)
    await dialog.getByTestId('share-add-member').selectOption(dave.id)
    await dialog.getByTestId('share-add-role').selectOption('editor')
    await dialog.getByTestId('share-add-submit').click()
    await expect(dialog.locator(`[data-testid="member-row"][data-user-id="${dave.id}"]`)).toBeVisible()
    await closeShare(page)
    await pressCommentTool(page)
    const p = await emptyCanvasPoint(page)
    await page.mouse.click(p.x, p.y)
    await composer.fill('')
    await composer.pressSequentially('Hi @Dav')
    await expect(option(dave.id)).toBeVisible()
  })

  await test.step('a grant from elsewhere (the sharing.changed event) shows up in an open list, without typing', async () => {
    await composer.fill('')
    await composer.pressSequentially('Hi @Bo')
    await expect(page.getByTestId('mention-no-match')).toBeVisible()
    await users.grant(board, 'bob', 'commenter')
    await expect(option(bob.id)).toBeVisible({ timeout: 5_000 })
    await option(bob.id).click()
    await expect(composer).toHaveValue(/^Hi @Bob Chen\s?$/)
  })
})

// Since wave 4b (2F, security audit L3) the default policy's sentence says name-only guests may not export.
test('F9: the Export dialog says who may export under the current policy', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const page = a.page
  const exportDialog = page.getByTestId('export-dialog')

  await openBoardExport(page)
  await expect(exportDialog).toContainText(
    'Everyone who can view the board with an account can export it; guests who joined with just a name can’t.',
  )
  await page.keyboard.press('Escape')
  await expect(exportDialog).toHaveCount(0)

  await openShareFromButton(page)
  // K5-5: under the collapsed "Advanced", whose summary says the setting
  const advanced = shareDialog(page).getByTestId('share-advanced')
  await expect(advanced).not.toHaveAttribute('open', /.*/)
  await expect(shareDialog(page).getByTestId('share-advanced-summary')).toHaveText(
    'Export and download: everyone with an account',
  )
  await shareDialog(page).getByTestId('share-advanced-toggle').click()
  await shareDialog(page).getByTestId('share-export-policy-toggle').uncheck()
  await expect(shareDialog(page).getByTestId('share-advanced-summary')).toHaveText(
    'Export and download: editors and owners only',
  )
  await expect(shareDialog(page).getByTestId('share-export-policy')).toHaveAttribute('data-policy', 'editors')
  await closeShare(page)

  await openBoardExport(page)
  await expect(exportDialog).toContainText(
    'Only editors can export this board: viewers, commenters and guests can’t.',
  )
  await expect(exportDialog).not.toContainText(
    'Everyone who can view the board with an account can export it; guests who joined with just a name can’t.',
  )
})

// PORTED from e2e/tests/workshop-copy.spec.ts (its first test, the sharing half): the Share dialog's retro path
// and the link badge's time. Its reveals' automatic checkpoints (R2-09, History's rows) are 3f's and 3h's.

/** How the page writes the moment `iso` at the page's time `at` (ms; now when omitted), as the badge does. */
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

/** The texts `format` gives for `iso` at any moment since `since` (a run across midnight stays exact). */
async function drawnAs(
  page: Page,
  iso: string,
  since: number,
  format: (w: { time: string; sameDay: boolean; date: string }) => string,
): Promise<RegExp> {
  const forms = new Set([format(await whenInPage(page, iso, since)), format(await whenInPage(page, iso))])
  return new RegExp(`(?:${[...forms].map(escapeRegExp).join('|')})`)
}

test('R2-11, R2-08: the retro link path in Share opens the workshop link with guests let in; the badge says until when, in the page’s time format', async ({
  board,
  canvasSession,
  users,
}) => {
  const aliceApi = await users.api('alice')
  const alice = await canvasSession('alice')
  const page = alice.page
  await page.setViewportSize({ width: 1440, height: 900 })
  const startedAt = await page.evaluate(() => Date.now())

  await test.step('R2-11: "Workshop link (guests can edit)" sits right under the client card in "Guests and clients" and gets that link ready', async () => {
    await page.getByTestId('share-button').click()
    const dialog = page.getByTestId('share-dialog')
    await expect(dialog).toBeVisible()
    await openMoreWaysToShare(page)
    const shortcut = dialog.getByTestId('share-workshop-shortcut')
    await shortcut.scrollIntoViewIfNeeded()
    await expect(shortcut).toBeInViewport()
    await expect(shortcut).toContainText('A client link only lets people comment')
    const [card, line] = await Promise.all([
      dialog.getByTestId('share-client').boundingBox(),
      shortcut.boundingBox(),
    ])
    expect((line?.y ?? 0) - ((card?.y ?? 0) + (card?.height ?? 0))).toBeLessThan(24) // right under it
    await expect(dialog.getByTestId('workshop-link-guests')).not.toBeChecked()
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

  await test.step('R2-08: the board page’s link badge says until when, in the page’s own time format', async () => {
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

// G2 (found on staging, owner in Brave with the window not focused): with a workshop link already open, a
// second "Create workshop link" stayed on "Creating…" for good although the api answered 201 in 12 ms. The
// dialog awaited navigator.clipboard.writeText before it showed the new link, and that call can reject (no
// permission, no focus) or never settle at all. The link and the button must not depend on it.
test('G2: Create never waits on the clipboard: a write that never answers or is refused still lists the link, frees the button, and says how to copy it (K5-5 words)', async ({
  board,
  canvasSession,
  users,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 1440, height: 900 })
  const aliceApi = await users.api('alice')
  const dialog = () => shareDialog(page)

  /** What the next clipboard write does: never answers, refuses (like an unfocused window), or works. */
  const stubClipboard = (mode: 'never' | 'refuse' | 'ok') =>
    page.evaluate((m) => {
      const w = window as unknown as { __copied?: string[] }
      w.__copied = []
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: (text: string) => {
          if (m === 'never') return new Promise<void>(() => {})
          if (m === 'refuse')
            return Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'))
          w.__copied?.push(text)
          return Promise.resolve()
        },
      })
    }, mode)
  const serverLinks = async () =>
    (
      (await (await aliceApi.fetch('GET', `/api/boards/${board}/invitations`)).json()) as {
        invitations: { kind: string; role: string }[]
      }
    ).invitations.filter((i) => i.kind === 'review' && i.role === 'editor')

  await openShareFromButton(page)
  await openMoreWaysToShare(page)
  const workshop = dialog().getByTestId('workshop-links')
  const create = workshop.getByTestId('workshop-link-create')
  const status = workshop.getByTestId('workshop-link-status')
  const rows = workshop.getByTestId('workshop-link-row')

  await test.step('the first link: a write that never answers does not hold "Creating…"', async () => {
    await stubClipboard('never')
    await create.click()
    // The link is listed and the button is free again while the copy is still unanswered (the copy is
    // given up after a moment: share-copy.ts), then the dialog says it could not copy.
    await expect(rows).toHaveCount(1)
    await expect(create).toHaveText('Create workshop link')
    await expect(create).not.toHaveAttribute('aria-busy', 'true')
    await expect(rows.first().getByTestId('review-link-url')).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/)
    await expect(rows.first().getByTestId('review-link-copy-failed')).toHaveText(
      'Couldn’t copy automatically. Press Copy, or select the link and copy it.',
    )
    await expect(status).toHaveText(
      'Workshop link created. It couldn’t be copied automatically: press Copy in the list below.',
    )
    await expect(rows.first().getByTestId('review-link-copy')).toHaveText('Copy')
    expect(await serverLinks()).toHaveLength(1)
  })

  await test.step('a second link with one already open (the staging case), the write refused: listed, free, told', async () => {
    await stubClipboard('refuse')
    await create.click()
    await expect(rows).toHaveCount(2)
    await expect(create).toHaveText('Create workshop link')
    await expect(create).not.toHaveAttribute('aria-busy', 'true')
    await expect(workshop.getByTestId('review-link-copy-failed')).toHaveCount(2)
    await expect(status).toContainText('couldn’t be copied automatically')
    expect(await serverLinks()).toHaveLength(2)
  })

  await test.step('Copy on a row works once the browser lets it, and the note goes away', async () => {
    await stubClipboard('ok')
    const row = rows.nth(0)
    const url = await row.getByTestId('review-link-url').inputValue()
    await row.getByTestId('review-link-copy').click()
    await expect(row.getByTestId('review-link-copy')).toHaveText('Copied')
    await expect(row.getByTestId('review-link-copy-failed')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied)).toEqual([url])
    // the other row is untouched
    await expect(rows.nth(1).getByTestId('review-link-copy-failed')).toBeVisible()
  })

  await test.step('a Copy that never answers says so too (no silent button)', async () => {
    await stubClipboard('never')
    const row = rows.nth(1)
    await row.getByTestId('review-link-copy').click()
    await expect(row.getByTestId('review-link-copy-failed')).toBeVisible()
    await expect(row.getByTestId('review-link-copy')).toHaveText('Copy')
  })

  await test.step('the client link behaves the same (it shares the flow)', async () => {
    await closeShare(page)
    await openShareFromButton(page)
    await openMoreWaysToShare(page)
    const client = dialog().getByTestId('share-client')
    await stubClipboard('never')
    await client.getByTestId('review-link-create').click()
    await expect(client.getByTestId('review-link-row')).toHaveCount(1)
    await expect(client.getByTestId('review-link-create')).toHaveText('Create and copy link')
    await expect(client.getByTestId('review-link-status')).toHaveText(
      'Client link created. It couldn’t be copied automatically: press Copy in the list below.',
    )
    await expect(client.getByTestId('review-link-copy-failed')).toBeVisible()
  })
})
