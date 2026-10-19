// Wave V (V2, WS3): a room of people joins a workshop from a QR or a short code (docs/WAVE-V-CONTRACTS.md §3).
//  - the facilitator makes a workshop link in the Share dialog: its row shows the join code and "Show QR" opens the
//    full-screen join card (the QR, the code in large type, the host, the expiry); the QR is one inline svg with
//    nothing external, made from the code's /j/ URL;
//  - a phone with no account opens that URL (what its camera would), types a name and is on the board in under 10 s
//    (measured), and no request of either page leaves Lobby's origins;
//  - "Have a code?" on the sign-in page takes the code typed in any case, with or without its dash;
//  - a code that does not work (unknown, malformed) says so on the /j/ page, with a field to type another;
//  - the Facilitate menu's "Show join code" shows the same card for the board's newest open workshop link, or offers
//    to make one.
import { expect, test } from '../tests/support/canvas.ts'
import { openMoreWaysToShare, openShareFromButton, shareDialog } from '../tests/support/dashboard-share.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { openFacilitate } from '../tests/support/workshops.ts'
import { waitForLobbyBoard } from './guests-kit.ts'
import { anonymous, CODE_DISPLAY, foreignRequests, PHONE, qrOf, signedIn } from './v2-kit.ts'

/** alice opens the board, makes a workshop link (guests by name) in the Share dialog and opens its join card. */
async function makeWorkshopLinkAndShowQr(page: import('@playwright/test').Page, board: string) {
  await page.goto(`/b/${board}`)
  await waitForLobbyBoard(page)
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  await openMoreWaysToShare(page)
  await dialog.getByTestId('workshop-link-guests').check()
  await dialog.getByTestId('workshop-link-create').click()
  await expect(dialog.getByTestId('workshop-link-row')).toHaveCount(1)
  const row = dialog.getByTestId('workshop-link-qr-row')
  await expect(row).toHaveCount(1)
  const display = (await row.getByTestId('workshop-link-code').textContent()) ?? ''
  expect(display).toMatch(CODE_DISPLAY)
  await row.getByTestId('workshop-link-show-qr').click()
  const card = page.getByTestId('join-card')
  await expect(card).toBeVisible()
  return { dialog, card, display }
}

test('a phone joins from the join card’s QR in under 10 s; the card is one inline svg; no request leaves Lobby', async ({
  browser,
  board,
}, testInfo) => {
  const alice = await signedIn(browser, 'alice', 'Alice')
  const phone = await anonymous(browser, PHONE)
  try {
    const foreignAlice = foreignRequests(alice.page)
    const { card, display } = await makeWorkshopLinkAndShowQr(alice.page, board)
    await expect(card.getByTestId('join-card-code')).toHaveText(display)
    await expect(card.getByTestId('join-card-expiry')).toHaveText(/^Expires /)
    await expect(card).toContainText(new URL(WEB_URL).host)
    // the integration: the Share dialog hands the card the board's title (the fixture names the board after the test)
    await expect(card.locator('.dr-join-card__board')).toHaveText(/^A phone joins from the join card/)
    const qr = await qrOf(card.getByTestId('join-qr'))
    expect(qr.url).toBe(`${WEB_URL}/j/${display.replace('-', '')}`)
    // presentable: the QR is most of a 860 px high window
    expect(qr.side).toBeGreaterThan(400)
    await alice.page.screenshot({ path: testInfo.outputPath('join-card.png') })
    // closed by its button; the Share dialog is still there
    await card.getByTestId('join-card-close').click()
    await expect(alice.page.getByTestId('join-card')).toHaveCount(0)
    await expect(shareDialog(alice.page)).toBeVisible()

    // The phone: what its camera opens is the QR's text.
    const foreignPhone = foreignRequests(phone.page)
    const started = Date.now()
    await phone.page.goto(qr.url)
    await expect(phone.page).toHaveURL(/\/invite\/[A-Za-z0-9_-]{43}$/, { timeout: 10_000 })
    await phone.page.getByTestId('invite-guest-name').fill('Pat')
    await phone.page.getByTestId('invite-guest-join').click()
    await expect(phone.page).toHaveURL(new RegExp(`/b/${board}$`), { timeout: 10_000 })
    await waitForLobbyBoard(phone.page)
    const ms = Date.now() - started
    testInfo.annotations.push({ type: 'join from the QR (ms)', description: String(ms) })
    console.log(`v2: a phone joined from the QR in ${ms} ms`)
    expect(ms).toBeLessThan(10_000)
    await expect(phone.page.getByTestId('user-menu')).toHaveAttribute('data-kind', 'guest')
    // Back from the board does not land on the /j/ hop (replaced), and the phone never scrolls sideways
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    )
    expect(foreignAlice).toEqual([])
    expect(foreignPhone).toEqual([])
  } finally {
    await alice.context.close()
    await phone.context.close()
  }
})

