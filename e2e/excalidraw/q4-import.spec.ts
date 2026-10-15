// Wave Q, WS4: importing an `.excalidrawlib`, with the REAL engine reading the file in a real browser (the same fixture
// files the unit tests read through a stand-in reader: apps/web/src/canvas/library/fixtures). What must hold:
//  - a v2 library in the current shape, and a v1 library in the legacy shape, become an ImportLibraryInput the
//    contracts' schema accepts, one item per library item, with the old fonts mapped and the labels laid out again;
//  - the body goes to the (mocked) import route, whose answer is read with the contracts' own response schema;
//  - what the import produces is what the room accepts: an imported item is inserted on the board in one undo step,
//    a second tab sees it, and nothing is rolled back;
//  - an outside library's pictures, embeds, iframes, foreign customData and data:/javascript: links are left out, with
//    counts for the dialog;
//  - a file that is not a library, a future version, an image or over 5 MB is refused;
//  - no request leaves Lobby's own origins while the file is read.
//
//   E2E_PORT_BASE=7780 pnpm exec playwright test excalidraw/q4-import --project=chromium --workers=1   (from e2e/)
import type { Page, Request } from '@playwright/test'
import { checkElement } from '../../packages/canvas-schema/src/elements.ts'
import { checkInvariants } from '../../packages/canvas-schema/src/invariants.ts'
import { ImportLibraryInput, ImportLibraryResponse } from '../../packages/contracts/src/library.ts'
import { expect, expectConverged, expectSaved, items, test } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { withCanvas } from './l8-kit.ts'
import { undoKey } from './navigation-kit.ts'
import { fixtureText, loadLibraryModule, normaliseInPage } from './q4-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })
test.describe.configure({ timeout: 240_000 })

const IMPORT_ROUTE = '**/api/workspaces/wsp_q4importtest/library/import'

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

type El = Record<string, unknown>
type Item = { name: string; elements: El[] }
type Text = { type: string; fontFamily?: number }

const itemsOf = (r: { input: { items: unknown[] } }) => r.input.items as Item[]
const fontsOf = (item: Item | undefined) =>
  ((item?.elements ?? []) as Text[]).filter((e) => e.type === 'text').map((e) => e.fontFamily)
const countOf = (list: Item[]) => list.reduce((n, i) => n + i.elements.length, 0)

