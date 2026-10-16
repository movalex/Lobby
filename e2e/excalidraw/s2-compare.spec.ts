// Wave S, WS2 (docs/WAVE-S-CONTRACTS.md §3.3): compare in the review viewer, with the versions switch on (s2-kit.ts).
//   - images: from the version list's "Compare": side by side with one zoom for both panes, the slider (B clipped at
//     the divider, a note when the proportions differ) and onion skin (B's opacity); "Done comparing";
//   - PDFs: page N of A against page N of B, the page steps move both;
//   - a video version the browser cannot play (here: a file the worker refused, served as an attachment): the
//     posters and "This browser can't play this file; download it" (s2-compare-video.spec.ts plays the A/B).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts s2-compare
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, selectNone, test } from '../tests/support/canvas.ts'
import { fileFromPath, makeImages } from '../tests/support/files.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import {
  cardItems,
  expectLoadedImage,
  fileCard,
  imageItems,
  insertFiles,
  newItems,
  settleCamera,
} from './media-kit.ts'
import { chipOf, uploadNewVersion, withVersions } from './s2-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

test.use({ viewport: { width: 1440, height: 900 } })

const loaded = (img: Locator) =>
  expect.poll(
    () => img.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth),
    {
      timeout: 30_000,
    },
  )

/** Opens the viewer comparing the shown version with `versionId`, from the chip's version list. */
async function openCompare(page: Page, id: string, versionId: string) {
  await selectNone(page)
  await chipOf(page, id).click()
  await page
    .getByTestId('version-list')
    .locator(`[data-version="${versionId}"]`)
    .getByTestId('version-compare')
    .click()
  const viewer = page.getByTestId('review-viewer')
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId('version-list')).toHaveCount(0)
  return viewer
}

test('S2 compare images: side by side with one zoom, slider with the proportions note, onion skin', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await withVersions(await canvasSession('alice'))
  const [v1File, v2File] = await makeImages(a.page, [
    { name: 'cut-v1.png', w: 1600, h: 900, type: 'image/png' },
    { name: 'cut-v2.png', w: 900, h: 1600, type: 'image/png' },
  ])
  if (!v1File || !v2File) throw new Error('no images')
  const before = new Set((await imageItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [v1File])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image')
  await expectLoadedImage(a.page, img.id, board)
  await settleCamera(a.page)
  const v2 = await uploadNewVersion(a.page, img.id, v2File)
  await expectLoadedImage(a.page, img.id, board)

  const viewer = await openCompare(a.page, img.id, img.facts.versionId)
  const compare = viewer.getByTestId('compare')
  await expect(compare).toHaveAttribute('data-kind', 'image')
  // A is v1 (the version picked), B is v2 (the one shown)
  await expect(viewer.getByTestId('compare-pick-a')).toHaveValue(img.facts.versionId)
  await expect(viewer.getByTestId('compare-pick-b')).toHaveValue(v2.facts.versionId)
  await expect(viewer.getByTestId('compare-side')).toBeVisible()
  await loaded(viewer.getByTestId('compare-a')).toBeGreaterThan(0)
  await loaded(viewer.getByTestId('compare-b')).toBeGreaterThan(0)
  // one zoom for both panes
  await viewer.getByTestId('compare-zoom-in').click()
  const frames = viewer.locator('.lobby-cmp__frame')
  await expect(frames).toHaveCount(2)
  for (const f of await frames.all()) await expect(f).toHaveAttribute('data-zoom', '1.5')
  const transforms = await viewer
    .locator('.lobby-cmp__frame img')
    .evaluateAll((imgs) => imgs.map((i) => (i as HTMLElement).style.transform))
  expect(transforms[0]).toBe(transforms[1])
  expect(transforms[0]).toContain('scale(1.5)')

  // the slider: different proportions are said; the divider clips B
  await viewer.getByTestId('compare-mode-slider').click()
  await expect(viewer.getByTestId('compare-aspect-note')).toContainText('different proportions')
  await viewer.getByTestId('compare-slider').fill('20')
  await expect(viewer.getByTestId('compare-top')).toHaveAttribute(
    'style',
    /inset\(0(px)? 0(px)? 0(px)? 20%\)/,
  )
  // a drag on the picture moves the divider too
  const box = await viewer.getByTestId('compare-slider-box').boundingBox()
  if (!box) throw new Error('no slider box')
  await a.page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
  await a.page.mouse.down()
  await a.page.mouse.up()
  await expect
    .poll(async () => Number(await viewer.getByTestId('compare-slider').inputValue()))
    .toBeGreaterThan(70)
  await loaded(viewer.getByTestId('compare-b')).toBeGreaterThan(0)

  // onion skin: B over A at an opacity
  await viewer.getByTestId('compare-mode-onion').click()
  await viewer.getByTestId('compare-opacity').fill('30')
  await expect(viewer.getByTestId('compare-top')).toHaveAttribute('style', /opacity: 0\.3/)

  // keys stay in the viewer: an "a" or Delete never reaches the board
  await viewer.getByTestId('compare-mode-side').focus()
  await a.page.keyboard.press('Delete')
  expect((await imageItems(a.page)).map((f) => f.id)).toContain(img.id)

  // a phone: the panes stack, the viewer fills the screen
  await viewer.getByTestId('compare-mode-side').click()
  await a.page.setViewportSize({ width: 375, height: 812 })
  await expect
    .poll(async () => {
      const [p1, p2] = await viewer
        .locator('.lobby-cmp__pane')
        .evaluateAll((ps) =>
          ps.map((p) => p.getBoundingClientRect().toJSON() as { top: number; bottom: number; right: number }),
        )
      return !!p1 && !!p2 && p2.top >= p1.bottom - 1 && p1.right <= 375 && p2.right <= 375
    })
    .toBe(true)
  await a.page.setViewportSize({ width: 1440, height: 900 })

  await viewer.getByTestId('compare-done').click()
  await expect(viewer.getByTestId('compare')).toHaveCount(0)
  await expect(viewer.getByTestId('viewer-compare')).toBeVisible()
  await expect(viewer.getByTestId('viewer-version')).toHaveValue(v2.facts.versionId)
  await a.page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
})