test('"Have a code?" on the sign-in page takes the code in any case and dash; a code that does not work says so on /j/', async ({
  browser,
  board,
}) => {
  const alice = await signedIn(browser, 'alice', 'Alice')
  const visitor = await anonymous(browser, { viewport: { width: 1280, height: 820 } })
  try {
    const { display } = await makeWorkshopLinkAndShowQr(alice.page, board)
    const foreign = foreignRequests(visitor.page)
    // the sign-in page: typed lower case, with a space instead of the dash
    await visitor.page.goto('/signin')
    const field = visitor.page.getByTestId('have-a-code-field')
    await expect(field).toBeVisible()
    await field.getByTestId('have-a-code-field-input').fill('x')
    await field.getByTestId('have-a-code-field-submit').click()
    await expect(field.getByRole('alert')).toHaveText(/8 letters and digits/)
    await field.getByTestId('have-a-code-field-input').fill(display.toLowerCase().replace('-', ' '))
    await field.getByTestId('have-a-code-field-submit').click()
    await expect(visitor.page).toHaveURL(/\/invite\/[A-Za-z0-9_-]{43}$/, { timeout: 15_000 })
    await expect(visitor.page.getByTestId('invite-page')).toHaveAttribute('data-allow-guests', 'true')
    // an unknown code: the /j/ page says it does not work, with a field
    await visitor.page.goto('/j/ZZZZ-ZZZZ')
    const page = visitor.page.getByTestId('join-page')
    await expect(page).toHaveAttribute('data-reason', 'unknown')
    await expect(page).toContainText('This code does not work any more')
    // typing the good one there goes on to the invite page
    await page.getByTestId('join-page-field-input').fill(display)
    await page.getByTestId('join-page-field-submit').click()
    await expect(visitor.page).toHaveURL(/\/invite\/[A-Za-z0-9_-]{43}$/, { timeout: 15_000 })
    // a malformed one is caught before asking
    await visitor.page.goto('/j/ABCU-2345')
    await expect(visitor.page.getByTestId('join-page')).toHaveAttribute('data-reason', 'malformed')
    expect(foreign).toEqual([])
  } finally {
    await alice.context.close()
    await visitor.context.close()
  }
})

test('the Facilitate menu’s Show join code: the newest open workshop link’s card, or an offer to make one', async ({
  browser,
  board,
}) => {
  const alice = await signedIn(browser, 'alice', 'Alice')
  try {
    const page = alice.page
    await page.goto(`/b/${board}`)
    await waitForLobbyBoard(page)
    // no workshop link yet: the card offers to make one
    const menu = await openFacilitate(page)
    await menu.getByTestId('facilitate-join-code').click()
    const setup = page.getByTestId('join-card-setup')
    await expect(setup.getByTestId('join-card-none')).toBeVisible()
    await setup.getByTestId('join-card-create').click()
    const card = page.getByTestId('join-card')
    await expect(card).toBeVisible()
    const code = (await card.getByTestId('join-card-code').textContent()) ?? ''
    expect(code).toMatch(CODE_DISPLAY)
    const qr = await qrOf(card.getByTestId('join-qr'))
    expect(qr.url).toBe(`${WEB_URL}/j/${code.replace('-', '')}`)
    await expect(card.locator('.dr-join-card__board')).toHaveText(/Facilitate menu/i)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('join-card')).toHaveCount(0)
    // again: the same link's card at once (the link exists now)
    await (await openFacilitate(page)).getByTestId('facilitate-join-code').click()
    await expect(page.getByTestId('join-card').getByTestId('join-card-code')).toHaveText(code)
    // the Share dialog lists that link with the same code
    await page.keyboard.press('Escape')
    await openShareFromButton(page)
    await openMoreWaysToShare(page)
    await expect(shareDialog(page).getByTestId('workshop-link-code')).toHaveText(code)
  } finally {
    await alice.context.close()
  }
})
