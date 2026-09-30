// export-control on the Excalidraw board page (wave 3e; the port of ../tests/export-control.spec.ts for
// the parts 3e owns: the board's export policy store, present-export's Export, Ctrl/Cmd+P and
// Ctrl/Cmd+Shift+C, and the Share dialog's setting). The owner switches "Viewers and commenters can
// export, copy and download files" in the Share dialog; the viewer's entries follow live (no reload),
// and the api refuses the viewer's board archive and originals with 403 EXPORT_DISABLED.
//
// The context menu's Export as (present-export's entry in 3a's menu) follows the policy too. Not here (other
// owners' features, ported with them): file-card downloads (3g), Ctrl/Cmd+C and the context menu's Copy
// and its export-off line (3a: canvas-ux-menus.spec.ts), the PDF viewer and video playback (3g).
import type { Locator, Page } from '@playwright/test'
import { clickItem, expect, test } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom, readPng } from '../tests/support/present-export.ts'
import { expectItems, placeUploadedImage, seedDeck } from './present-kit.ts'

const OFF_TEXT = 'The board owner turned off exporting for viewers.'
const FRAME = { id: 'ec-frame', name: 'Moodboard', x: 0, y: 0, w: 800, h: 600 }

/** Opens the Share dialog the way the board page does (works at every width) and returns the setting. */
async function openShare(page: Page): Promise<Locator> {
  await page.evaluate(() => window.dispatchEvent(new Event('draftroom:open-share')))
  await expect(page.getByTestId('share-dialog')).toBeVisible()
  const section = page.getByTestId('share-export-policy')
  await expect(section).not.toHaveAttribute('data-policy', 'loading')
  return section
}