test('S2 compare PDFs page by page; a video version the browser cannot play shows the posters and says so', async ({
  canvasSession,
}) => {
  test.setTimeout(240_000)
  const a = await withVersions(await canvasSession('alice'))
  const before = new Set((await cardItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [fixture('document.pdf')])
  const [card] = await newItems(a.page, cardItems, before, 1)
  if (!card) throw new Error('no card')
  await expect(fileCard(a.page, 'document.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  const v2 = await uploadNewVersion(a.page, card.id, {
    ...fileFromPath(fixture('document.pdf')),
    name: 'document-v2.pdf',
  })
  await expect(fileCard(a.page, 'document-v2.pdf')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  })
  await expect(chipOf(a.page, card.id)).toHaveText('v2')

  const viewer = await openCompare(a.page, card.id, card.facts.versionId)
  await expect(viewer.getByTestId('compare')).toHaveAttribute('data-kind', 'pdf')
  await expect(viewer.getByTestId('compare-page')).toHaveText('Page 1')
  await loaded(viewer.getByTestId('compare-a')).toBeGreaterThan(0)
  await loaded(viewer.getByTestId('compare-b')).toBeGreaterThan(0)
  const srcs = async () =>
    viewer
      .locator('[data-testid="compare-a"], [data-testid="compare-b"]')
      .evaluateAll((i) => i.map((x) => x.getAttribute('src')))
  const first = await srcs()
  await viewer.getByTestId('compare-page-next').click()
  await expect(viewer.getByTestId('compare-page')).toHaveText('Page 2')
  // both moved: each shows its own version's page 2
  await expect.poll(srcs).not.toEqual(first)
  const second = await srcs()
  expect(second[0]).toContain(card.facts.versionId)
  expect(second[1]).toContain(v2.facts.versionId)
  await expect(viewer.getByTestId('compare-page-note')).toHaveCount(0) // 4 pages each
  await viewer.getByTestId('compare-mode-slider').click()
  await expect(viewer.getByTestId('compare-slider')).toBeVisible()
  await a.page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // video: v2 is not a video the browser can play (a playlist text named .mp4: the worker refuses it)
  const vBefore = new Set((await cardItems(a.page)).map((f) => f.id))
  await insertFiles(a.page, [fixture('video-noaudio.mp4')])
  const [vid] = await newItems(a.page, cardItems, vBefore, 1)
  if (!vid) throw new Error('no video card')
  await expect(fileCard(a.page, 'video-noaudio.mp4')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  })
  await uploadNewVersion(a.page, vid.id, { ...fileFromPath(fixture('disguised.mp4')), name: 'cut-v2.mp4' })
  await expect(chipOf(a.page, vid.id)).toHaveText('v2')
  const vViewer = await openCompare(a.page, vid.id, vid.facts.versionId)
  await expect(vViewer.getByTestId('compare')).toHaveAttribute('data-kind', 'video')
  await expect(vViewer.getByTestId('compare-cant-play')).toContainText(
    "This browser can't play this file; download it.",
  )
  await expect(vViewer.getByTestId('compare-play')).toHaveCount(0)
})
