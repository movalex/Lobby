// K2-7 (wave K, UXD-18, UXD-09, UXD-11): menus whose rows line up whether or not a row has an icon or a submenu
// chevron; the selection's quick actions (the selection bar) clear of the style panel; an image's style panel in
// one row. (The start view's framing is unit-tested: features/canvas-ux/placement.test.ts startViewCamera.)
import type { Locator, Page } from '@playwright/test'
import { makePng } from '../spike-b/support/png.ts'
import {
  createItem,
  createNote,
  expect,
  expectSaved,
  itemBounds,
  select,
  setViewport,
  test,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** The left edge of every row's label in a menu, rounded to a tenth of a px, by the row's own words. */
async function labelOffsets(menu: Locator) {
  return menu.evaluate((root) => {
    const box = root.getBoundingClientRect()
    const out: { label: string; x: number; sub: boolean }[] = []
    // this menu's own rows (a submenu that happens to be open is another menu)
    for (const row of root.querySelectorAll('.cux-menu__item')) {
      if (row.closest('.cux-menu--sub')) continue
      const label = row.querySelector('.cux-menu__label')
      if (!label) continue
      const r = label.getBoundingClientRect()
      if (!r.width) continue
      out.push({
        label: label.textContent?.trim() ?? '',
        x: Math.round((r.left - box.left) * 10) / 10,
        sub: row.getAttribute('aria-haspopup') === 'menu',
      })
    }
    return out
  })
}

async function expectAligned(page: Page, menu: Locator, name: string) {
  const rows = await labelOffsets(menu)
  // not vacuous: rows with and without a submenu chevron are both there
  expect(
    rows.some((r) => r.sub),
    `${name}: a row with a submenu`,
  ).toBe(true)
  expect(
    rows.some((r) => !r.sub),
    `${name}: a row without one`,
  ).toBe(true)
  const xs = new Set(rows.map((r) => r.x))
  expect([...xs], `${name}: label offsets ${JSON.stringify(rows)}`).toHaveLength(1)
  await page.screenshot({ path: test.info().outputPath(`k2-7-${name}.png`) })
}

test('K2-7 (UXD-18): every row of the board menu and the context menu starts its words at the same x', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await createNote(a.page, { x: 0, y: 0, text: 'Menu test' })
  await expectSaved(a.page)
  await zoomToFit(a.page)

  await a.page.getByTestId('main-menu.button').click()
  const main = a.page.getByTestId('main-menu-root')
  await expect(main).toBeVisible()
  await expectAligned(a.page, main, 'board-menu')
  await a.page.keyboard.press('Escape')
  await expect(main).toHaveCount(0)

  const box = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await a.page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.7, { button: 'right' })
  const ctx = a.page.getByTestId('context-menu-root')
  await expect(ctx).toBeVisible()
  await expectAligned(a.page, ctx, 'context-menu')
})

test('K2-7 (UXD-09): a shape near the right edge: the selection bar is drawn clear of the style panel', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  const id = await createItem(a.page, 'rectangle', { x: 0, y: 0, width: 160, height: 120 })
  await expectSaved(a.page)
  // the shape at the canvas's top right, under where the style panel opens
  const canvas = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!canvas) throw new Error('no canvas')
  await setViewport(a.page, { x: -(canvas.width - 200), y: -80, zoom: 1 })
  await select(a.page, [id])
  const bar = a.page.getByTestId('selection-bar')
  const panel = a.page.getByTestId('style.panel')
  await expect(bar).toBeVisible()
  await expect(panel).toBeVisible()
  await expect
    .poll(async () => {
      const [b, p] = await Promise.all([bar.boundingBox(), panel.boundingBox()])
      if (!b || !p) return 'missing'
      const overlap =
        b.x < p.x + p.width && p.x < b.x + b.width && b.y < p.y + p.height && p.y < b.y + b.height
      return overlap ? 'overlaps' : 'clear'
    })
    .toBe('clear')
  await expect(bar).toHaveAttribute('data-side', /left|below/)
  // still next to the shape it is for
  const [b, shape] = await Promise.all([bar.boundingBox(), itemBounds(a.page, id)])
  expect(b && shape).toBeTruthy()
  await a.page.screenshot({ path: test.info().outputPath('k2-7-selection-bar.png') })
})

test('K2-7 (UXD-09): an image selection shows a single-row style panel (its kind and the opacity)', async ({
  canvasSession,
  board,
  users,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  const api = await users.api('alice')
  const bytes = makePng(640, 360, 3)
  const up = await api.request.post(`${WEB_URL}/api/boards/${board}/assets`, {
    headers: { origin: WEB_URL, 'content-type': 'image/png', 'x-file-name': 'photo.png' },
    data: bytes,
  })
  expect(up.status(), await up.text()).toBeLessThan(300)
  const meta = (await up.json()) as { assetId: string; versionId: string; name?: string; sizeBytes?: number }
  const id = await createItem(a.page, 'image', {
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    fileId: meta.versionId,
    status: 'saved',
    customData: {
      lobby: {
        file: {
          assetId: meta.assetId,
          versionId: meta.versionId,
          kind: 'image',
          name: meta.name ?? 'photo.png',
          mimeType: 'image/png',
          sizeBytes: meta.sizeBytes ?? bytes.length,
        },
      },
    },
  })
  await expectSaved(a.page)
  await zoomToFit(a.page)
  await select(a.page, [id])
  const panel = a.page.getByTestId('style.panel')
  await expect(panel).toHaveAttribute('data-summary', 'image')
  await expect(panel).toContainText('Image')
  await expect(panel.getByTestId('style.opacity')).toBeVisible()
  const box = await panel.boundingBox()
  expect(box?.height ?? 999).toBeLessThan(60)
  await a.page.screenshot({ path: testInfo.outputPath('k2-7-image-panel.png') })
})
