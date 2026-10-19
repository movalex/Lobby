// Wave V (V2, WS3): with the api's DRAFTROOM_JOIN_CODES off, nothing of join codes shows, whatever the web switch says
// (docs/WAVE-V-CONTRACTS.md §1.2): a workshop link has no code and no "Show QR" row, the sign-in page has no "Have a
// code?", the Facilitate menu has no "Show join code", and /j/<code> says the code does not work (the api's one 404,
// as for an unknown route). The workshop link's full invite URL still lets a guest in.
import { expect, test } from '../tests/support/canvas.ts'
import { openMoreWaysToShare, openShareFromButton, shareDialog } from '../tests/support/dashboard-share.ts'
import { openFacilitate } from '../tests/support/workshops.ts'
import { waitForLobbyBoard } from './guests-kit.ts'
import { anonymous, foreignRequests, PHONE, signedIn } from './v2-kit.ts'

test.use({ apiEnv: { DRAFTROOM_JOIN_CODES: 'off' } })

test('the api’s switch off: no code, no Show QR, no Have a code?, no Show join code; /j/ says no; the invite URL still works', async ({
  browser,
  board,
}) => {
  const alice = await signedIn(browser, 'alice', 'Alice')
  const phone = await anonymous(browser, PHONE)
  try {
    const page = alice.page
    await page.goto(`/b/${board}`)
    await waitForLobbyBoard(page)
    // the Facilitate menu: the built-ins only
    const menu = await openFacilitate(page)
    await expect(menu.getByTestId('timer-pill')).toBeVisible()
    await expect(menu.getByTestId('facilitate-join-code')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // the Share dialog: a workshop link, without a code or a QR row
    await openShareFromButton(page)
    const dialog = shareDialog(page)
    await openMoreWaysToShare(page)
    await dialog.getByTestId('workshop-link-guests').check()
    await dialog.getByTestId('workshop-link-create').click()
    const row = dialog.getByTestId('workshop-link-row')
    await expect(row).toHaveCount(1)
    const url = await row.getByTestId('review-link-url').inputValue()
    await expect(dialog.getByTestId('workshop-link-qr-row')).toHaveCount(0)
    await expect(dialog.getByTestId('workshop-link-code')).toHaveCount(0)

    const foreign = foreignRequests(phone.page)
    await phone.page.goto('/signin')
    await expect(phone.page.getByTestId('signin-page')).toBeVisible()
    await expect(phone.page.getByTestId('have-a-code')).toHaveCount(0)
    await phone.page.goto('/j/ABCD-2345')
    await expect(phone.page.getByTestId('join-page')).toHaveAttribute('data-reason', 'unknown')
    // the full invite URL is unchanged
    await phone.page.goto(url)
    await phone.page.getByTestId('invite-guest-name').fill('Pat')
    await phone.page.getByTestId('invite-guest-join').click()
    await expect(phone.page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 30_000 })
    await waitForLobbyBoard(phone.page)
    expect(foreign).toEqual([])
  } finally {
    await alice.context.close()
    await phone.context.close()
  }
})
