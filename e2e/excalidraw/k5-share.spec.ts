// K5-5 (wave K): a friendlier Share dialog on the Excalidraw board page.
//  - Invite people comes first; the start of a colleague's @handle or name (or a word of it) lists them in a
//    real suggestion list (a listbox, not a datalist) with one hint that names the person; ArrowDown /
//    ArrowUp move, Enter or a press picks, Escape closes the list and leaves the dialog open; Invite grants
//    as before (the server decides). A name that starts no one is said once.
//  - The order: Invite people, People with access (the workspace access under it), Copy board link, then
//    the collapsed "Guests and clients" (client and workshop links, invite by email, one-time links), then
//    the collapsed "Advanced" (export and download), then the workspace's members. The client card's
//    "Change" unfolds Advanced and puts the keyboard on the setting.
//  - On a 375 px phone the invite field takes the whole row (it was 82 px wide).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/k5-share.spec.ts --project=chromium --workers=1
import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import {
  closeShare,
  freshHandle,
  memberRow,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { openPhoneSession } from './a11y-kit.ts'

/** A new Dev Studio member with a name of its own (no other test types its start). */
async function colleague(browser: Browser, name: string) {
  const handle = freshHandle('k5q')
  const p = await signedInContext(browser, handle, { name })
  const id = p.me.user.id
  await p.context.close()
  return { handle, name, id }
}

const occurrences = (page: Page, text: string) =>
  shareDialog(page)
    .evaluate((d, t) => d.textContent?.split(t).length ?? 1, text)
    .then((n) => n - 1)

test('K5-5: the start of a colleague’s @handle or name lists them; one hint names them; arrows and Enter pick; Invite grants', async ({
  browser,
  canvasSession,
}, testInfo) => {
  const quinn = await colleague(browser, 'Quinn Kowalski')
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  const input = dialog.getByTestId('share-invite-input')
  const hint = dialog.getByTestId('share-invite-hint')
  const list = dialog.getByTestId('share-invite-suggestions')
  const option = list.locator(`[data-testid="share-invite-suggestion"][data-user-id="${quinn.id}"]`)

  await test.step('the dialog opens on the invite field (a desktop)', async () => {
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('role', 'combobox')
  })

  await test.step('an @handle prefix: the person is listed, and the hint names them once', async () => {
    await input.pressSequentially(`@${quinn.handle.slice(0, 6)}`)
    await expect(list).toBeVisible()
    await expect(list).toHaveAttribute('role', 'listbox')
    await expect(option).toBeVisible()
    await expect(option).toHaveAttribute('role', 'option')
    await expect(hint).toHaveText(`Pick Quinn Kowalski (@${quinn.handle}) from the list.`)
    expect(await occurrences(page, 'No one in')).toBe(0)
    await expect(input).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.locator('datalist')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('k5-5-suggestions.png') })
  })

  await test.step('a name prefix, and a word of the name: the same person', async () => {
    await input.fill('Quin')
    await expect(option).toBeVisible()
    await input.fill('kowal')
    await expect(option).toBeVisible()
    await expect(hint).toHaveText(`Pick Quinn Kowalski (@${quinn.handle}) from the list.`)
  })

  await test.step('the keyboard: the first option is active; ArrowDown and ArrowUp move; Escape closes only the list', async () => {
    await expect(option).toHaveAttribute('aria-selected', 'true')
    const activeId = await option.getAttribute('id')
    await expect(input).toHaveAttribute('aria-activedescendant', activeId ?? '')
    const n = await list.getByTestId('share-invite-suggestion').count()
    await input.press('ArrowDown')
    // one person: it wraps back onto them; more: the next one
    if (n === 1) await expect(option).toHaveAttribute('aria-selected', 'true')
    else
      await expect(list.getByTestId('share-invite-suggestion').nth(1)).toHaveAttribute(
        'aria-selected',
        'true',
      )
    await input.press('ArrowUp')
    await expect(option).toHaveAttribute('aria-selected', 'true')
    await input.press('Escape')
    await expect(list).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(input).toHaveAttribute('aria-expanded', 'false')
    await input.press('ArrowDown')
    await expect(list).toBeVisible()
  })

  await test.step('Enter picks: the field says their @handle, the hint that they get access right away', async () => {
    await input.press('Enter')
    await expect(input).toHaveValue(`@${quinn.handle}`)
    await expect(list).toHaveCount(0)
    await expect(hint).toHaveText(`Quinn Kowalski is in Dev Studio: they get access right away.`)
    // nothing was granted by picking
    await expect(memberRow(page, quinn.id)).toHaveCount(0)
  })

  await test.step('Invite grants (the server decides): they are listed with access', async () => {
    await dialog.getByTestId('share-invite-submit').click()
    await expect(dialog.getByTestId('share-invite-notice')).toContainText(
      'Quinn Kowalski can now open this board',
    )
    await expect(memberRow(page, quinn.id)).toBeVisible()
    await expect(input).toHaveValue('')
  })

  await test.step('a press on a suggestion picks too; someone already on the board says so in the hint', async () => {
    await input.fill('Quin')
    await expect(option).toContainText('has access')
    await option.click()
    await expect(input).toHaveValue(`@${quinn.handle}`)
    await expect(hint).toHaveText(
      'Quinn Kowalski already has access. Change their role under People with access.',
    )
    await dialog.getByTestId('share-invite-submit').click()
    expect(await occurrences(page, 'already has access')).toBe(1)
  })

  await test.step('a name that starts no one: "No one … matches" once, before and after Invite', async () => {
    await input.fill('Zebedee Nobody')
    await expect(hint).toHaveText('No one in Dev Studio matches. Enter their email address to invite them.')
    await dialog.getByTestId('share-invite-submit').click()
    await expect(dialog.getByTestId('share-invite-notice')).toHaveCount(0)
    expect(await occurrences(page, 'Enter their email address to invite them.')).toBe(1)
    expect(await occurrences(page, 'matches')).toBe(1)
    await closeShare(page)
  })
})

