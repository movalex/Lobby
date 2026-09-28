// export-control (docs/WAVE3-CONTRACTS.md): the per-board "Viewers and commenters can export, copy and
// download files" setting. The owner switches it in the Share dialog; the viewer's Export button, file
// downloads, copy and the menus' copy/export entries follow live (no reload), the api refuses the
// viewer's original downloads and board archive with 403 EXPORT_DISABLED, and previews, PDF pages and
// video playback keep working. Checked in light and dark and at phone width (390 px).

import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { edit, fileCard, insertFiles, read, shapeCenterOnScreen } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR } from './support/stack.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
const FILES = ['document.pdf', 'notes.zip', 'video.mp4'] as const
const ORIGINAL = /\/files\/ast_\w+\/ver_\w+\/original\?board=/
const OFF_TEXT = 'The board owner turned off exporting for viewers.'

/** Opens the Share dialog the way the board page does (works at every width) and returns the setting. */
async function openShare(page: Page): Promise<Locator> {
  await page.evaluate(() => window.dispatchEvent(new Event('draftroom:open-share')))
  await expect(page.getByTestId('share-dialog')).toBeVisible()
  const section = page.getByTestId('share-export-policy')
  await expect(section).not.toHaveAttribute('data-policy', 'loading')
  return section
}

async function closeShare(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('share-dialog')).toHaveCount(0)
}

/** The file cards on the board, by name. */
const cardIds = (page: Page) =>
  read(page, (ed) =>
    Object.fromEntries(
      ed
        .getCurrentPageShapes()
        .filter((s) => s.type === 'dr-file-card')
        .map((s) => [String(s.props.name), s.id]),
    ),
  ) as Promise<Record<string, string>>

/** Selects a shape with the canvas focused, the state in which tldraw's Ctrl/Cmd+C copies it. */
async function selectFocused(page: Page, id: string) {
  await edit(
    page,
    (ed, shapeId) => {
      ;(ed as unknown as { focus(): void }).focus()
      ed.select(shapeId)
    },
    id,
  )
  await expect
    .poll(() =>
      read(
        page,
        (ed) =>
          (ed as unknown as { getInstanceState(): { isFocused: boolean } }).getInstanceState().isFocused,
      ),
    )
    .toBe(true)
}

/** Ctrl/Cmd+C over the board, then what the clipboard holds (types and plain text). */
async function copyAndRead(page: Page) {
  await page.evaluate(() => navigator.clipboard.writeText('clipboard sentinel'))
  await page.keyboard.press('ControlOrMeta+c')
  // Let tldraw's async clipboard write (if any) land.
  await page.waitForTimeout(500)
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    return { types: items.flatMap((i) => [...i.types]), text: await navigator.clipboard.readText() }
  })
}

/** Right-clicks the shape; tldraw's context menu items carry `context-menu.<id>` test ids. */
async function openContextMenu(page: Page, id: string) {
  const c = await shapeCenterOnScreen(page, id)
  await page.mouse.click(c.x, c.y, { button: 'right' })
  await expect(
    page
      .getByTestId('context-menu-sub.arrange-button')
      .or(page.getByTestId('context-menu.select-all'))
      .first(),
  ).toBeVisible()
}

