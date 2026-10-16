// Wave R (WS3, docs/WAVE-R-CONTRACTS.md §6): design files on the Excalidraw canvas, through the real api file routes and
// the preview worker. Photoshop, TIFF and Illustrator files become cards whose page is a flattened preview ("Flattened
// preview · PSD", never "editable"), with the page viewer and the original as the download; a Photoshop file saved
// without "Maximize Compatibility" shows its thumbnail as a low-resolution preview; HEIC stays an attachment with the
// hint (Chromium has no HEIC decoder, so the uploader's Safari conversion does not run); hostile files fail with the
// contracts' words and stay downloadable. Fixtures: `pnpm fixtures` (apps/worker/scripts/make-fixtures.ts).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- media-design
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DESIGN_PREVIEW_MESSAGES } from '../../packages/contracts/src/design-previews.ts'
import { expect, test } from '../tests/support/canvas.ts'
import type { FilePayload } from '../tests/support/files.ts'
import { viewer } from '../tests/support/media-2.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { fileCard, insertFiles } from './media-kit.ts'

/** The fixture as a browser hands it over: Chromium's type for the extension. */
const upload = (fixture: string, mimeType: string, name = fixture): FilePayload => ({
  name,
  mimeType,
  buffer: readFileSync(join(FIXTURES_DIR, fixture)),
})
const PSD = 'image/vnd.adobe.photoshop'

async function settled(page: Page, name: string, status: 'ready' | 'failed') {
  const card = fileCard(page, name)
  await expect(card).toHaveAttribute('data-status', status, { timeout: 60_000 })
  return card
}

const DESIGNS = [
  { file: upload('design.psd', PSD), kind: 'psd', label: 'PSD', pages: 1 },
  { file: upload('scan-lzw.tif', 'image/tiff'), kind: 'tiff', label: 'TIFF', pages: 1 },
  { file: upload('artwork.ai', 'application/postscript'), kind: 'ai', label: 'AI', pages: 2 },
] as const

test('design previews: PSD, TIFF and AI become flattened previews with their type, for the editor and a viewer; the viewer says so; the original downloads unchanged', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  await insertFiles(
    a.page,
    DESIGNS.map((d) => d.file),
  )

  await test.step('each card is ready with the badge, its type and its pages, for both people', async () => {
    for (const s of [a, v]) {
      for (const d of DESIGNS) {
        const card = await settled(s.page, d.file.name, 'ready')
        await expect(card).toHaveAttribute('data-kind', 'pdf')
        await expect(card).toHaveAttribute('data-design', d.kind)
        await expect(card.getByTestId('file-card-design-badge')).toHaveText(`Flattened preview · ${d.label}`)
        await expect(card.getByTestId('file-card-design-hint')).toHaveCount(0)
        const pages = d.pages === 1 ? '1 page' : `${d.pages} pages`
        await expect(card.getByTestId('file-card-pages')).toHaveText(pages)
        await expect(card.getByTestId('file-card-preview')).toBeVisible()
        await expect(card).toHaveAttribute('aria-description', `${d.label}: ${d.file.name}`)
        await expect(card).not.toContainText(/editable/i)
      }
    }
  })

  await test.step('"View pages" names the type and says the pages are a flattened preview', async () => {
    await fileCard(v.page, 'design.psd').getByTestId('file-card-view-pages').click()
    await expect(viewer(v.page)).toBeVisible()
    await expect(v.page.locator('.dr-pv__desc')).toContainText('PSD · 1 page')
    await expect(v.page.getByTestId('pdf-viewer-design-note')).toHaveText(
      'Flattened preview of the PSD file. Layers are not shown. Download the original to work on it.',
    )
    await expect(v.page.getByTestId('pdf-viewer-conversion-note')).toHaveCount(0)
  })

  await test.step('"Download original" is the Photoshop file itself, as a download (never rendered inline)', async () => {
    const link = v.page.getByTestId('pdf-viewer-download')
    await expect(link).toHaveAttribute('download', 'design.psd')
    const href = await link.getAttribute('href')
    if (!href) throw new Error('no href')
    const res = await v.page.request.get(href)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('application/octet-stream')
    expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="design.psd"/)
    expect(Buffer.compare(await res.body(), readFileSync(join(FIXTURES_DIR, 'design.psd')))).toBe(0)
    await v.page.keyboard.press('Escape')
    await expect(viewer(v.page)).toHaveCount(0)
  })
})

test('design previews: a thumbnail-only PSD says it is low resolution, HEIC is an attachment with the hint, and hostile files fail with plain words and stay downloadable', async ({
  canvasSession,
  stack,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [
    upload('nocomposite.psd', PSD),
    upload('photo.heic', 'image/heic', 'IMG_0001.HEIC'),
    upload('bomb-30000x30000.psd', PSD),
    upload('cmyk.psd', PSD),
    upload('nopdf.ai', 'application/postscript'),
    upload('bomb-100000x100000.tif', 'image/tiff'),
  ])

  await test.step('a PSD without a real composite: its thumbnail, with the low-resolution hint', async () => {
    const card = await settled(a.page, 'nocomposite.psd', 'ready')
    await expect(card.getByTestId('file-card-preview')).toBeVisible()
    await expect(card.getByTestId('file-card-design-badge')).toHaveText('Flattened preview · PSD')
    const hint = card.getByTestId('file-card-design-hint')
    await expect(hint).toHaveText(DESIGN_PREVIEW_MESSAGES.PSD_THUMBNAIL_ONLY)
  })

  await test.step('HEIC: kept as the photo itself, an attachment with the hint (Chromium cannot decode it)', async () => {
    const card = await settled(a.page, 'IMG_0001.HEIC', 'ready')
    await expect(card).toHaveAttribute('data-kind', 'other')
    await expect(card).toHaveAttribute('data-design', 'heic')
    const hint = card.getByTestId('file-card-design-hint')
    await expect(hint).toHaveText(DESIGN_PREVIEW_MESSAGES.HEIC_NO_PREVIEW)
    await expect(card.getByTestId('file-card-design-badge')).toHaveCount(0)
    await expect(card.getByTestId('file-card-download')).toHaveAttribute('download', 'IMG_0001.HEIC')
  })

  const failures = [
    { name: 'bomb-30000x30000.psd', code: 'DESIGN_TOO_LARGE' },
    { name: 'cmyk.psd', code: 'PSD_UNSUPPORTED' },
    { name: 'nopdf.ai', code: 'NO_PDF_CONTENT' },
    { name: 'bomb-100000x100000.tif', code: 'DESIGN_TOO_LARGE' },
  ] as const
  await test.step('hostile and unsupported files fail with the contracts’ words, never a badge', async () => {
    for (const f of failures) {
      const card = await settled(a.page, f.name, 'failed')
      await expect(card.getByTestId('file-card-error')).toHaveText(DESIGN_PREVIEW_MESSAGES[f.code])
      await expect(card.getByTestId('file-card-design-badge')).toHaveCount(0)
      await expect(card.getByTestId('file-card-download')).toHaveAttribute('download', f.name)
    }
  })

  // The worker logs versions and codes, never file names.
  const log = stack.worker.logs()
  for (const f of failures) expect(log).toMatch(new RegExp(`failed ${f.code}`))
  for (const f of failures) expect(log).not.toContain(f.name)
})