/** What the import dialog would do after the normaliser: POST the body to the (mocked) route and read the answer. */
async function postImport(page: Page, body: unknown) {
  return await page.evaluate(async (b) => {
    const res = await fetch('/api/workspaces/wsp_q4importtest/library/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
    return { status: res.status, json: await res.json() }
  }, body)
}

/** Inserts each item's elements on the board, one transaction (one undo step) per item, as placing an item does. */
async function insertItems(page: Page, list: Item[]) {
  for (const item of list)
    await withCanvas(
      page,
      (canvas, els) => canvas.transact('insert library item', (tx) => tx.insert(els as never)),
      item.elements,
    )
}

/** Every element passes canvas-schema as the room checks it, and each item passes the cross-element invariants. */
function expectRoomValid(list: Item[]) {
  for (const item of list) {
    for (const e of item.elements) expect(checkElement(e).ok, `${item.name}: ${String(e.type)}`).toBe(true)
    expect(checkInvariants(item.elements as never), item.name).toEqual([])
  }
}

test('Q4: a v2 library in the current shape is read by the engine, normalised, posted to the import route and its items are accepted by the board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  await loadLibraryModule(a.page)

  let posted: unknown = null
  await a.page.route(IMPORT_ROUTE, async (route) => {
    posted = route.request().postDataJSON()
    const n = (posted as { items: unknown[] }).items.length
    await route.fulfill({ status: 200, json: { created: n, skipped: 0, warnings: [] } })
  })

  const file = { text: fixtureText('flowchart-bits.excalidrawlib'), name: 'flowchart-bits.excalidrawlib' }
  const r = await normaliseInPage(a.page, file, { scope: 'workspace', folderId: null })
  if (!r.ok) throw new Error(`refused: ${r.code}`)
  const list = itemsOf(r)

  await test.step('one item per library item, named, with nothing left out', async () => {
    expect(ImportLibraryInput.safeParse(r.input).success).toBe(true)
    expect(r.input.scope).toBe('workspace')
    expect(r.input.fileName).toBe('flowchart-bits.excalidrawlib')
    expect(list.map((i) => i.name)).toEqual([
      'Process step',
      'Decision',
      'Two steps and an arrow',
      'Note to self',
    ])
    expect(r.report).toMatchObject({ itemsInFile: 4, itemsImported: 4, itemsSkipped: 0 })
    expect(r.report.cuts.images + r.report.cuts.embeds + r.report.cuts.invalid).toBe(0)
  })

  await test.step('the old fonts are the ones Lobby serves, and every label sits in its container', async () => {
    expect(list.flatMap(fontsOf).sort()).toEqual([5, 6, 8])
    expect(r.report.cuts.relaid).toBe(3)
    for (const item of list) {
      const ids = new Set(item.elements.map((e) => e.id))
      for (const e of item.elements)
        if (e.type === 'text') expect(ids.has(e.containerId as string), item.name).toBe(true)
    }
  })

  await test.step('every element and every item passes canvas-schema, as the room checks them', async () => {
    expectRoomValid(list)
  })

  await test.step('the mocked import route takes the body and its answer parses as the contracts say', async () => {
    const res = await postImport(a.page, r.input)
    expect(res.status).toBe(200)
    expect(ImportLibraryResponse.parse(res.json)).toEqual({ created: 4, skipped: 0, warnings: [] })
    expect(ImportLibraryInput.safeParse(posted).success).toBe(true)
    expect((posted as { items: unknown[] }).items).toHaveLength(4)
  })

  await test.step('an imported item is accepted: one undo step, the second tab sees it, nothing is rolled back', async () => {
    const before = (await items(a.page)).length
    await insertItems(a.page, list)
    await expectSaved(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(before + countOf(list))
    await expect.poll(async () => (await items(b.page)).length).toBe(before + countOf(list))
    await expectConverged(a.page, [b.page])
    // the arrow of the third item is still bound to that item's own two boxes
    const all = await items(a.page)
    type Binding = { elementId: string }
    const arrows = all.filter((e) => e.type === 'arrow') as unknown as {
      startBinding: Binding
      endBinding: Binding
    }[]
    expect(arrows).toHaveLength(1)
    const byId = new Map(all.map((e) => [e.id, e]))
    expect(byId.get(arrows[0]?.startBinding.elementId as string)?.type).toBe('rectangle')
    expect(byId.get(arrows[0]?.endBinding.elementId as string)?.type).toBe('rectangle')
    // one Ctrl+Z takes the last item away whole
    await undoKey(a.page)
    const last = list.at(-1)?.elements.length ?? 0
    await expect.poll(async () => (await items(a.page)).length).toBe(before + countOf(list) - last)
    await expectSaved(a.page)
  })

  expect(foreign).toEqual([])
})

test('Q4: a v1 library in the legacy element shape is brought up to the pinned engine’s shape and accepted', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  await loadLibraryModule(a.page)
  const file = { text: fixtureText('legacy-v1.excalidrawlib'), name: 'legacy-v1.excalidrawlib' }
  const r = await normaliseInPage(a.page, file, { scope: 'personal' })
  if (!r.ok) throw new Error(`refused: ${r.code}`)
  const list = itemsOf(r)
  // the first item's words name it; the second has no name
  expect(list.map((i) => i.name)).toEqual(['Legacy', 'Imported item 2'])
  expect(r.report).toMatchObject({ itemsInFile: 2, itemsImported: 2, itemsSkipped: 0 })
  // the engine's restore and this module made the old elements whole: none was refused by canvas-schema
  expect(r.report.invalidReasons).toEqual([])
  expect(r.report.cuts.invalid).toBe(0)
  expectRoomValid(list)
  expect([5, 6, 7, 8]).toContain(fontsOf(list[0])[0])

  await test.step('and the room takes the items as they are', async () => {
    const before = (await items(a.page)).length
    await insertItems(a.page, list)
    await expectSaved(a.page)
    await expect.poll(async () => (await items(b.page)).length).toBe(before + countOf(list))
    await expectConverged(a.page, [b.page])
  })
  expect(foreign).toEqual([])
})

