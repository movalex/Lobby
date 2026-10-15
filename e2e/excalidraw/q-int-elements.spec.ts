// Wave Q, the integration: the Elements panel as it ships (ELEMENTS_PANEL on, no dev override), with WS1's generated
// icon sets served under /lobby-assets/icons/, WS2's real library api, WS4's kits and import, against the real api and
// sync server. What must hold:
//  - an icon found by search is inserted as native elements in one group (no second group around it), recoloured from
//    the style panel, resized by its handle, and each step undone on its own; a second tab follows; the icon files
//    come from the same origin; nothing leaves Lobby's own origins;
//  - every Shapes category lists its pieces with a drawing each, and its first piece goes on the board;
//  - a selection holding an IMAGE saved to the workspace library is placed on ANOTHER board of the workspace (/place
//    links the file first) and the image loads there;
//  - permissions: a member inserts; a member without a work address cannot save to the workspace library but saves to
//    their own; a name-only guest has Icons and Shapes only;
//  - a second person sees, after a refresh, the library item the first saved;
//  - an `.excalidrawlib` imported through the Library tab's file input is inserted;
//  - on a phone the panel is a sheet, and a tap inserts an icon.
//
//   E2E_PORT_BASE=7700 pnpm exec playwright test excalidraw/q-int- --project=chromium --workers=1   (from e2e/)
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page, Request, Response } from '@playwright/test'
import { PIECE_CATEGORIES, PIECES } from '../../packages/templates/src/pieces/catalog.ts'
import { Api, signInContext } from '../tests/support/api.ts'
import {
  type CanvasElement,
  createItem,
  expect,
  expectConverged,
  expectSaved,
  items,
  pushedOps,
  sceneToScreen,
  select,
  selection,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { freshHandle } from '../tests/support/dashboard-share.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { PHONE, scrollsSideways } from './a11y-kit.ts'
import { showStylePanel } from './canvas-ux-kit.ts'
import { createGuestLink, guestOn, tokenOf } from './guests-kit.ts'
import { allIds, expectLoadedImage, imageItems, insertFiles, newItems } from './media-kit.ts'
import { undoKey } from './navigation-kit.ts'
import { foreignRequests, openElements, tab, tile, tileIds } from './q3-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })
test.describe.configure({ timeout: 180_000 })

const LIBRARY_FIXTURES = fileURLToPath(
  new URL('../../apps/web/src/canvas/library/fixtures/', import.meta.url),
)

type Lobby = { kind?: string; alt?: string }
const lobbyOf = (e: CanvasElement) => (e.customData as { lobby?: Lobby } | undefined)?.lobby
const kindOf = (e: CanvasElement) => lobbyOf(e)?.kind
const iconEls = async (page: Page, alt?: string) =>
  (await items(page)).filter((e) => kindOf(e) === 'icon' && (!alt || lobbyOf(e)?.alt === alt))

/** The box of a set of elements (linear elements by their points). */
function boxOf(els: readonly CanvasElement[]) {
  const xs: number[] = []
  const ys: number[] = []
  for (const e of els) {
    const pts = (e as { points?: [number, number][] }).points
    if (pts) {
      for (const [px, py] of pts) {
        xs.push(e.x + px)
        ys.push(e.y + py)
      }
    } else {
      xs.push(e.x, e.x + e.width)
      ys.push(e.y, e.y + e.height)
    }
  }
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The library item tiles of the Library tab's results, by name. */
const itemTile = (page: Page, name: string) =>
  page
    .getByTestId('element-section-results')
    .locator('[data-testid="element-tile"][data-source="item"]')
    .filter({ hasText: name })
    .first()

/** Saves the current selection from the selection bar, to `scope`, as `name`. */
async function saveSelection(page: Page, name: string, scope: 'workspace' | 'personal') {
  await page.getByTestId('selection-save-to-library').click()
  await expect(page.getByTestId('element-save-dialog')).toBeVisible()
  await page.getByTestId('element-save-name').fill(name)
  await page.getByTestId(`element-save-scope-${scope}`).check()
  await page.getByTestId('element-save-submit').click()
  await expect(page.getByTestId('element-saved')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('element-save-dialog')).toHaveCount(0)
}

/** Every request a context's pages make to the library api. */
function libraryRequests(context: BrowserContext): string[] {
  const seen: string[] = []
  context.on('request', (r: Request) => {
    if (/\/library(\/|\?|$)/.test(new URL(r.url()).pathname)) seen.push(`${r.method()} ${r.url()}`)
  })
  return seen
}

test('Q-int: a real icon is found, inserted as one group, recoloured, resized and undone step by step; a second tab follows', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const icons: { url: string; status: number; type: string }[] = []
  a.page.on('response', (r: Response) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/lobby-assets/icons/'))
      icons.push({ url: u.pathname, status: r.status(), type: r.headers()['content-type'] ?? '' })
  })
  // P-021: the style panel opens on request; this person has it open (reloads the board)
  await showStylePanel(a.page)
  const b = await canvasSession('bob')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })

  await test.step('the Elements panel is the board’s (the Shapes dock entry has gone); search finds the real icon', async () => {
    await expect(a.page.getByTestId('dock-tab-elements')).toBeVisible({ timeout: 30_000 })
    await expect(a.page.getByTestId('dock-tab-pieces')).toHaveCount(0)
    await openElements(a.page)
    await a.page.getByTestId('element-search').fill('arrow right')
    await expect(tile(a.page, 'icon', 'lucide:arrow-right')).toBeVisible({ timeout: 20_000 })
    // a Tabler category narrows the icons
    await a.page.locator('[data-testid="element-chip"][data-chip="tabler"]').click()
    await expect(a.page.getByTestId('element-icon-category')).toBeVisible()
    await a.page.locator('[data-testid="element-chip"][data-chip="all"]').click()
  })

  const alt = 'Lucide icon: arrow-right'
  let parts: CanvasElement[] = []
  await test.step('a click inserts it as native elements in ONE group, selected, at the default ink', async () => {
    await tile(a.page, 'icon', 'lucide:arrow-right').click()
    await expect.poll(async () => (await iconEls(a.page, alt)).length).toBeGreaterThan(0)
    await expectSaved(a.page)
    parts = await iconEls(a.page, alt)
    expect(parts.every((p) => p.type === 'line')).toBe(true)
    expect(new Set(parts.map((p) => (p.groupIds as string[]).join())).size).toBe(1)
    expect((parts[0]?.groupIds as string[] | undefined)?.length).toBe(1)
    await expect
      .poll(async () => [...(await selection(a.page))].sort())
      .toEqual(parts.map((p) => p.id).sort())
    await expect.poll(async () => (await iconEls(b.page, alt)).length).toBe(parts.length)
    // its index and shard came from this origin, as JSON
    expect(icons.some((i) => /\/index\.[0-9a-f]+\.json$/.test(i.url) && i.status === 200)).toBe(true)
    expect(icons.some((i) => /\/shard-\d+\.[0-9a-f]+\.json$/.test(i.url) && i.status === 200)).toBe(true)
    for (const i of icons) expect(i.type, i.url).toMatch(/^application\/json/)
  })
  const ink = parts[0]?.strokeColor
  const box0 = boxOf(parts)

  await test.step('the style panel’s blue recolours every part in one step', async () => {
    await select(
      a.page,
      parts.map((p) => p.id),
    )
    await a.page.getByTestId('style.color.blue').click()
    await expect
      .poll(async () => (await iconEls(a.page, alt)).map((p) => p.strokeColor))
      .toEqual(parts.map(() => '#4465e9'))
    await expectSaved(a.page)
  })

  await test.step('the bottom-right handle makes it bigger', async () => {
    const corner = await sceneToScreen(a.page, { x: box0.x + box0.w, y: box0.y + box0.h })
    // the selection box of a group sits a few px outside its elements
    const handle = { x: corner.x + 8, y: corner.y + 8 }
    await a.page.mouse.move(handle.x, handle.y)
    await a.page.mouse.down()
    for (let i = 1; i <= 8; i++) await a.page.mouse.move(handle.x + i * 12, handle.y + i * 12)
    await a.page.mouse.up()
    await expect.poll(async () => boxOf(await iconEls(a.page, alt)).w).toBeGreaterThan(box0.w + 40)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })

  await test.step('Ctrl+Z undoes the resize, then the colour, then the insert; the second tab follows', async () => {
    await undoKey(a.page)
    await expect.poll(async () => Math.round(boxOf(await iconEls(a.page, alt)).w)).toBe(Math.round(box0.w))
    await undoKey(a.page)
    await expect
      .poll(async () => (await iconEls(a.page, alt)).map((p) => p.strokeColor))
      .toEqual(parts.map(() => ink))
    await undoKey(a.page)
    await expect.poll(async () => (await iconEls(a.page, alt)).length).toBe(0)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })

  expect(foreign).toEqual([])
})

