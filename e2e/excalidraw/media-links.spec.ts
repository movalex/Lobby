// D2 (docs/research/excalidraw/REVIEW-W5-EARLY.md §9, W5-18): a URL pasted on the Excalidraw board
// becomes a link card (page title, site icon, opens in a new tab), owner 3g. The page is read by the api
// (apps/api/src/features/link-preview, SSRF rules), never by the board: this spec serves the "site" from
// a local fixture server the api may reach only through its test seam (DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS,
// behind the local-dev guard), and checks that the browser itself never requests it.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts media-links
import { createServer, type Server } from 'node:http'
import type { Page } from '@playwright/test'
import {
  type CanvasElement,
  createItem,
  expect,
  itemCenterOnScreen,
  items,
  itemText,
  screenToScene,
  test,
} from '../tests/support/canvas.ts'
import { pressRedo, pressUndo } from '../tests/support/excalidraw.ts'
import { PORT_BASE } from '../tests/support/ports.ts'
import { focusBoard } from './media-kit.ts'
import { grantClipboard, writeClipboard } from './navigation-kit.ts'

/** The fixture "site": inside this run's port range (base + 30). */
const SITE_PORT = (PORT_BASE ?? 6800) + 30
const SITE = `http://127.0.0.1:${SITE_PORT}`
// a 1×1 PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: { DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: SITE } })

