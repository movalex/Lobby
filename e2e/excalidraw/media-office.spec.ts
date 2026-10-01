// Wave 3g, ported from e2e/tests/office-previews.spec.ts: DOCX, PPTX and XLSX files on the Excalidraw
// canvas become file cards whose pages come from their PDF conversion, through the real api file routes,
// the preview worker (development mode with apps/worker/test/children/fake-soffice.ts playing soffice, as
// in the tldraw spec) and the page viewer.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- media-office
//
// What differs from the tldraw spec: the card's screen-reader descriptor ("Word document: …", tldraw's
// shape-util aria descriptor) is the card face's `aria-description`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, itemBounds, setViewport, test, viewport } from '../tests/support/canvas.ts'
import { viewer, viewerCounter, viewerPage } from '../tests/support/media-2.ts'
import { FIXTURES_DIR, REPO_ROOT } from '../tests/support/stack.ts'
import { cardItems, fileCard, insertFiles } from './media-kit.ts'

test.use({
  workerEnv: {
    WORKER_OFFICE: 'local',
    SOFFICE_PATH: join(REPO_ROOT, 'apps/worker/test/children/fake-soffice.ts'),
  },
})

const fixture = (name: string) => join(FIXTURES_DIR, name)
const NOTE = 'Preview made from a PDF conversion'

const DOCS = [
  { name: 'document.docx', ext: 'docx', pages: 3, label: 'Word document' },
  { name: 'slides.pptx', ext: 'pptx', pages: 3, label: 'PowerPoint presentation' },
  { name: 'sheet.xlsx', ext: 'xlsx', pages: 2, label: 'Excel spreadsheet' },
] as const

async function readyCard(page: Page, name: string) {
  const card = fileCard(page, name)
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  return card
}