test('Q-int: every Shapes category lists its pieces, each with a drawing, and its first piece goes on the board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: 0, y: 0, zoom: 0.5 })
  await openElements(a.page)
  await tab(a.page, 'shapes').click()
  let drawn = 0
  for (const c of PIECE_CATEGORIES) {
    await test.step(`${c.label}`, async () => {
      await a.page.locator(`[data-testid="element-chip"][data-chip="${c.id}"]`).click()
      const want = PIECES.filter((p) => p.category === c.id).map((p) => p.id)
      await expect.poll(async () => [...(await tileIds(a.page))].sort()).toEqual([...want].sort())
      // each tile's drawing holds shapes (none is blank)
      const blank = await a.page
        .getByTestId('element-section-results')
        .locator('[data-testid="element-tile"][data-source="piece"]')
        .evaluateAll((tiles) =>
          tiles
            .filter(
              (t) => !t.querySelector('svg[data-piece-preview] :is(rect, ellipse, polygon, polyline, path)'),
            )
            .map((t) => t.getAttribute('data-tile-id')),
        )
      expect(blank, `${c.id}: tiles without a drawing`).toEqual([])
      drawn += want.length
      const first = (await tileIds(a.page))[0] as string
      await tile(a.page, 'piece', first).click()
      await expect
        .poll(async () => (await items(a.page)).filter((e) => kindOf(e) === `piece-${first}`).length)
        .toBeGreaterThan(0)
      await openElements(a.page)
    })
  }
  expect(drawn).toBe(PIECES.length)
  expect(PIECES.length).toBe(84)
  await expectSaved(a.page)
})