/** Right-clicks `id` (it is selected and the context menu opens). */
async function contextMenuOn(page: Page, id: string): Promise<Locator> {
  await clickItem(page, id, { button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  return menu
}

async function closeMenu(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
}

async function closeShare(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('share-dialog')).toHaveCount(0)
}

test('export control: the owner turns it off in Share and the viewer loses Export, the PDF shortcut, Copy as PNG and the context menu’s Export as live; originals and the archive are refused (403)', async ({
  canvasSession,
  users,
  board,
}) => {
  const a = await canvasSession('alice')
  await seedDeck(a.page, {
    frames: [FRAME],
    notes: [{ id: 'ec-note', frame: FRAME.id, x: 40, y: 40, text: 'Hi' }],
  })
  const imageId = await placeUploadedImage(a.page, users, board, FRAME, { x: 300, y: 200, w: 320, h: 180 })
  const b = await canvasSession('bob', { role: 'viewer' })
  await b.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
  await expectItems(b.page, [FRAME.id, 'ec-note', imageId])
  const file = (await b.page.evaluate(
    (id) =>
      (
        window as unknown as {
          lobbyCanvas: { get(id: string): { customData?: { lobby?: { file?: unknown } } } }
        }
      ).lobbyCanvas.get(id)?.customData?.lobby?.file,
    imageId,
  )) as { assetId: string; versionId: string }
  const href = `/files/${file.assetId}/${file.versionId}/original?board=${board}`
  const exportButton = b.page.getByTestId('export-button')

  await test.step('before: the viewer can export, open the PDF export and copy as PNG (the default)', async () => {
    await expect(exportButton).not.toHaveAttribute('aria-disabled', 'true')
    expect((await b.page.request.get(href)).status()).toBe(200)
    await clickItem(b.page, 'ec-note')
    await b.page.keyboard.press('Control+p')
    await expect(b.page.getByTestId('export-dialog')).toBeVisible()
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
    await clickItem(b.page, 'ec-note')
    await b.page.keyboard.press('Control+Shift+C')
    await expect(b.page.getByTestId('copy-png-toast')).toBeVisible()
    await contextMenuOn(b.page, imageId)
    await expect(b.page.getByTestId('context-menu-sub.export-as-button')).toBeVisible()
    await expect(b.page.getByTestId('context-menu.dr-export-off')).toHaveCount(0)
    await closeMenu(b.page)
  })

  await test.step('an open Export dialog closes the moment the owner turns exporting off', async () => {
    await exportButton.click()
    await expect(b.page.getByTestId('export-dialog')).toBeVisible()
    const section = await openShare(a.page)
    const toggle = section.getByTestId('share-export-policy-toggle')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(section).toContainText('Viewers and commenters can export, copy and download files')
    await expect(section).toContainText('This is not a data-protection feature')
    await toggle.uncheck()
    await expect(section).toHaveAttribute('data-policy', 'editors')
    await expect(toggle).not.toBeChecked()
    await closeShare(a.page)
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
    // The owner keeps every entry.
    await expect(a.page.getByTestId('export-button')).not.toHaveAttribute('aria-disabled', 'true')
  })

  await test.step('the viewer, without a reload: Export is off and says why; Ctrl+P and Ctrl+Shift+C only say so', async () => {
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await expect(exportButton).toHaveAttribute('title', OFF_TEXT)
    // aria-disabled (announced as unavailable) but still focusable and clickable, to say why.
    await exportButton.click({ force: true })
    await expect(b.page.getByTestId('export-off-notice')).toHaveText(OFF_TEXT)
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
    await clickItem(b.page, 'ec-note')
    await b.page.keyboard.press('Control+p')
    await expect(b.page.getByTestId('export-off-notice')).toHaveText(OFF_TEXT)
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
    await b.page.evaluate(() => navigator.clipboard.writeText('clipboard sentinel'))
    await clickItem(b.page, 'ec-note')
    await b.page.keyboard.press('Control+Shift+C')
    await expect(b.page.getByTestId('export-off-notice')).toHaveText(OFF_TEXT)
    await b.page.waitForTimeout(500)
    expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe('clipboard sentinel')
    // The context menu: no Export as, the one line saying why instead.
    await contextMenuOn(b.page, imageId)
    await expect(b.page.getByTestId('context-menu.dr-export-off')).toHaveText(OFF_TEXT.replace(/\.$/, ''))
    await expect(b.page.getByTestId('context-menu-sub.export-as-button')).toHaveCount(0)
    await closeMenu(b.page)
  })

  await test.step('the api refuses the viewer: the original and the archive', async () => {
    const direct = await b.page.request.get(href)
    expect(direct.status()).toBe(403)
    expect(await direct.json()).toEqual({ error: { code: 'EXPORT_DISABLED', message: OFF_TEXT } })
    const archive = await b.page.request.get(`/api/boards/${board}/export`)
    expect(archive.status()).toBe(403)
    expect((await archive.json()).error.code).toBe('EXPORT_DISABLED')
    // The owner still downloads.
    expect((await a.page.request.get(href)).status()).toBe(200)
  })

  await test.step('a fresh load keeps it off; the viewer sees the setting in Share, read-only', async () => {
    await b.page.reload()
    await expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
      timeout: 30_000,
    })
    await expect(b.page.getByTestId('export-button')).toHaveAttribute('aria-disabled', 'true')
    const section = await openShare(b.page)
    await expect(section.getByTestId('share-export-policy-toggle')).toBeDisabled()
    await expect(section.getByTestId('share-export-policy-toggle')).not.toBeChecked()
    await expect(section.getByTestId('share-export-policy-off')).toHaveText(OFF_TEXT)
    await expect(section).toContainText('Only board owners can change this.')
    await closeShare(b.page)
  })

  await test.step('the owner switches it back on: the viewer gets everything back, live', async () => {
    const section = await openShare(a.page)
    await section.getByTestId('share-export-policy-toggle').check()
    await expect(section).toHaveAttribute('data-policy', 'everyone')
    await closeShare(a.page)
    await expect(b.page.getByTestId('export-button')).not.toHaveAttribute('aria-disabled', 'true')
    expect((await b.page.request.get(href)).status()).toBe(200)
    await b.page.getByTestId('export-button').click()
    await expect(b.page.getByTestId('export-dialog')).toBeVisible()
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
    // …and the context menu's Export as, which draws the image from its original (a 2× PNG of it).
    await contextMenuOn(b.page, imageId)
    await b.page.getByTestId('context-menu-sub.export-as-button').click()
    const png = await downloadFrom(b.page, () => b.page.getByTestId('context-menu.export-as-png').click())
    expect(png.name).toMatch(/ - selection\.png$/)
    expect(readPng(png.bytes)).toMatchObject({ width: 640, height: 360 })
  })
})
