// Wave L, W8 (L8-3): Pieces, the shape kits, on the real board page against the real api and sync server. What
// must hold: the Pieces panel finds Decision for "dec" and the arrow keys plus Enter insert a piece in the
// middle of the view as native elements in one undo step; a Button dragged from the panel into a frame lands
// inside the frame in one undo step and a second tab sees it; a locked frame takes nothing; the PNG and SVG
// exports include the pieces; no request leaves Lobby's own origins; a viewer has no panel.
//
// A Decision followed by Ctrl+Right making a connected Process is W4's flow building: that test runs where W4's
// key is on the page and says so where it is not.
//
//   E2E_PORT_BASE=7580 pnpm exec playwright test excalidraw/l8-pieces --project=chromium --workers=1   (from e2e/)
import type { Page, Request } from '@playwright/test'
import { PIECES } from '../../packages/templates/src/pieces/catalog.ts'
import {
  type CanvasElement,
  expect,
  expectConverged,
  expectSaved,
  items,
  pushedOps,
  sceneToScreen,
  setViewport,
  test,
  updateItem,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { makeFrame, withCanvas, withShapesPanel } from './l8-kit.ts'
import { focusCanvas, undoKey } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const kindOf = (e: CanvasElement) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind
const pieceEls = async (page: Page, kind: string) => (await items(page)).filter((e) => kindOf(e) === kind)

/** Every request of the page that left Lobby's own origins (none may: the e2e network assertion). */
function foreignRequests(page: Page) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

const openPieces = async (page: Page) => {
  await page.getByTestId('dock-tab-pieces').click()
  await expect(page.getByTestId('pieces-panel')).toBeVisible()
}

/** The Shapes panel on this page (wave Q: the switch off, see l8-kit.ts withShapesPanel). */
const waitForPieces = (page: Page) => withShapesPanel(page)

test('L8-3: the panel lists the kits, finds Decision for "dec", and the arrow keys plus Enter insert a piece in one undo step; a second tab sees it', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  await waitForPieces(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await openPieces(a.page)
  const options = a.page.getByTestId('piece-option')

  await test.step('every piece is listed with its drawing; the categories and the search narrow them', async () => {
    // (every piece of the catalogue: the 22 of wave L and the kits wave Q adds)
    await expect(options).toHaveCount(PIECES.length)
    await expect(a.page.locator('[data-piece-preview="decision"] polygon')).toHaveCount(1, {
      timeout: 15_000,
    })
    await a.page.locator('[data-testid="piece-category"][data-category="agency"]').click()
    await expect
      .poll(() => options.evaluateAll((els) => els.map((e) => e.getAttribute('data-piece-id'))))
      .toEqual(['shot', 'storyboard', 'persona', 'stage'])
    await a.page.locator('[data-testid="piece-category"][data-category="all"]').click()
    await a.page.getByTestId('piece-search').fill('dec')
    await expect
      .poll(() => options.evaluateAll((els) => els.map((e) => e.getAttribute('data-piece-id'))))
      .toEqual(['decision'])
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    await expect(a.page.getByTestId('piece-search')).toHaveAttribute('aria-activedescendant', /decision$/)
  })

  const before = (await items(a.page)).length
  await test.step('Enter on "dec" inserts a Decision in the middle of the view: a diamond and its words, selected', async () => {
    await a.page.getByTestId('piece-search').press('Enter')
    await expect.poll(async () => (await pieceEls(a.page, 'piece-decision')).length).toBe(2)
    const els = await pieceEls(a.page, 'piece-decision')
    const diamond = els.find((e) => e.type === 'diamond') as CanvasElement
    expect(els.find((e) => e.type === 'text')).toBeTruthy()
    const v = await withCanvas(a.page, (c) => c.viewport.get(), undefined)
    expect(diamond.x + diamond.width / 2).toBeCloseTo(v.x + v.width / 2, -1)
    expect(diamond.y + diamond.height / 2).toBeCloseTo(v.y + v.height / 2, -1)
    expect(await withCanvas(a.page, (c) => [...c.selection], undefined)).toEqual([diamond.id])
    await expectSaved(a.page)
    await expect.poll(async () => (await pieceEls(b.page, 'piece-decision')).length).toBe(2)
  })

  await test.step('ArrowDown and Enter insert the next piece of a longer list', async () => {
    await a.page.getByTestId('piece-search').fill('d')
    const ids = await options.evaluateAll((els) => els.map((e) => e.getAttribute('data-piece-id')))
    expect(ids.length).toBeGreaterThan(2)
    await a.page.getByTestId('piece-search').press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await a.page.getByTestId('piece-search').press('Enter')
    await expect.poll(async () => (await pieceEls(a.page, `piece-${ids[1]}`)).length).toBeGreaterThan(0)
    await expectSaved(a.page)
  })

  await test.step('one Ctrl+Z takes the last piece away, another the Decision; the second tab follows', async () => {
    await undoKey(a.page)
    await undoKey(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(before)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })

  expect(foreign).toEqual([])
})

test('L8-3: a Button dragged from the panel into a frame lands inside it in one undo step, and the second tab sees it; a locked frame takes nothing', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForPieces(a.page)
  const frame = await makeFrame(a.page, 100, 100, 700, 600, 'Screen')
  const locked = await makeFrame(a.page, 900, 100, 500, 600, 'Locked')
  await setViewport(a.page, { x: 0, y: 0, zoom: 0.6 })
  await openPieces(a.page)
  await updateItem(a.page, locked, { locked: true })
  await expectSaved(a.page)

  const dragTo = async (id: string, scene: { x: number; y: number }) => {
    const target = a.page.locator('.excalidraw').first()
    const box = await target.boundingBox()
    if (!box) throw new Error('no canvas box')
    const p = await sceneToScreen(a.page, scene)
    await a.page.locator(`[data-testid="piece-option"][data-piece-id="${id}"]`).dragTo(target, {
      targetPosition: { x: p.x - box.x, y: p.y - box.y },
    })
  }

  await test.step('drop a Button on the frame: every element of it joins the frame, centred on the pointer', async () => {
    const count = (await items(a.page)).length
    await dragTo('button', { x: 400, y: 300 })
    await expect.poll(async () => (await pieceEls(a.page, 'piece-button')).length).toBe(2)
    const els = await pieceEls(a.page, 'piece-button')
    for (const e of els) expect(e.frameId).toBe(frame)
    const box = els.find((e) => e.type === 'rectangle') as CanvasElement
    expect(box.x + box.width / 2).toBeCloseTo(400, -1)
    expect(box.y + box.height / 2).toBeCloseTo(300, -1)
    expect(box.x).toBeGreaterThanOrEqual(100)
    expect(box.x + box.width).toBeLessThanOrEqual(800)
    expect((await items(a.page)).length).toBe(count + 2)
    await expectSaved(a.page)
    // the second tab sees the same button in the same frame
    await expect.poll(async () => (await pieceEls(b.page, 'piece-button')).length).toBe(2)
    for (const e of await pieceEls(b.page, 'piece-button')) expect(e.frameId).toBe(frame)
    await expectConverged(a.page, [b.page])
  })

  await test.step('one Ctrl+Z removes the whole button, and a second tab follows', async () => {
    await undoKey(a.page)
    await expect.poll(async () => (await pieceEls(a.page, 'piece-button')).length).toBe(0)
    await expect.poll(async () => (await pieceEls(b.page, 'piece-button')).length).toBe(0)
  })

  await test.step('a drop on a locked frame lands beside the frame content, not in it', async () => {
    await dragTo('button', { x: 1100, y: 400 })
    await expect.poll(async () => (await pieceEls(a.page, 'piece-button')).length).toBe(2)
    for (const e of await pieceEls(a.page, 'piece-button')) expect(e.frameId).toBeNull()
    await expectSaved(a.page)
  })

  await test.step('a swimlane dropped on the first frame stays on the page (frames do not nest)', async () => {
    await dragTo('swimlane', { x: 450, y: 500 })
    await expect.poll(async () => (await pieceEls(a.page, 'piece-swimlane')).length).toBe(1)
    expect((await pieceEls(a.page, 'piece-swimlane'))[0]?.frameId).toBeNull()
  })
})

// The plan's wording was 'a connected Process'; W4's flow rule (L4-1) is that the next shape takes the source's type and
// style, so a Decision is followed by a connected Decision (Ctrl+Right), as for any other shape.
test('L8-3: a Decision followed by Ctrl+Right makes the next connected shape, of the source’s type (W4’s flow building)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForPieces(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await openPieces(a.page)
  await a.page.getByTestId('piece-search').fill('dec')
  await a.page.getByTestId('piece-search').press('Enter')
  await expect.poll(async () => (await pieceEls(a.page, 'piece-decision')).length).toBe(2)
  await expectSaved(a.page)
  const before = (await items(a.page)).length
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+ArrowRight')
  const grew = await expect
    .poll(async () => (await items(a.page)).length, { timeout: 5_000 })
    .toBeGreaterThan(before)
    .then(
      () => true,
      () => false,
    )
  // W4's flow building is registered since the wave L integration: a Decision that nothing follows is a failure
  expect(grew, 'Ctrl+Right after a Decision made no connected shape (W4’s flow building)').toBe(true)
  const all = await items(a.page)
  const arrow = all.find((e) => e.type === 'arrow') as CanvasElement & {
    startBinding?: { elementId: string }
    endBinding?: { elementId: string }
  }
  const diamond = all.find((e) => e.type === 'diamond' && !e.isDeleted) as CanvasElement
  expect(arrow.startBinding?.elementId).toBe(diamond.id)
  const next = all.find((e) => e.id === arrow.endBinding?.elementId)
  expect(next?.id).not.toBe(diamond.id)
  expect(next?.type).toBe('diamond')
})