test('Q-int: a selection with an image saved to the workspace library is placed on another board of the workspace, and the image loads there', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const before = await allIds(a.page)
  await insertFiles(a.page, [join(FIXTURES_DIR, 'image.png')])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image')
  await expectLoadedImage(a.page, img.id, board)
  const rect = await createItem(a.page, 'rectangle', {
    x: img.x + img.width + 40,
    y: img.y,
    width: 160,
    height: 100,
  })
  await expectSaved(a.page)

  await test.step('saved to the workspace library with the image', async () => {
    await select(a.page, [img.id, rect])
    await a.page.getByTestId('selection-save-to-library').click()
    await expect(a.page.getByTestId('element-save-images')).toBeVisible()
    await a.page.getByTestId('element-save-dialog').getByTestId('element-save-name').fill('Hero shot')
    await expect(a.page.getByTestId('element-save-scope-workspace')).toBeChecked()
    await a.page.getByTestId('element-save-submit').click()
    await expect(a.page.getByTestId('element-saved')).toBeVisible({ timeout: 20_000 })
  })

  const other = await users.createBoard('Q-int target')
  await a.page.goto(`/b/${other}`)
  await waitForCanvas(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const order: string[] = []
  a.page.on('request', (r: Request) => {
    if (/\/library\/items\/lbi_[0-9A-Za-z]+\/place$/.test(new URL(r.url()).pathname)) order.push('place')
  })

  await test.step('placed from the Library tab on the other board: /place first, then the push; the image loads', async () => {
    await openElements(a.page)
    await tab(a.page, 'library').click()
    await expect(itemTile(a.page, 'Hero shot')).toBeVisible({ timeout: 20_000 })
    const pushesBefore = (await pushedOps(a.page)).length
    await itemTile(a.page, 'Hero shot').click()
    const [placed] = await newItems(a.page, imageItems, new Set(), 1)
    if (!placed) throw new Error('not placed')
    expect(order).toEqual(['place'])
    expect((await pushedOps(a.page)).length).toBeGreaterThan(pushesBefore)
    // the same stored version, now linked to this board
    expect(placed.facts.versionId).toBe(img.facts.versionId)
    expect(placed.id).not.toBe(img.id)
    await expectLoadedImage(a.page, placed.id, other)
    expect((await items(a.page)).filter((e) => e.type === 'rectangle')).toHaveLength(1)
    await expectSaved(a.page)
  })

  await test.step('a fresh tab of the other board loads it too (the room accepted the file reference)', async () => {
    await a.page.reload()
    await waitForCanvas(a.page)
    const [again] = await newItems(a.page, imageItems, new Set(), 1)
    if (!again) throw new Error('gone after a reload')
    await expectLoadedImage(a.page, again.id, other)
  })
})

