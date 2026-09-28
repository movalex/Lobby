// Client-facing defaults (final review round, key client-defaults):
// - DANA2-01: the first "Share with a client" link on a board whose owner never chose an export policy
//   turns exporting and original downloads off, and the client card says so ("Clients can download
//   files and export: Off", with Change taking the owner to the setting). An owner's explicit choice
//   ('everyone') is kept.
// - F2-04: with exporting off, the client's image toolbar offers no "Download original", and file
//   cards no Download.
// - DANA2-04: "Mara (Halden)" gets the initials MA, never "M(".
// - DANA-11: the "Can comment" pill uses a speech bubble, not an eye.
// - DANA2-07: a revoked guest is not offered "Go to your boards".
import { join } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { edit, fileCard, insertFiles, read, waitForBoard } from './support/board.ts'
import { closeShare, openShareFromButton, shareDialog } from './support/dashboard-share.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

const ORIGIN = { origin: WEB_URL }
const OFF_TEXT = 'The board owner turned off exporting for viewers.'
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

/** Joins with just a name through the API (the invite page is covered by guests.spec.ts). */
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

const imageIds = (page: Page) =>
  read(page, (ed) =>
    ed
      .getCurrentPageShapes()
      .filter((s) => s.type === 'image')
      .map((s) => s.id),
  ) as Promise<string[]>

/** Creates a client link from the Share dialog's primary button and returns its URL. */
async function createClientLink(page: Page): Promise<string> {
  const dialog = shareDialog(page)
  await dialog.getByTestId('review-link-create').click()
  const row = dialog.getByTestId('review-link-row')
  await expect(row).toHaveCount(1)
  return row.getByTestId('review-link-url').inputValue()
}

