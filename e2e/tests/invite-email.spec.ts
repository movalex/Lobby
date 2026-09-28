// Invite by email in the Share dialog. The e2e stack signs people in with the development provider,
// which sends no email, so every email invitation here comes back as the "Couldn’t email — copy
// this link instead" fallback: this file drives that path end to end (the form, its announced
// errors, the clipboard, what the server stored, and the invitee joining through the link, once, as
// the role picked). The Clerk paths (added at once / emailed) are API-tested with a fake Clerk client
// in apps/api/test/features/dashboard/email-invites.test.ts.
import { read, signInThroughUi, waitForBoard } from './support/board.ts'
import {
  freshHandle,
  invitations,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
} from './support/dashboard-share.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'

const INVITE_LINK = new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`)

test('invite by email without Clerk: a wrong address is refused at the field, then a one-time link to copy that works once, as the role picked', async ({
  board,
  users,
  session,
  browser,
}) => {
  const aliceApi = await users.api('alice')
  const a = await session('alice')
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
  await openShareFromButton(a.page)
  await openMoreWaysToShare(a.page) // DANA-03: invite by email is under "More ways to share"
  const dialog = shareDialog(a.page)
  const section = dialog.getByTestId('share-email-section')
  const input = section.getByTestId('share-email-input')

  await test.step('the form is labelled and says this server cannot send email', async () => {
    await expect(section.getByRole('heading', { name: 'Invite by email' })).toBeVisible()
    await expect(section.getByLabel('Email address to invite')).toBeVisible()
    await expect(section.getByLabel('Role for the person you email')).toHaveValue('commenter')
    await expect(section.getByTestId('share-email-hint')).toHaveText(
      'This server can’t send email (that needs Clerk sign-in): you get a one-time link to send them instead.',
    )
    await expect(section.getByTestId('share-email-submit')).toHaveText('Send invite')
  })

  await test.step('a wrong address: the error is announced and tied to the field, nothing is created', async () => {
    await input.fill('sam@')
    await section.getByTestId('share-email-submit').click()
    const error = section.getByTestId('share-email-error')
    await expect(error).toHaveText('Enter a valid email address.')
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    const errorId = await error.getAttribute('id')
    expect((await input.getAttribute('aria-describedby'))?.split(' ')).toContain(errorId)
    await expect(input).toBeFocused()
    expect(await invitations(aliceApi, board)).toEqual([])
    // Typing again clears the error.
    await input.pressSequentially('client')
    await expect(error).toHaveCount(0)
    await expect(input).not.toHaveAttribute('aria-invalid', 'true')
  })

  let link = ''
  await test.step('Send invite: “Couldn’t email — copy this link instead”, with the link and a copy button', async () => {
    await input.fill('  Sam@Client.example ')
    await section.getByTestId('share-email-role').selectOption('viewer')
    await section.getByTestId('share-email-submit').click()
    const result = section.getByTestId('share-email-result')
    await expect(result).toHaveAttribute('data-mode', 'link')
    await expect(result).toContainText('Couldn’t email — copy this link instead.')
    await expect(result).toContainText(
      'This server can’t send email: that needs Clerk sign-in. Send the link to sam@client.example yourself.',
    )
    await expect(result).toContainText('It works once, as “Can view”, until')
    // The outcome sits in a live region, so screen readers announce it.
    await expect(section.getByRole('status')).toContainText('Couldn’t email — copy this link instead.')
    await expect(input).toHaveValue('')

    const field = section.getByTestId('share-email-link')
    await expect(field).toHaveValue(INVITE_LINK)
    link = await field.inputValue()
    await expect(section.getByTestId('share-email-copy')).toHaveText('Copy link')
    await section.getByTestId('share-email-copy').click()
    await expect(section.getByTestId('share-email-copy')).toHaveText('Copied')
    expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(link)
  })

  await test.step('the server holds one unused single-use viewer link, listed in the dialog', async () => {
    expect(await invitations(aliceApi, board)).toEqual([
      expect.objectContaining({ kind: 'invite', role: 'viewer', uses: 0, url: null }),
    ])
    await expect(dialog.getByTestId('invitation-row')).toHaveCount(1)
    await expect(dialog.getByTestId('invitation-row')).toContainText('Can view')
    // No one got access by the invitation alone.
    const alice = await users.get('alice')
    expect((await aliceApi.members(board)).map((m) => m.user.id)).toEqual([alice.id])
  })

  const sam = { handle: freshHandle('sam'), name: 'Sam Client' }
  await test.step('the invitee opens the link, signs in and joins as exactly “Can view”', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(link)
      await expect(page.getByTestId('invite-page')).toBeVisible()
      await expect(page.getByTestId('invite-role-label')).toHaveText('Can view')
      await page.getByTestId('invite-signin').click()
      await signInThroughUi(page, sam)
      await expect(page).toHaveURL(new RegExp(`/b/${board}$`))
      await waitForBoard(page)
      await expect(page.getByTestId('readonly-pill')).toHaveAttribute('data-role', 'viewer')
      expect(await read(page, (ed) => ed.getIsReadonly())).toBe(true)
    } finally {
      await context.close()
    }
    const members = await aliceApi.members(board)
    expect(members.find((m) => m.user.name === sam.name)).toMatchObject({ role: 'viewer', source: 'grant' })
    expect(await invitations(aliceApi, board)).toEqual([])
  })

  await test.step('used once: the next person to open it is told it is no longer valid', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(link)
      await expect(page.getByTestId('invite-invalid')).toContainText('This invitation is no longer valid')
    } finally {
      await context.close()
    }
  })
})

test('invite by email: only people who manage access get the form', async ({ session }) => {
  const b = await session('bob', { role: 'editor' })
  await openShareFromButton(b.page)
  const dialog = shareDialog(b.page)
  await expect(dialog.getByTestId('member-list')).toBeVisible()
  await expect(dialog.getByTestId('share-email-section')).toHaveCount(0)
})