test('Office previews: DOCX, PPTX and XLSX become cards with their pages, marked as a PDF conversion, for the editor and a viewer; the viewer names the document; the original downloads unchanged', async ({
  canvasSession,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  await insertFiles(
    a.page,
    DOCS.map((d) => fixture(d.name)),
  )

  await test.step('each card is ready with its page count, the conversion note and a strip of pages, for both people', async () => {
    for (const s of [a, v]) {
      for (const d of DOCS) {
        const card = await readyCard(s.page, d.name)
        await expect(card).toHaveAttribute('data-kind', 'pdf')
        await expect(card).toHaveAttribute('data-office', d.ext)
        await expect(card.getByTestId('file-card-pages')).toHaveText(`${d.pages} pages`)
        await expect(card.getByTestId('file-card-conversion-note')).toHaveText(NOTE)
        await expect(card.getByTestId('file-card-preview')).toHaveAccessibleName(`First page of ${d.name}`)
        await expect(card.getByTestId('file-card-strip').locator('img')).toHaveCount(d.pages - 1)
        await expect(card.getByTestId('file-card-view-pages')).toHaveAccessibleName(`View pages of ${d.name}`)
        // The footer badge still says what the file is.
        await expect(card.locator('.dr-fc__icon')).toHaveText(d.ext.toUpperCase().slice(0, 4))
        // An Office document is previewed through a PDF conversion, but it is not a PDF file.
        await expect(card).toHaveAttribute('aria-description', `${d.label}: ${d.name}`)
      }
    }
    // The cover is loaded from a derivative, never the original.
    const src = await fileCard(a.page, 'document.docx').getByTestId('file-card-preview').getAttribute('src')
    expect(src).toMatch(/^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_/)
  })

  await test.step('"View pages" opens the page viewer, named for the document, with the conversion note', async () => {
    await fileCard(v.page, 'document.docx').getByTestId('file-card-view-pages').click()
    await expect(viewer(v.page)).toBeVisible()
    await expect(v.page.getByRole('dialog', { name: 'document.docx' })).toBeVisible()
    await expect(v.page.locator('.dr-pv__desc')).toContainText('Word document · 3 pages')
    await expect(v.page.getByTestId('pdf-viewer-conversion-note')).toHaveText(
      `${NOTE}. Fonts and layout can differ from the original.`,
    )
    await expect(viewerCounter(v.page)).toHaveText('Page 1 of 3')
    await v.page.keyboard.press('ArrowRight')
    await expect(viewerCounter(v.page)).toHaveText('Page 2 of 3')
    await expect(viewerPage(v.page)).toHaveAccessibleName('Page 2 of document.docx')
    await expect(v.page.getByTestId('pdf-viewer-thumb')).toHaveCount(3)
  })

  await test.step('"Download original" is the Word file itself, as a download (never rendered inline)', async () => {
    const link = v.page.getByTestId('pdf-viewer-download')
    await expect(link).toHaveAttribute('download', 'document.docx')
    const href = await link.getAttribute('href')
    if (!href) throw new Error('no href')
    const res = await v.page.request.get(href)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('application/octet-stream')
    expect(res.headers()['content-disposition']).toMatch(/^attachment; filename="document.docx"/)
    expect(Buffer.compare(await res.body(), readFileSync(fixture('document.docx')))).toBe(0)
    await v.page.keyboard.press('Escape')
    await expect(viewer(v.page)).toHaveCount(0)
  })

  await test.step('dark theme and a 390 px phone: the cards and the viewer still fit and read', async () => {
    await a.page.emulateMedia({ colorScheme: 'dark' })
    await expect(fileCard(a.page, 'slides.pptx').getByTestId('file-card-conversion-note')).toBeVisible()
    await v.page.emulateMedia({ colorScheme: 'dark' })
    await v.page.setViewportSize({ width: 390, height: 844 })
    // On a phone the board shows one card at a time: bring the deck into view, once the canvas has seen
    // the new size.
    await expect
      .poll(async () => {
        const vp = await viewport(v.page)
        return vp.width * vp.zoom
      })
      .toBeLessThanOrEqual(390)
    const deck = (await cardItems(v.page)).find((c) => c.facts.name === 'slides.pptx')
    const b = deck ? await itemBounds(v.page, deck.id) : null
    if (!b) throw new Error('no deck')
    const vp = await viewport(v.page)
    const sw = vp.width * vp.zoom
    const sh = vp.height * vp.zoom
    const z = Math.min(1, (sw - 40) / b.width, (sh - 120) / b.height)
    await setViewport(v.page, {
      x: b.x + b.width / 2 - sw / z / 2,
      y: b.y + b.height / 2 - sh / z / 2,
      zoom: z,
    })
    const open = fileCard(v.page, 'slides.pptx').getByTestId('file-card-view-pages')
    await expect(open).toBeInViewport()
    await open.click()
    await expect(viewer(v.page)).toBeVisible()
    await expect(v.page.locator('.dr-pv__desc')).toContainText('PowerPoint presentation · 3 pages')
    const note = v.page.getByTestId('pdf-viewer-conversion-note')
    await expect(note).toBeVisible()
    const box = await note.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
    expect(await v.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await v.page.keyboard.press('Escape')
  })
})

test('Office previews: a damaged, a password-protected and a macro-enabled document fail with plain messages and stay downloadable; nothing is converted for them', async ({
  canvasSession,
  stack,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [fixture('truncated.docx'), fixture('encrypted.docx'), fixture('macro.docx')])
  const cases = [
    {
      name: 'truncated.docx',
      message:
        'This document could not be converted for preview. It may be damaged, password-protected or too complex. You can still download it.',
    },
    { name: 'encrypted.docx', message: 'This document is password-protected. Download it to open it.' },
    {
      name: 'macro.docx',
      message: "The file's contents do not match its file type, so no preview was made.",
    },
  ]
  for (const c of cases) {
    const card = fileCard(a.page, c.name)
    await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
    await expect(card.getByTestId('file-card-error')).toHaveText(c.message)
    await expect(card.getByTestId('file-card-conversion-note')).toHaveCount(0)
    await expect(card.getByTestId('file-card-download')).toHaveAttribute('download', c.name)
    // Still labelled for what it is while it has no preview.
    await expect(card).toHaveAttribute('aria-description', `Word document: ${c.name}`)
  }
  // The worker refused all three before any conversion, and logs versions and codes, never file names.
  const log = stack.worker.logs()
  expect(log).toMatch(/failed OFFICE_INVALID \(no end of central directory/)
  expect(log).toMatch(/failed OFFICE_ENCRYPTED \(encrypted OOXML package\)/)
  expect(log).toMatch(
    /failed TYPE_MISMATCH \(declared pdf, content application\/vnd\.ms-word\.document\.macroenabled/,
  )
  for (const c of cases) expect(log).not.toContain(c.name)
})
