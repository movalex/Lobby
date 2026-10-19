// WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6): "Insert as slides" end to end on the real stack: a PDF
// uploaded through the api, previewed by the real worker (pages 1..8), its pages 9+ made by the same worker's
// render-pages op (the stack runs the api with DRAFTROOM_DECK_IMPORT on and the worker of this build, which reports
// render-pages@1), placed as deck-slide frames holding deck-page pictures in ONE undo step, seen by a second tab that
// pushes nothing, in Present's reading order; a 101-page deck gives the notice and the first 100; a Keynote file gets
// the guidance and no request; a name-only guest places the first 8 and asks for nothing. The web switch is on
// through the dev-auth override (localStorage 'lobby.formatsDeckImport' = '1': features/formats/flags.ts).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- w4-deck-import
import type { Page } from '@playwright/test'
import { presentationOrderOf } from '../../packages/board-ops/src/elements/index.ts'
import {
  type CanvasElement,
  canvasCall,
  clickItem,
  expect,
  items,
  pushedOps,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { pressUndo } from '../tests/support/excalidraw.ts'
import { makePdf } from '../tests/support/media-2.ts'
import { foreignRequests } from './ai-kit.ts'
import { cardItems, expectLoadedImage, fileCard, insertFiles } from './media-kit.ts'

/** apps/web/src/features/formats/flags.ts FORMATS_FLAG_KEYS.deckImport (not imported: it reads import.meta.env) */
const DECK_FLAG = 'lobby.formatsDeckImport'

const lobbyOf = (e: CanvasElement) =>
  ((e as { customData?: { lobby?: Record<string, unknown> } }).customData?.lobby ?? {}) as Record<
    string,
    unknown
  >

async function deckOn(page: Page) {
  await page.evaluate((key) => localStorage.setItem(key, '1'), DECK_FLAG)
}

/** The board's deck slides: frames and their pictures, in the order the facade holds them. */
async function slides(page: Page) {
  const all = await items(page)
  const frames = all.filter((e) => e.type === 'frame' && lobbyOf(e).kind === 'deck-slide')
  const pictures = all.filter((e) => e.type === 'image' && lobbyOf(e).kind === 'deck-page')
  return { all, frames, pictures }
}

async function readyCardId(page: Page, name: string): Promise<string> {
  await expect(fileCard(page, name)).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  const card = (await cardItems(page)).find((c) => c.facts.name === name)
  if (!card) throw new Error(`no card ${name}`)
  return card.id
}

/** Records the render-pages requests a page makes. */
function renderRequests(page: Page): string[] {
  const out: string[] = []
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      /\/api\/files\/ver_[0-9A-Za-z]+\/render-pages$/.test(new URL(r.url()).pathname)
    )
      out.push(r.url())
  })
  return out
}