let server: Server
const served: string[] = []
test.beforeAll(async () => {
  server = createServer((req, res) => {
    served.push(req.url ?? '')
    if (req.url === '/brief')
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><html><head><title>ignored</title>' +
            '<meta property="og:title" content="Q3 campaign brief &amp; moodboard">' +
            '<meta property="og:site_name" content="Dark Burn">' +
            '<link rel="icon" href="/icon.png"><script>window.evil = 1</script></head><body>…</body></html>',
        )
    else if (req.url === '/icon.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    else if (req.url === '/untitled')
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>no head</p>')
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(SITE_PORT, '127.0.0.1', r))
})
test.afterAll(() => new Promise<void>((r) => server.close(() => r())))

const linkCards = async (page: Page) =>
  (await items(page)).filter(
    (e) =>
      e.type === 'rectangle' &&
      (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'link-card',
  ) as (CanvasElement & { link?: string })[]

async function pasteUrl(page: Page, url: string) {
  await focusBoard(page)
  await writeClipboard(page, { 'text/plain': url })
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45)
  await page.keyboard.press('ControlOrMeta+v')
}

test('D2 a pasted URL becomes a link card: the page’s title and icon (read by the api, never by the board), a new-tab link, seen by bob; one undo; its words are editable', async ({
  canvasSession,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await grantClipboard(a.context)
  const fromBrowsers: string[] = []
  for (const s of [a, b])
    s.page.on('request', (r) => {
      if (r.url().startsWith(SITE)) fromBrowsers.push(r.url())
    })
  served.length = 0
  const url = `${SITE}/brief`
  await pasteUrl(a.page, url)

  await expect.poll(async () => (await linkCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await linkCards(a.page)
  if (!card) throw new Error('no card')
  expect(card.link).toBe(url)
  // the words are stored as the card's label (exports, search and the PDF text layer read them)
  expect(await itemText(a.page, card.id)).toContain('Q3 campaign brief & moodboard')
  // nothing but the link and words: no icon bytes, no data: URL
  expect(JSON.stringify(card)).not.toMatch(/data:|base64/)

  for (const s of [a, b]) {
    await test.step(`${s.user}: the card face`, async () => {
      const face = s.page.locator(`[data-lobby-link-card="${card.id}"]`)
      await expect(face).toBeVisible({ timeout: 30_000 })
      await expect(face.getByTestId('link-card-title')).toHaveText('Q3 campaign brief & moodboard')
      await expect(face.getByTestId('link-card-host')).toHaveText('127.0.0.1')
      await expect(face).toHaveAttribute('data-icon', 'loaded')
      await expect(face.getByTestId('link-card-icon')).toHaveAttribute('src', /^data:image\/png;base64,/)
      const open = face.getByTestId('link-card-open')
      await expect(open).toHaveAttribute('href', url)
      await expect(open).toHaveAttribute('target', '_blank')
      await expect(open).toHaveAttribute('rel', /noopener/)
    })
  }
  // the api read the page and its icon; no browser on the board ever contacted the site
  expect(served).toContain('/brief')
  expect(served).toContain('/icon.png')
  expect(fromBrowsers).toEqual([])

  await test.step('one undo removes the card (and its label); redo brings it back', async () => {
    await pressUndo(a.page)
    await expect.poll(async () => (await linkCards(a.page)).length).toBe(0)
    await expect.poll(async () => (await linkCards(b.page)).length).toBe(0)
    await pressRedo(a.page)
    await expect.poll(async () => (await linkCards(a.page)).length).toBe(1)
  })

  await test.step('the face’s link opens the page in a new tab, with no opener', async () => {
    const popup = a.context.waitForEvent('page')
    await a.page.locator(`[data-lobby-link-card="${card.id}"]`).getByTestId('link-card-open').click()
    const tab = await popup
    await expect.poll(() => tab.url()).toBe(url)
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    await tab.close()
  })

  await test.step('a double-click edits its words like any shape’s: the face steps aside meanwhile', async () => {
    const face = a.page.locator(`[data-lobby-link-card="${card.id}"]`)
    const at = await itemCenterOnScreen(a.page, card.id)
    await a.page.mouse.dblclick(at.x, at.y)
    await expect(a.page.locator('textarea.excalidraw-wysiwyg')).toHaveCount(1)
    await expect(face).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(a.page.locator('textarea.excalidraw-wysiwyg')).toHaveCount(0)
    await expect(face).toBeVisible()
    await expect(face.getByTestId('link-card-title')).toHaveText('Q3 campaign brief & moodboard')
  })
})

test('D2 a page with no title gives a card with its site; an address inside the api’s network is never fetched; a script URL stays text', async ({
  canvasSession,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  served.length = 0
  await pasteUrl(a.page, `${SITE}/untitled`)
  await expect.poll(async () => (await linkCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [plain] = await linkCards(a.page)
  if (!plain) throw new Error('no card')
  await expect(
    a.page.locator(`[data-lobby-link-card="${plain.id}"]`).getByTestId('link-card-title'),
  ).toHaveText('127.0.0.1')
  await expect(a.page.locator(`[data-lobby-link-card="${plain.id}"]`)).toHaveAttribute('data-icon', 'none')

  // cloud metadata: refused by the api's network rules (answered like an unreachable page)
  await pasteUrl(a.page, 'http://169.254.169.254/latest/meta-data/')
  await expect.poll(async () => (await linkCards(a.page)).length, { timeout: 15_000 }).toBe(2)
  const inside = (await linkCards(a.page)).find((c) => c.link?.startsWith('http://169.254.169.254'))
  if (!inside) throw new Error('no card')
  await expect(
    a.page.locator(`[data-lobby-link-card="${inside.id}"]`).getByTestId('link-card-title'),
  ).toHaveText('169.254.169.254')
  // only the fixture's own page was ever requested (the untitled page and its favicon)
  expect(served.every((u) => u === '/untitled' || u === '/favicon.ico')).toBe(true)

  // not a link a board may hold: the engine's own paste makes it text, no card
  const before = (await items(a.page)).length
  await pasteUrl(a.page, 'javascript:alert(1)')
  await expect.poll(async () => (await items(a.page)).length).toBeGreaterThan(before)
  expect(await linkCards(a.page)).toHaveLength(2)
})

test('D2 a link pasted inside a frame joins that frame (W5-01’s rule for what lands in a frame)', async ({
  canvasSession,
}) => {
  test.setTimeout(120_000)
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  const box = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  const at = await screenToScene(a.page, { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 })
  const frame = await createItem(a.page, 'frame', { x: at.x - 400, y: at.y - 300, width: 800, height: 600 })
  await pasteUrl(a.page, `${SITE}/brief`)
  await expect.poll(async () => (await linkCards(a.page)).length, { timeout: 15_000 }).toBe(1)
  const [card] = await linkCards(a.page)
  expect(card?.frameId).toBe(frame)
  const label = (await items(a.page)).find((e) => (e as { containerId?: string }).containerId === card?.id)
  expect(label?.frameId).toBe(frame)
})