test('client link defaults: the first client link turns downloads and export off, the card says so, and the client gets no Download original', async ({
  session,
  browser,
  board,
}, testInfo) => {
  const a = await session('alice')
  await insertFiles(a.page, [join(FIXTURES_DIR, 'image.png'), join(FIXTURES_DIR, 'notes.zip')])
  await expect(fileCard(a.page, 'notes.zip')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await expect.poll(() => imageIds(a.page), { timeout: 30_000 }).toHaveLength(1)
  const [image] = await imageIds(a.page)
  if (!image) throw new Error('no image')
  // The owner's image toolbar has Download original (what the client must not get).
  await edit(a.page, (ed, id) => ed.select(id), image)
  await expect(a.page.getByTestId('tool.image-download')).toBeVisible()
  await edit(a.page, (ed) => ed.selectNone())

  let link = ''
  await test.step('DANA2-01: the client card says Off on a board nobody chose for, and creating the link stores it', async () => {
    await openShareFromButton(a.page)
    const dialog = shareDialog(a.page)
    const line = dialog.getByTestId('share-client-export')
    await expect(line).toHaveText('Clients can download files and export: Off Change')
    await expect(line).toHaveAttribute('data-allowed', 'false')
    const section = dialog.getByTestId('share-export-policy')
    await expect(section).toHaveAttribute('data-policy', 'everyone')
    await expect(section.getByTestId('share-export-policy-default')).toContainText(
      'Creating a client link turns this off',
    )
    await capture('client-defaults-share-before-link.png', a.page, testInfo)

    link = await createClientLink(a.page)
    await expect(section).toHaveAttribute('data-policy', 'editors')
    await expect(section.getByTestId('share-export-policy-toggle')).not.toBeChecked()
    await expect(section.getByTestId('share-export-policy-default')).toHaveCount(0)
    await expect(line).toHaveText('Clients can download files and export: Off Change')
    // Change takes the owner to the setting.
    await line.getByTestId('share-client-export-change').click()
    await expect(section.getByTestId('share-export-policy-toggle')).toBeFocused()
    await expect(section.getByTestId('share-export-policy-toggle')).toBeInViewport()
    await capture('client-defaults-share-after-change.png', a.page, testInfo)
    await dialog.getByTestId('share-client-export').scrollIntoViewIfNeeded()
    await capture('client-defaults-share-after-link.png', a.page, testInfo)
    await closeShare(a.page)
  })

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    const guest = await guestOn(context, tokenOf(link), 'Mara (Halden)')
    const g = guest.page

    await test.step('DANA2-01: the client gets 403 on originals and the archive; Export is off', async () => {
      await expect(g.getByTestId('export-button')).toHaveAttribute('aria-disabled', 'true')
      await expect(fileCard(g, 'notes.zip')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
      await expect(g.getByTestId('file-card-download')).toHaveCount(0)
      const href =
        (await fileCard(a.page, 'notes.zip').getByTestId('file-card-download').getAttribute('href')) ?? ''
      expect(href).toMatch(/\/files\/ast_\w+\/ver_\w+\/original\?board=/)
      const original = await g.request.get(href)
      expect(original.status()).toBe(403)
      expect(await original.json()).toEqual({ error: { code: 'EXPORT_DISABLED', message: OFF_TEXT } })
      expect((await g.request.get(`/api/boards/${board}/export`)).status()).toBe(403)
      expect((await a.page.request.get(href)).status()).toBe(200)
    })

    await test.step('F2-04: a selected image offers the client no Download original (no empty toolbar either)', async () => {
      await expect.poll(() => imageIds(g), { timeout: 30_000 }).toEqual([image])
      await edit(g, (ed, id) => ed.select(id), image)
      await expect.poll(() => read(g, (ed) => ed.getSelectedShapeIds())).toEqual([image])
      await expect(g.locator('.tl-container')).toHaveAttribute('data-dr-export-off', 'true')
      await expect(g.getByTestId('tool.image-download')).toBeHidden()
      await expect(g.locator('.tlui-media__toolbar')).toBeHidden()
      await capture('client-defaults-guest-image-selected.png', g, testInfo)
    })

    await test.step('DANA2-04 and DANA-11: initials MA, and a speech bubble on "Can comment"', async () => {
      await expect(
        a.page.locator(`[data-testid="presence-user"][data-user-id="${guest.id}"] button`),
      ).toHaveText('MA', { timeout: 20_000 })
      await expect(g.getByTestId('user-menu')).toContainText('MA')
      await expect(g.getByTestId('user-menu')).not.toContainText('M(')
      const pill = g.getByTestId('readonly-pill')
      await expect(pill).toHaveAttribute('data-role', 'commenter')
      await expect(pill.locator('svg')).toHaveAttribute('data-icon', 'comment')
      await capture('client-defaults-guest-topbar.png', g, testInfo)
    })

    await test.step('DANA2-07: after a revoke the guest is not offered "Go to your boards"', async () => {
      const failed: string[] = []
      g.on('response', (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`)
      })
      await openShareFromButton(a.page)
      const row = shareDialog(a.page).getByTestId('review-link-row')
      await row.getByTestId('review-link-revoke').click()
      await expect(row.getByTestId('review-link-remove-access')).toBeChecked()
      await row.getByTestId('review-link-revoke-confirm').click()
      const screen = g.getByTestId('guest-no-access').or(g.getByTestId('guest-ended'))
      await expect(screen).toBeVisible({ timeout: 15_000 })
      await expect(g.getByRole('link', { name: 'Go to your boards' })).toHaveCount(0)
      await capture('client-defaults-guest-revoked.png', g, testInfo)
      await expect(g.getByTestId('guest-ended')).toBeVisible({ timeout: 20_000 })
      await expect(g.getByRole('link', { name: 'Go to your boards' })).toHaveCount(0)
      testInfo.annotations.push({
        type: 'guest requests >= 400 after revoke',
        description: failed.join(', '),
      })
    })
  } finally {
    await context.close()
  }
})

test("client link defaults: an owner who chose 'everyone' keeps it, and the card says On", async ({
  session,
  browser,
  users,
  board,
}) => {
  const alice = await users.api('alice')
  expect(
    (await alice.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'everyone' })).status(),
  ).toBe(200)
  const a = await session('alice')
  await insertFiles(a.page, [join(FIXTURES_DIR, 'notes.zip')])
  await expect(fileCard(a.page, 'notes.zip')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  await openShareFromButton(a.page)
  const dialog = shareDialog(a.page)
  const line = dialog.getByTestId('share-client-export')
  await expect(line).toHaveText('Clients can download files and export: On Change')
  await expect(dialog.getByTestId('share-export-policy-default')).toHaveCount(0)
  const link = await createClientLink(a.page)
  await expect(dialog.getByTestId('share-export-policy')).toHaveAttribute('data-policy', 'everyone')
  await expect(line).toHaveAttribute('data-allowed', 'true')
  await closeShare(a.page)

  const context = await browser.newContext()
  try {
    const guest = await guestOn(context, tokenOf(link), 'Lee')
    await expect(fileCard(guest.page, 'notes.zip').getByTestId('file-card-download')).toBeVisible({
      timeout: 30_000,
    })
    const href =
      (await fileCard(guest.page, 'notes.zip').getByTestId('file-card-download').getAttribute('href')) ?? ''
    expect((await guest.page.request.get(href)).status()).toBe(200)
    await expect(guest.page.getByTestId('export-button')).not.toHaveAttribute('aria-disabled', 'true')
  } finally {
    await context.close()
  }
})