test('a 12-page PDF becomes 12 slides in one undo step; the worker makes pages 9 to 12; a second tab sees them and pushes nothing', async ({
  canvasSession,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'editor' })
  const foreign = [foreignRequests(a.page), foreignRequests(b.page)]
  const asks = renderRequests(a.page)
  await deckOn(a.page)
  for (const s of [a, b]) await setViewport(s.page, { x: -200, y: -200, zoom: 0.25 })
  await insertFiles(a.page, [await makePdf('Pitch.pdf', 12)])
  const cardId = await readyCardId(a.page, 'Pitch.pdf')
  await readyCardId(b.page, 'Pitch.pdf')
  const before = (await items(a.page)).length

  await test.step('the viewer offers it; the dialog says the slides are pictures and that pages 9 to 12 are made first', async () => {
    await fileCard(a.page, 'Pitch.pdf').getByTestId('file-card-view-pages').click()
    await expect(a.page.getByTestId('pdf-viewer')).toBeVisible()
    await a.page.getByTestId('pdf-viewer-insert-slides').click()
    await expect(a.page.getByTestId('pdf-viewer')).toHaveCount(0)
    const dialog = a.page.getByTestId('deck-import-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('deck-import-pictures')).toContainText('their text can’t be edited')
    await expect(dialog.getByTestId('deck-import-render-note')).toHaveText(
      'Pages 9 to 12 are made first. This can take a minute or two.',
    )
    await expect(dialog.getByTestId('deck-import-soft')).toContainText('1024 pixels wide')
    await expect(dialog.getByTestId('deck-import-truncated')).toHaveCount(0)
    // the second tab has no such entry (its switch is off): it never asks for anything
    await expect(b.page.getByTestId('deck-import-dialog')).toHaveCount(0)
  })

  const bPushed = (await pushedOps(b.page)).length
  await test.step('Insert: one request, the pages are made, the slides are placed', async () => {
    await a.page.getByTestId('deck-import-insert').click()
    await expect(a.page.getByTestId('deck-placed')).toContainText('Placed 12 slides of Pitch.pdf.', {
      timeout: 180_000,
    })
    expect(asks).toHaveLength(1)
    await expect(a.page.getByTestId('deck-import-dialog')).toHaveCount(0)
  })

  await test.step('12 deck-slide frames, each holding its page picture ver_….p<n>, in reading (Present) order', async () => {
    const s = await slides(a.page)
    expect(s.frames).toHaveLength(12)
    expect(s.pictures).toHaveLength(12)
    const card = (await cardItems(a.page)).find((c) => c.id === cardId)
    const versionId = card?.facts.versionId ?? ''
    for (const [i, f] of presentationOrderOf(s.frames).entries()) {
      expect(f.name).toBe(`Slide ${i + 1}`)
      const pic = s.pictures.find((p) => (p as { frameId?: string | null }).frameId === f.id)
      expect((pic as { fileId?: string } | undefined)?.fileId?.replace(/@\w+$/, '')).toBe(
        `${versionId}.p${i + 1}`,
      )
      expect(lobbyOf(pic as CanvasElement).alt).toBe(`Slide ${i + 1} of 12`)
      expect(f.bounds.w).toBe(1600)
    }
    // rows of five, top-aligned
    const tops = [...new Set(s.frames.map((f) => Math.round(f.y)))]
    expect(tops).toHaveLength(3)
    expect(JSON.stringify(s.all)).not.toMatch(/data:image|blob:|X-Amz-|[?&]sig=/)
  })

  await test.step('both tabs show page 1 and page 12 (made by the op) from board-scoped derivatives', async () => {
    const s = await slides(a.page)
    const pick = (n: number) => s.pictures.find((p) => lobbyOf(p).pdfPage === n)?.id ?? ''
    for (const page of [a.page, b.page]) {
      await setViewport(page, { x: -200, y: -200, zoom: 0.05 })
      for (const n of [1, 9, 12]) await expectLoadedImage(page, pick(n), a.page.url().split('/b/')[1] ?? '')
    }
    await expect.poll(async () => (await slides(b.page)).frames.length).toBe(12)
    // the receiving tab pushed nothing while it only received
    expect((await pushedOps(b.page)).slice(bPushed)).toEqual([])
  })

  await test.step('one undo takes the whole deck back, on both tabs', async () => {
    await pressUndo(a.page)
    await expect.poll(async () => (await slides(a.page)).frames.length).toBe(0)
    await expect.poll(async () => (await slides(b.page)).pictures.length).toBe(0)
    expect((await items(a.page)).length).toBe(before)
  })

  expect(foreign.flat()).toEqual([])
})

test('a 101-page deck: the notice, and the first 100 pages as slides from the context menu', async ({
  canvasSession,
}) => {
  test.setTimeout(420_000)
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await deckOn(a.page)
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.25 })
  await insertFiles(a.page, [await makePdf('Long.pdf', 101)])
  const cardId = await readyCardId(a.page, 'Long.pdf')
  await canvasCall(a.page, 'select', [cardId])
  await clickItem(a.page, cardId, { button: 'right' })
  await expect(a.page.getByTestId('context-menu-root')).toBeVisible()
  await a.page.getByRole('menuitem', { name: 'Insert as slides…' }).click()
  const dialog = a.page.getByTestId('deck-import-dialog')
  await expect(dialog.getByTestId('deck-import-truncated')).toHaveText(
    'This file has 101 pages: the first 100 become slides.',
  )
  await expect(dialog.getByTestId('deck-import-insert')).toHaveText('Insert 100 slides')
  await dialog.getByTestId('deck-import-insert').click()
  await expect(dialog.getByTestId('deck-import-progress')).toBeVisible()
  await expect(a.page.getByTestId('deck-placed')).toContainText('Placed 100 slides of Long.pdf.', {
    timeout: 360_000,
  })
  const s = await slides(a.page)
  expect(s.frames).toHaveLength(100)
  expect(s.pictures.map((p) => lobbyOf(p).pdfPage).sort((x, y) => Number(x) - Number(y))).toEqual(
    Array.from({ length: 100 }, (_, i) => i + 1),
  )
  const last = s.pictures.find((p) => lobbyOf(p).pdfPage === 100)
  expect(lobbyOf(last as CanvasElement).alt).toBe('Slide 100 of 101')
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.02 })
  await expectLoadedImage(a.page, last?.id ?? '', a.page.url().split('/b/')[1] ?? '', 90_000)
  expect(foreign).toEqual([])
})