test('Q4: an outside library’s pictures, embeds, iframes, foreign data and unsafe links are left out, with counts, and what is left is accepted', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  await loadLibraryModule(a.page)
  const file = { text: fixtureText('unsafe.excalidrawlib'), name: 'unsafe.excalidrawlib' }
  const r = await normaliseInPage(a.page, file, { scope: 'personal' })
  if (!r.ok) throw new Error(`refused: ${r.code}`)
  const list = itemsOf(r)

  const types = list.flatMap((i) => i.elements.map((e) => e.type))
  for (const bad of ['image', 'embeddable', 'iframe', 'magicframe']) expect(types).not.toContain(bad)
  const json = JSON.stringify(r.input)
  expect(json).not.toMatch(/data:|blob:|javascript:/i)
  expect(json).not.toMatch(/lobbyServer|board-card/)
  expect(r.report.cuts).toMatchObject({ images: 2, embeds: 2, links: 2, customData: 1 })
  expect(r.report.itemsWithImages).toBe(2)
  // the item that was only a picture is skipped, the rest import
  expect(r.report.skipped).toEqual([{ index: 2, problem: 'no-elements' }])
  expect(list.map((i) => i.name)).toEqual([
    'Links and extra data',
    'A picture and a box',
    'Embeds',
    'An unknown font',
  ])
  expect(r.warnings.join(' ')).toMatch(/2 pictures were left out/)
  expect(fontsOf(list[3])).toEqual([6])

  const before = (await items(a.page)).length
  await insertItems(a.page, list)
  await expectSaved(a.page)
  await expect.poll(async () => (await items(b.page)).length).toBe(before + countOf(list))
  // no link on the board is anything but the one web link
  const links = (await items(a.page)).map((e) => (e as unknown as { link: string | null }).link)
  expect(links.filter(Boolean)).toEqual(['https://example.com/page'])
  expect(foreign).toEqual([])
})

test('Q4: a file that is not a library, a future version, an image or over 5 MB is refused; an empty library says so', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await loadLibraryModule(a.page)
  const refuse = (file: Parameters<typeof normaliseInPage>[1]) =>
    normaliseInPage(a.page, file, { scope: 'personal' })
  const json = (o: unknown) => JSON.stringify(o)
  const notALibrary = { ok: false, code: 'not-a-library' }

  expect(await refuse({ text: 'this is not json', name: 'a.excalidrawlib' })).toEqual(notALibrary)
  const scene = { type: 'excalidraw', version: 2, elements: [] }
  expect(await refuse({ text: json(scene), name: 'scene.excalidraw' })).toEqual(notALibrary)
  const future = { type: 'excalidrawlib', version: 3, libraryItems: [] }
  expect(await refuse({ text: json(future), name: 'future.excalidrawlib' })).toEqual(notALibrary)
  const png = { text: fixtureText('flowchart-bits.excalidrawlib'), name: 'a.png', type: 'image/png' }
  expect(await refuse(png)).toEqual(notALibrary)
  const big = { bytes: 5 * 1024 * 1024 + 1, name: 'big.excalidrawlib' }
  expect(await refuse(big)).toEqual({ ok: false, code: 'too-large' })
  const empty = { type: 'excalidrawlib', version: 2, libraryItems: [] }
  expect(await refuse({ text: json(empty), name: 'empty.excalidrawlib' })).toEqual({
    ok: false,
    code: 'empty',
  })
  expect(foreign).toEqual([])
})