test('export control: the owner turns it off in Share and the viewer loses export, copy and download live; originals are refused (403), previews keep rendering', async ({
  session,
  board,
}) => {
  const a = await session('alice')
  const b = await session('bob', { role: 'viewer' })
  await b.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })

  await insertFiles(a.page, FILES.map(fixture))
  for (const name of FILES)
    await expect(fileCard(b.page, name)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  const ids = await cardIds(b.page)
  const exportButton = b.page.getByTestId('export-button')
  const zip = fileCard(b.page, 'notes.zip')
  const href = (await zip.getByTestId('file-card-download').getAttribute('href')) ?? ''
  expect(href).toMatch(ORIGINAL)

  await test.step('before: the viewer can export, copy and download (the default)', async () => {
    await expect(exportButton).not.toHaveAttribute('aria-disabled', 'true')
    await expect(zip.getByTestId('file-card-download')).toBeVisible()
    expect((await b.page.request.get(href)).status()).toBe(200)
    await selectFocused(b.page, ids['notes.zip'] ?? '')
    const copied = await copyAndRead(b.page)
    expect(copied.types).toContain('text/html') // tldraw's shapes on the clipboard
    await openContextMenu(b.page, ids['notes.zip'] ?? '')
    await expect(b.page.getByTestId('context-menu.copy')).toBeVisible()
    await expect(b.page.getByTestId('context-menu-sub.copy-as-button')).toBeVisible()
    await expect(b.page.getByTestId('context-menu-sub.export-as-button')).toBeVisible()
    await expect(b.page.getByTestId('context-menu.dr-export-off')).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    // Ctrl/Cmd+P opens the PDF export.
    await b.page.keyboard.press('Control+p')
    await expect(b.page.getByTestId('export-dialog')).toBeVisible()
    await b.page.keyboard.press('Escape')
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
  })

  await test.step('the owner switches it off; it says what it does and does not do', async () => {
    const section = await openShare(a.page)
    const toggle = section.getByTestId('share-export-policy-toggle')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(section).toContainText('Viewers and commenters can export, copy and download files')
    await expect(section).toContainText('This is not a data-protection feature')
    await expect(toggle).toHaveAccessibleName('Viewers and commenters can export, copy and download files')
    await toggle.uncheck()
    await expect(section).toHaveAttribute('data-policy', 'editors')
    await expect(toggle).not.toBeChecked()
    await closeShare(a.page)
    // The owner keeps every entry.
    await expect(a.page.getByTestId('export-button')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(fileCard(a.page, 'notes.zip').getByTestId('file-card-download')).toBeVisible()
  })

  await test.step('the viewer, without a reload: Export is off and says why, downloads are gone', async () => {
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await expect(exportButton).toHaveAttribute('title', OFF_TEXT)
    await expect(b.page.getByTestId('file-card-download')).toHaveCount(0)
    // aria-disabled (announced as unavailable) but still focusable and clickable, to say why.
    await exportButton.click({ force: true })
    await expect(b.page.getByTestId('export-off-notice')).toHaveText(OFF_TEXT)
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
    // Ctrl/Cmd+P (the PDF export) no longer opens it either.
    await edit(b.page, (ed) => (ed as unknown as { focus(): void }).focus())
    await b.page.keyboard.press('Control+p')
    await expect(b.page.getByTestId('export-off-notice')).toHaveText(OFF_TEXT)
    await expect(b.page.getByTestId('export-dialog')).toHaveCount(0)
  })

  await test.step('the viewer cannot copy shapes, and the context menu has no Copy / Copy as / Export as', async () => {
    await selectFocused(b.page, ids['notes.zip'] ?? '')
    const copied = await copyAndRead(b.page)
    expect(copied.types).not.toContain('text/html')
    expect(copied.text).toBe('clipboard sentinel')
    await expect(b.page.getByTestId('export-off-notice')).toHaveText(OFF_TEXT)
    await openContextMenu(b.page, ids['notes.zip'] ?? '')
    await expect(b.page.getByTestId('context-menu.dr-export-off')).toHaveText(OFF_TEXT.replace(/\.$/, ''))
    await expect(b.page.getByTestId('context-menu.copy')).toHaveCount(0)
    await expect(b.page.getByTestId('context-menu-sub.copy-as-button')).toHaveCount(0)
    await expect(b.page.getByTestId('context-menu-sub.export-as-button')).toHaveCount(0)
    await b.page.keyboard.press('Escape')
  })

  await test.step('the api refuses the viewer: the original (any way it is asked for) and the archive', async () => {
    const direct = await b.page.request.get(href)
    expect(direct.status()).toBe(403)
    expect(await direct.json()).toEqual({ error: { code: 'EXPORT_DISABLED', message: OFF_TEXT } })
    // fetch() from the page itself (what tldraw's own download and export use).
    const fromPage = await b.page.evaluate(async (url) => {
      const r = await fetch(url)
      return { status: r.status, body: await r.json() }
    }, href)
    expect(fromPage).toEqual({ status: 403, body: { error: { code: 'EXPORT_DISABLED', message: OFF_TEXT } } })
    const archive = await b.page.request.get(`/api/boards/${board}/export`)
    expect(archive.status()).toBe(403)
    expect((await archive.json()).error.code).toBe('EXPORT_DISABLED')
    // The owner still downloads.
    expect((await a.page.request.get(href)).status()).toBe(200)
  })

  await test.step('previews, PDF pages and video playback keep working for the viewer (fresh load too)', async () => {
    await b.page.reload()
    await expect(b.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
      timeout: 30_000,
    })
    await expect(b.page.getByTestId('export-button')).toHaveAttribute('aria-disabled', 'true')
    const pdf = fileCard(b.page, 'document.pdf')
    await expect(pdf).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
    await expect(b.page.getByTestId('file-card-download')).toHaveCount(0)
    const cover = pdf.getByTestId('file-card-preview')
    await expect.poll(() => cover.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const pageImg = pdf.locator('[data-testid="file-card-strip"] img').first()
    const pageSrc = (await pageImg.getAttribute('src')) ?? ''
    expect((await b.page.request.get(pageSrc)).status()).toBe(200)

    // The PDF viewer shows its pages; "Download original" is shown turned off.
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

    // The video card still plays: its <video> loads the original as a media element.
    const video = fileCard(b.page, 'video.mp4')
    const media = b.page.waitForResponse(
      (r) => ORIGINAL.test(r.url()) && r.request().resourceType() === 'media',
    )
    await video.getByTestId('file-card-play').click()
    expect([200, 206]).toContain((await media).status())
    await expect(video.getByTestId('file-card-video')).toHaveAttribute('controlslist', 'nodownload')
  })

  await test.step('the viewer sees the setting in Share, read-only (light, dark, 390 px)', async () => {
    await b.page.setViewportSize({ width: 390, height: 844 })
    for (const scheme of ['light', 'dark'] as const) {
      await b.page.emulateMedia({ colorScheme: scheme })
      await expect(b.page.locator('html')).toHaveAttribute('data-theme', scheme)
      const section = await openShare(b.page)
      await expect(section.getByTestId('share-export-policy-toggle')).toBeDisabled()
      await expect(section.getByTestId('share-export-policy-toggle')).not.toBeChecked()
      await expect(section.getByTestId('share-export-policy-off')).toHaveText(OFF_TEXT)
      // The theme's warning ink (--dr-warn), not the grey hint colour.
      await expect(section.getByTestId('share-export-policy-off')).toHaveCSS(
        'color',
        scheme === 'light' ? 'rgb(122, 74, 0)' : 'rgb(242, 196, 109)',
      )
      await expect(section).toContainText('Only board owners can change this.')
      await section.scrollIntoViewIfNeeded()
      // Nothing wider than the phone.
      expect(await b.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      const box = await section.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
      await capture(`export-control-viewer-${scheme}-390.png`, b.page, test.info())
      await closeShare(b.page)
    }
  })

  await test.step('the owner switches it back on: the viewer gets everything back, live', async () => {
    await a.page.setViewportSize({ width: 390, height: 844 })
    await a.page.emulateMedia({ colorScheme: 'dark' })
    const section = await openShare(a.page)
    await capture('export-control-owner-dark-390.png', a.page, test.info())
    await section.getByTestId('share-export-policy-toggle').check()
    await expect(section).toHaveAttribute('data-policy', 'everyone')
    await closeShare(a.page)
    await b.page.setViewportSize({ width: 1280, height: 720 })
    await expect(b.page.getByTestId('export-button')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(fileCard(b.page, 'notes.zip').getByTestId('file-card-download')).toBeVisible()
    expect((await b.page.request.get(href)).status()).toBe(200)
  })
})
