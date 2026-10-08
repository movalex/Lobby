// export-control on the Excalidraw board page (wave 3e; the port of ../tests/export-control.spec.ts for
// the parts 3e owns: the board's export policy store, present-export's Export, Ctrl/Cmd+P and
// Ctrl/Cmd+Shift+C, and the Share dialog's setting). The owner switches "Viewers and commenters can
// export, copy and download files" in the Share dialog; the viewer's entries follow live (no reload),
// and the api refuses the viewer's board archive and originals with 403 EXPORT_DISABLED.
//
// The context menu's Export as (present-export's entry in 3a's menu) follows the policy too, and so do
// 3g's file cards (the second test: Download goes, previews, PDF pages, the page viewer and video playback
// stay). Not here: Ctrl/Cmd+C and the context menu's Copy and its export-off line (3a's,
// canvas-ux-menus.spec.ts).
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { clickItem, expect, test, waitForCanvas, zoomToFit } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom, readPng } from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { fileCard, insertFiles } from './media-kit.ts'
import { expectItems, openBoardExport, placeUploadedImage, seedDeck } from './present-kit.ts'

const OFF_TEXT = 'The board owner turned off exporting for viewers.'
const fixture = (name: string) => join(FIXTURES_DIR, name)
const FILES = ['document.pdf', 'notes.zip', 'video.mp4'] as const
const ORIGINAL = /\/files\/ast_\w+\/ver_\w+\/original\?board=/
const FRAME = { id: 'ec-frame', name: 'Moodboard', x: 0, y: 0, w: 800, h: 600 }

/** Opens the Share dialog the way the board page does (works at every width) and returns the setting. */
async function openShare(page: Page): Promise<Locator> {
  await page.evaluate(() => window.dispatchEvent(new Event('draftroom:open-share')))
  await expect(page.getByTestId('share-dialog')).toBeVisible()
  // K5-5: the setting is under the collapsed "Advanced"
  const advanced = page.getByTestId('share-advanced')
  if ((await advanced.getAttribute('open')) === null) await page.getByTestId('share-advanced-toggle').click()
  await expect(advanced).toHaveAttribute('open', '')
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
  // K3-3: no Export icon in the top bar: Board menu > Export holds Export... while exporting is on, and the
  // line saying why while it is off
  const exportMenu = async (page: typeof b.page) => {
    await page.getByTestId('main-menu.button').click()
    await page.getByTestId('main-menu-sub.export-button').click()
    const on = (await page.getByTestId('main-menu.export-dialog').count()) > 0
    const off = (await page.getByTestId('main-menu.dr-export-off').count()) > 0
    // the button closes the whole menu (Escape would close the submenu first)
    await page.getByTestId('main-menu.button').click()
    await expect(page.getByTestId('main-menu-root')).toHaveCount(0)
    return on && !off ? 'on' : off && !on ? 'off' : 'unknown'
  }

  await test.step('before: the viewer can export, open the PDF export and copy as PNG (the default)', async () => {
    await expect.poll(() => exportMenu(b.page)).toBe('on')
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
    await openBoardExport(b.page)
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
    await expect.poll(() => exportMenu(a.page)).toBe('on')
  })

  await test.step('the viewer, without a reload: Export is off and says why; Ctrl+P and Ctrl+Shift+C only say so', async () => {
    await expect.poll(() => exportMenu(b.page)).toBe('off')
    // the board menu's line says why when chosen
    await b.page.getByTestId('main-menu.button').click()
    await b.page.getByTestId('main-menu-sub.export-button').click()
    await b.page.getByTestId('main-menu.dr-export-off').click()
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
    await expect.poll(() => exportMenu(b.page)).toBe('off')
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
    await expect.poll(() => exportMenu(b.page)).toBe('on')
    expect((await b.page.request.get(href)).status()).toBe(200)
    await openBoardExport(b.page)
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

test('export control on file cards: the viewer’s Download goes and comes back live; previews, PDF pages, the page viewer (Download shown off) and video playback keep working', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'viewer' })
  await insertFiles(a.page, FILES.map(fixture))
  for (const s of [a, b]) {
    for (const name of FILES)
      await expect(fileCard(s.page, name)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await zoomToFit(s.page)
  }
  const downloads = (page: Page) => page.getByTestId('file-card-download')
  const href =
    (await fileCard(b.page, 'notes.zip').getByTestId('file-card-download').getAttribute('href')) ?? ''
  expect(href).toMatch(ORIGINAL)

  await test.step('before: the viewer has every card’s Download (the default)', async () => {
    await expect(downloads(b.page)).toHaveCount(FILES.length)
    expect((await b.page.request.get(href)).status()).toBe(200)
  })

  await test.step('the owner turns it off: the viewer’s Downloads go, live; the owner keeps hers', async () => {
    const section = await openShare(a.page)
    await section.getByTestId('share-export-policy-toggle').uncheck()
    await expect(section).toHaveAttribute('data-policy', 'editors')
    await closeShare(a.page)
    await expect(downloads(b.page)).toHaveCount(0)
    await expect(downloads(a.page)).toHaveCount(FILES.length)
    expect((await b.page.request.get(href)).status()).toBe(403)
  })

  await test.step('previews, PDF pages, the page viewer and video playback keep working for the viewer (fresh load too)', async () => {
    await b.page.reload()
    await waitForCanvas(b.page)
    await expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
      timeout: 30_000,
    })
    const pdf = fileCard(b.page, 'document.pdf')
    await expect(pdf).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
    await zoomToFit(b.page)
    await expect(downloads(b.page)).toHaveCount(0)
    const cover = pdf.getByTestId('file-card-preview')
    await expect.poll(() => cover.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const pageSrc =
      (await pdf.locator('[data-testid="file-card-strip"] img').first().getAttribute('src')) ?? ''
    expect((await b.page.request.get(pageSrc)).status()).toBe(200)

    // The page viewer shows its pages; "Download original" is shown turned off.
    await pdf.getByTestId('file-card-view-pages').click()
    const viewer = b.page.getByTestId('pdf-viewer')
    await expect(viewer).toBeVisible()
    await expect(viewer.getByTestId('pdf-viewer-download')).toHaveCount(0)
    await expect(viewer.getByTestId('pdf-viewer-download-off')).toHaveAttribute('aria-disabled', 'true')
    await expect
      .poll(() =>
        viewer.getByTestId('pdf-viewer-page').evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0)
    await viewer.getByTestId('pdf-viewer-close').click()
    await expect(viewer).toHaveCount(0)

    // The video card still plays: its <video> loads the original as a media element, without a download.
    const video = fileCard(b.page, 'video.mp4')
    const media = b.page.waitForResponse(
      (r) => ORIGINAL.test(r.url()) && r.request().resourceType() === 'media',
    )
    await video.getByTestId('file-card-play').click()
    expect([200, 206]).toContain((await media).status())
    await expect(video.getByTestId('file-card-video')).toHaveAttribute('controlslist', 'nodownload')
  })

  await test.step('the owner switches it back on: the viewer’s Downloads come back, live', async () => {
    const section = await openShare(a.page)
    await section.getByTestId('share-export-policy-toggle').check()
    await expect(section).toHaveAttribute('data-policy', 'everyone')
    await closeShare(a.page)
    await expect(downloads(b.page)).toHaveCount(FILES.length)
    expect((await b.page.request.get(href)).status()).toBe(200)
  })
})