test('Q-int: a member inserts and saves to the workspace library; a second person sees it after a refresh', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await setViewport(b.page, { x: 0, y: 0, zoom: 1 })

  await test.step('bob (a member with a work address) inserts an icon', async () => {
    await openElements(b.page)
    await b.page.getByTestId('element-search').fill('star')
    await tile(b.page, 'icon', 'lucide:star').click()
    await expect.poll(async () => (await iconEls(b.page, 'Lucide icon: star')).length).toBeGreaterThan(0)
    await expectSaved(b.page)
  })

  await test.step('he saves it to the workspace library', async () => {
    const ids = (await iconEls(b.page, 'Lucide icon: star')).map((e) => e.id)
    await select(b.page, ids)
    await saveSelection(b.page, 'Bob’s star', 'workspace')
  })

  await test.step('alice’s open Library tab has it after a refresh', async () => {
    await openElements(a.page)
    await tab(a.page, 'library').click()
    await a.page.reload()
    await waitForCanvas(a.page)
    await openElements(a.page)
    await tab(a.page, 'library').click()
    await expect(itemTile(a.page, 'Bob’s star')).toBeVisible({ timeout: 20_000 })
    const stars = (await iconEls(a.page, 'Lucide icon: star')).length
    await itemTile(a.page, 'Bob’s star').click()
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: star')).length).toBe(2 * stars)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('Q-int: a member without a work address cannot save to the workspace library (nor does the api let them), but saves to their own', async ({
  browser,
  board,
  playwright,
  users,
}) => {
  const handle = freshHandle('qio')
  const email = 'qio@client.example.test'
  // a Dev Studio member first (a dev sign-in without an address is a creator), then signed in with an outside address:
  // the same account, a member still, no longer a creator
  const first = await Api.signIn(playwright, handle, 'Quinn Outside')
  await (await users.api('alice')).putMember(board, first.me.user.id, 'editor')
  await first.api.dispose()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const me = await signInContext(context, handle, 'Quinn Outside', { email })
    expect(me.access).toMatchObject({ creator: false, reason: 'outside' })
    const page = await context.newPage()
    let saved: Record<string, unknown> | null = null
    page.on('request', (r: Request) => {
      if (r.method() === 'POST' && /\/library\/items$/.test(new URL(r.url()).pathname))
        saved = r.postDataJSON() as Record<string, unknown>
    })
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    await setViewport(page, { x: 0, y: 0, zoom: 1 })
    await openElements(page)
    await expect(tab(page, 'library')).toBeVisible()
    await page.getByTestId('element-search').fill('check')
    await tile(page, 'icon', 'lucide:check').click()
    await expect.poll(async () => (await iconEls(page, 'Lucide icon: check')).length).toBeGreaterThan(0)
    await expectSaved(page)
    await select(
      page,
      (await iconEls(page, 'Lucide icon: check')).map((e) => e.id),
    )
    await page.getByTestId('selection-save-to-library').click()
    await expect(page.getByTestId('element-save-scope-workspace')).toBeDisabled()
    await expect(page.getByTestId('element-save-workspace-reason')).toContainText('needs a work address')
    await page.getByTestId('element-save-name').fill('My tick')
    await expect(page.getByTestId('element-save-scope-personal')).toBeChecked()
    await page.getByTestId('element-save-submit').click()
    await expect(page.getByTestId('element-saved')).toContainText('to your library')
    // the api refuses the workspace scope for them on its own: the same save, sent again as a workspace one
    expect(saved).toMatchObject({ scope: 'personal', sourceBoardId: board })
    const refused = await page.evaluate(
      async ({ wid, body }) => {
        const r = await fetch(`/api/workspaces/${wid}/library/items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, scope: 'workspace' }),
        })
        return { status: r.status, code: ((await r.json()) as { error?: { code?: string } }).error?.code }
      },
      { wid: users.devStudioId, body: saved as unknown as Record<string, unknown> },
    )
    expect(refused.status).toBe(403)
    expect(refused.code).toBe('CREATOR_REQUIRED')
    // their own library has it; the workspace's does not
    await openElements(page)
    await tab(page, 'library').click()
    await page.getByTestId('element-search').fill('')
    await page.locator('[data-testid="element-scope"][data-scope="personal"]').click()
    await expect(itemTile(page, 'My tick')).toBeVisible({ timeout: 20_000 })
    await page.locator('[data-testid="element-scope"][data-scope="workspace"]').click()
    await expect(page.getByTestId('element-section-results').getByText('My tick')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('Q-int: a name-only guest has Icons and Shapes only, inserts both, and asks the library api nothing', async ({
  browser,
  board,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const link = await createGuestLink(a.page, board, 'workshop')
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  try {
    const library = libraryRequests(context)
    const g = (await guestOn(context, tokenOf(link), 'Gus')).page
    await expect(g.getByTestId('dock-tab-elements')).toBeVisible({ timeout: 30_000 })
    await openElements(g)
    await expect(g.locator('[data-testid="element-tab"]')).toHaveCount(2)
    await expect(tab(g, 'icons')).toBeVisible()
    await expect(tab(g, 'shapes')).toBeVisible()
    await expect(tab(g, 'library')).toHaveCount(0)
    await g.getByTestId('element-search').fill('heart')
    await tile(g, 'icon', 'lucide:heart').click()
    await expect.poll(async () => (await iconEls(g, 'Lucide icon: heart')).length).toBeGreaterThan(0)
    await openElements(g)
    await tab(g, 'shapes').click()
    await g.getByTestId('element-search').fill('decision')
    await tile(g, 'piece', 'decision').click()
    await expect
      .poll(async () => (await items(g)).filter((e) => kindOf(e) === 'piece-decision').length)
      .toBe(2)
    await expectSaved(g)
    await expect.poll(async () => (await iconEls(a.page, 'Lucide icon: heart')).length).toBeGreaterThan(0)
    // the selection bar offers no Save to library to a guest
    await select(
      g,
      (await iconEls(g, 'Lucide icon: heart')).map((e) => e.id),
    )
    await expect(g.getByTestId('selection-save-to-library')).toHaveCount(0)
    expect(library).toEqual([])
  } finally {
    await context.close()
  }
})

test('Q-int: an .excalidrawlib imported through the Library tab goes into my library and onto the board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const foreign = foreignRequests(a.page)
  await openElements(a.page)
  await tab(a.page, 'library').click()
  await a.page.locator('[data-testid="element-scope"][data-scope="personal"]').click()
  await a.page.getByTestId('element-folder-actions').click()
  const chooser = a.page.waitForEvent('filechooser')
  await a.page.locator('[data-testid="element-menu"] [data-action="import"]').click()
  await (await chooser).setFiles(join(LIBRARY_FIXTURES, 'flowchart-bits.excalidrawlib'))
  await expect(a.page.getByTestId('element-imported')).toContainText('to your library', { timeout: 30_000 })
  await expect(itemTile(a.page, 'Decision')).toBeVisible({ timeout: 20_000 })
  const before = (await items(a.page)).length
  await itemTile(a.page, 'Decision').click()
  await expect.poll(async () => (await items(a.page)).length).toBe(before + 2)
  await expectSaved(a.page)
  await undoKey(a.page)
  await expect.poll(async () => (await items(a.page)).length).toBe(before)
  await expectSaved(a.page)
  expect(foreign).toEqual([])
})

test('Q-int phone: the panel is a full-width sheet; a tap on an icon inserts it and the sheet closes', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  try {
    await signInContext(context, alice.handle, alice.name)
    const page = await context.newPage()
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    await page.getByTestId('dock-rail-toggle').tap()
    await page.getByTestId('dock-tab-elements').tap()
    const sheet = page.getByTestId('dock-panel-elements')
    await expect(sheet).toBeVisible()
    const b = await sheet.boundingBox()
    expect(Math.round(b?.x ?? -1)).toBe(0)
    expect(Math.round(b?.width ?? 0)).toBe(PHONE.width)
    await page.getByTestId('element-search').fill('house')
    await expect(tile(page, 'icon', 'lucide:house')).toBeVisible({ timeout: 20_000 })
    await tile(page, 'icon', 'lucide:house').tap()
    await expect.poll(async () => (await iconEls(page, 'Lucide icon: house')).length).toBeGreaterThan(0)
    await expect(page.getByTestId('dock-panel-elements')).toHaveCount(0)
    await expectSaved(page)
    expect(await scrollsSideways(page)).toBe(false)
  } finally {
    await context.close()
  }
})
