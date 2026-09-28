// Wave 4 demo polish, sharing (DANA-03 / F3 / R15, F4, F9):
// - "Share with a client" is the first thing in the Share dialog: comment, 14 days, "join with just a
//   name" ticked ABOVE the one button that creates and copies the link, and the link it makes lets a
//   client in with just a name. Workshop link, invite by email and one-time links sit under a collapsed
//   "More ways to share" that opens by itself while a workshop link runs. The workshop hint says
//   "after signing in" only while guests are not allowed.
// - @mentions: someone given access while the board is open can be mentioned without a reload.
// - The Export dialog's sentence says who may export under the board's current policy.

import type { Locator } from '@playwright/test'
import { emptyCanvasPoint, newCommentPopover, pressCommentTool } from './support/comments.ts'
import {
  closeShare,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
} from './support/dashboard-share.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'

const top = async (l: Locator) => (await l.boundingBox())?.y ?? Number.NaN

test('share with a client: first in the dialog, guests on above one Create-and-copy button, and the link lets a client in with just a name; everything else is under "More ways to share"', async ({
  board,
  session,
  browser,
  users,
}) => {
  const a = await session('alice')
  const page = a.page
  await page.setViewportSize({ width: 1440, height: 900 })
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  const client = dialog.getByTestId('share-client')

  await test.step('the client block leads the dialog, in view, with the client defaults', async () => {
    await expect(dialog.locator('.dr-share > *').first()).toHaveAttribute('data-testid', 'share-client')
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

  await test.step('workshop link, invite by email and one-time links are collapsed under "More ways to share"', async () => {
    const more = dialog.getByTestId('share-more')
    await expect(more).toHaveAttribute('data-loaded', 'true')
    await expect(more).not.toHaveAttribute('open', /.*/)
    await expect(dialog.getByTestId('share-more-summary')).toHaveText(
      'Workshop link for a live session, invite by email, one-time invite links',
    )
    for (const id of ['workshop-link-create', 'share-email-input', 'invite-create'])
      await expect(dialog.getByTestId(id)).toBeHidden()
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

  await test.step('while a workshop link runs, "More ways to share" opens by itself and says so', async () => {
    await openShareFromButton(page)
    const more = dialog.getByTestId('share-more')
    await expect(more).toHaveAttribute('data-loaded', 'true')
    await expect(more).toHaveAttribute('open', '')
    await expect(dialog.getByTestId('share-more-summary')).toHaveText('1 workshop link open')
    await expect(dialog.getByTestId('workshop-link-row')).toBeVisible()
    // The person's own toggle wins after that.
    await dialog.getByTestId('share-more-toggle').click()
    await expect(more).not.toHaveAttribute('open', /.*/)
    await expect(dialog.getByTestId('workshop-link-row')).toBeHidden()
    await closeShare(page)
  })
})

test('F4: someone given access while the board is open can be @mentioned at once, without a reload', async ({
  session,
  users,
  board,
}) => {
  const a = await session('alice')
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

test('F9: the Export dialog says who may export under the current policy', async ({ session }) => {
  const a = await session('alice')
  const page = a.page
  const exportDialog = page.getByTestId('export-dialog')

  await page.getByTestId('export-button').click()
  await expect(exportDialog).toContainText('Everyone who can view the board can export it.')
  await page.keyboard.press('Escape')
  await expect(exportDialog).toHaveCount(0)

  await openShareFromButton(page)
  await shareDialog(page).getByTestId('share-export-policy-toggle').uncheck()
  await expect(shareDialog(page).getByTestId('share-export-policy')).toHaveAttribute('data-policy', 'editors')
  await closeShare(page)

  await page.getByTestId('export-button').click()
  await expect(exportDialog).toContainText(
    'Only editors can export this board: viewers, commenters and guests can’t.',
  )
  await expect(exportDialog).not.toContainText('Everyone who can view the board can export it.')
})