test('K5-5: the order: Invite people, People with access, Copy board link, then Guests and clients, then Advanced; Change on the client card unfolds Advanced', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  const order = await dialog
    .locator('.dr-share > [data-testid]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(order).toEqual([
    'share-invite',
    'share-people',
    'share-visibility',
    'share-copy-section',
    'share-more',
    'share-advanced',
    'workspace-members',
  ])
  // the folded ones are folded, and their summaries say what is inside
  await expect(dialog.getByTestId('share-more')).not.toHaveAttribute('open', /.*/)
  await expect(dialog.getByTestId('share-advanced')).not.toHaveAttribute('open', /.*/)
  await expect(dialog.getByTestId('share-advanced-summary')).toContainText('Export and download')
  await page.screenshot({ path: testInfo.outputPath('k5-5-order.png') })

  await test.step('the client card’s Change unfolds Advanced and puts the keyboard on the export setting', async () => {
    await openMoreWaysToShare(page)
    const change = dialog.getByTestId('share-client-export-change')
    await expect(change).toBeVisible()
    await change.click()
    await expect(dialog.getByTestId('share-advanced')).toHaveAttribute('open', '')
    await expect(dialog.getByTestId('share-export-policy-toggle')).toBeFocused()
  })
})

test('K5-5: at 375 px the invite field takes the whole row of the dialog, and the dialog does not open on it (no keyboard)', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const p = await openPhoneSession(browser, board, users, 'alice', 'owner', { width: 375, height: 812 })
  try {
    const page = p.page
    await page.getByTestId('share-button').tap()
    const dialog = shareDialog(page)
    await expect(dialog).toBeVisible()
    const input = dialog.getByTestId('share-invite-input')
    await expect(input).toBeVisible()
    const [field, content] = await Promise.all([
      input.boundingBox(),
      dialog.locator('.dr-share').boundingBox(),
    ])
    if (!field || !content) throw new Error('no boxes')
    expect(field.width).toBeGreaterThanOrEqual(content.width * 0.9)
    // the role and Invite go on the row under it, on the screen
    const submit = await dialog.getByTestId('share-invite-submit').boundingBox()
    expect((submit?.y ?? 0) >= field.y + field.height - 1).toBe(true)
    expect((submit?.x ?? 0) + (submit?.width ?? 0)).toBeLessThanOrEqual(375)
    // a touch screen: the keyboard does not pop up over the dialog as it opens
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe('share-invite-role')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('k5-5-phone-375.png') })
  } finally {
    await p.context.close()
  }
})

// K5 review (minor): a link is drawn before its automatic copy has settled (copyBounded waits up to 1.5 s);
// the role=status note said "Couldn't copy automatically" during that wait and then "Copied.", so a screen
// reader could hear the failure first. It now says nothing about the copy until the copy has settled.
test('K5-5 (review refix): while the automatic copy of a new email-locked link is pending the note says nothing about it; once it gives up it says so', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const page = a.page
  await page.setViewportSize({ width: 1280, height: 900 })
  // a copy that never answers (the window lost the focus, a permission prompt is open)
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () => new Promise<void>(() => {}),
    })
  })
  const FAILED = 'Couldn’t copy automatically'
  await openShareFromButton(page)
  const dialog = shareDialog(page)

  await test.step('Invite people: the lock note while the copy is pending, then after it gave up', async () => {
    await dialog.getByTestId('share-invite-input').fill(`k5copy-${Date.now()}@client.example.test`)
    await dialog.getByTestId('share-invite-submit').click()
    await dialog.getByTestId('outside-confirm-yes').click()
    const note = dialog.getByTestId('share-invite-lock-note')
    await expect(note).toContainText('can use this link, once, until')
    expect(await note.textContent()).not.toContain(FAILED)
    await expect(note).toContainText(FAILED, { timeout: 5000 })
  })

  await test.step('Guests and clients, a one-person link: the same', async () => {
    await openMoreWaysToShare(page)
    await dialog.getByTestId('one-person-link-email').fill(`k5copy2-${Date.now()}@client.example.test`)
    await dialog.getByTestId('invite-create').click()
    await dialog.getByTestId('outside-confirm-yes').click()
    const note = dialog.getByTestId('invite-created-note')
    await expect(note).toContainText('This link is shown only once')
    expect(await note.textContent()).not.toContain(FAILED)
    await expect(note).toContainText(FAILED, { timeout: 5000 })
  })
})