test('L8-3: PNG and SVG exports include the pieces, and nothing leaves Lobby’s own origins', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await waitForPieces(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 0.7 })
  await openPieces(a.page)
  const search = a.page.getByTestId('piece-search')
  // a few different kinds: a plain shape, a polygon, a card with an image slot, a frame
  for (const [q, id] of [
    ['decision', 'decision'],
    ['data', 'data'],
    ['card', 'card'],
    ['swimlane', 'swimlane'],
  ] as const) {
    await search.fill(q)
    await search.press('Enter')
    await expect.poll(async () => (await pieceEls(a.page, `piece-${id}`)).length).toBeGreaterThan(0)
  }
  await expectSaved(a.page)
  const ids = (await items(a.page)).map((e) => e.id)

  const svg = await withCanvas(a.page, (c, list) => c.export.svg({ ids: list }), ids)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('Decision?')
  expect(svg).toContain('Card title')
  expect(svg).toContain('Swimlane')
  // the polygon and the diamond are drawn (as paths), and no picture was made up for the empty slot
  expect((svg.match(/<path/g) ?? []).length).toBeGreaterThan(3)
  expect(svg).not.toContain('<image')

  const png = await withCanvas(
    a.page,
    async (c, list) => {
      const blob = await c.export.png({ ids: list })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { type: blob.type, size: blob.size, head: Array.from(bytes.slice(0, 8)) }
    },
    ids,
  )
  expect(png.type).toBe('image/png')
  expect(png.head).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(png.size).toBeGreaterThan(5_000)

  // exporting only a piece's own elements leaves the others out of the picture
  const decision = (await pieceEls(a.page, 'piece-decision')).map((e) => e.id)
  const one = await withCanvas(a.page, (c, list) => c.export.svg({ ids: list }), decision)
  expect(one).toContain('Decision?')
  expect(one).not.toContain('Card title')
  expect(foreign).toEqual([])
})

test('L8-3: a viewer has no Pieces panel, and a piece dropped on their board is refused with the board notice', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  await waitForPieces(a.page)
  await v.page.context().addInitScript(() => localStorage.setItem('lobby.elementsPanel', '0'))
  await v.page.reload()
  await waitForCanvas(v.page)
  await expect(a.page.getByTestId('dock-tab-pieces')).toBeVisible()
  await expect(v.page.getByTestId('dock-tab-pieces')).toHaveCount(0)
  await v.page.evaluate(() => {
    const wrapper = document.querySelector('.excalidraw')
    if (!wrapper) throw new Error('no board')
    const dt = new DataTransfer()
    dt.setData('text/plain', 'lobby-piece:button')
    wrapper.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: 500,
        clientY: 400,
      }),
    )
  })
  await expect(v.page.getByTestId('readonly-drop-notice')).toBeVisible()
  expect((await items(v.page)).length).toBe(0)
  expect((await pushedOps(v.page)).length).toBe(0)
})