test('a Keynote file gets the guidance and no request; a guest places the first 8 slides and asks for nothing', async ({
  canvasSession,
  board,
  browser,
  users,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const asks = renderRequests(a.page)
  await deckOn(a.page)
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.25 })
  await insertFiles(a.page, [
    {
      name: 'Talk.key',
      mimeType: 'application/x-iwork-keynote-sffkey',
      buffer: Buffer.from('PK\u0003\u0004 not a deck'),
    },
    await makePdf('Guest deck.pdf', 12),
  ])
  await test.step('Keynote: export to PDF or PowerPoint first', async () => {
    await expect(fileCard(a.page, 'Talk.key')).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
    const key = (await cardItems(a.page)).find((c) => c.facts.name === 'Talk.key')
    expect(key?.facts.kind).toBe('other')
    await canvasCall(a.page, 'select', [key?.id ?? ''])
    await clickItem(a.page, key?.id ?? '', { button: 'right' })
    await a.page.getByRole('menuitem', { name: 'Insert as slides…' }).click()
    const dialog = a.page.getByTestId('deck-import-dialog')
    await expect(dialog.getByTestId('deck-import-keynote')).toHaveText(
      'Keynote files can’t be made into slides here. Export to PDF or PowerPoint first (in Keynote: File › Export To), then add that file to the board.',
    )
    await expect(dialog.getByTestId('deck-import-insert')).toHaveCount(0)
    await dialog.getByTestId('deck-import-close').click()
    await expect(dialog).toHaveCount(0)
    expect(asks).toEqual([])
    expect((await slides(a.page)).frames).toHaveLength(0)
  })

  await test.step('a name-only guest with an editor link: the first 8 slides, no request', async () => {
    await readyCardId(a.page, 'Guest deck.pdf')
    const aliceApi = await users.api('alice')
    const made = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'editor',
      allowGuests: true,
      expiresInHours: 3,
    })
    expect(made.status()).toBe(201)
    const link = ((await made.json()) as { url: string }).url
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
    try {
      const g = await context.newPage()
      const guestAsks = renderRequests(g)
      const foreign = foreignRequests(g)
      await g.goto(link)
      await g.getByTestId('invite-guest-name').fill('Sam')
      await g.getByTestId('invite-guest-join').click()
      await expect(g).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
      await waitForCanvas(g)
      await deckOn(g)
      await setViewport(g, { x: -200, y: -200, zoom: 0.25 })
      await expect(fileCard(g, 'Guest deck.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
      await fileCard(g, 'Guest deck.pdf').getByTestId('file-card-view-pages').click()
      await g.getByTestId('pdf-viewer-insert-slides').click()
      const dialog = g.getByTestId('deck-import-dialog')
      await expect(dialog.getByTestId('deck-import-guests')).toHaveText(
        'Guests can place the first 8 slides. Slides past 8 are made by editors with an account.',
      )
      await expect(dialog.getByTestId('deck-import-insert')).toHaveText('Insert 8 slides')
      await dialog.getByTestId('deck-import-insert').click()
      await expect(g.getByTestId('deck-placed')).toContainText('Placed 8 slides of Guest deck.pdf.')
      expect(guestAsks).toEqual([])
      await expect.poll(async () => (await slides(a.page)).frames.length).toBe(8)
      expect(foreign).toEqual([])
    } finally {
      await context.close()
    }
  })
})
