// Helpers for the ported tags specs (tags-*.spec.ts; the port of tests/support/tags.ts). Storage on the
// new canvas: one `customData.lobby['tag:<key>']` per tag on an element and the board's list as lb_doc
// `tagDef:<key>` keys. Reads go through the facade (`window.lobbyCanvas`) and the feature's own runtime
// (`window.__lobbyTags`, behind the same local-dev guard as the board page's debug handle), which also
// seeds boards (the UI path is tested on its own). Chips are DOM in the overlay: a `tag-box` per element.
import { type Browser, type BrowserContext, expect, type Locator, type Page } from '@playwright/test'
import {
  canvasCall,
  createItem,
  itemBounds,
  sceneToScreen,
  select,
  viewport,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { readPng } from '../tests/support/present-export.ts'
import { settled } from './board-kit.ts'
import { hostSlot } from './mindmap-kit.ts'

export { hostSlot }

export interface Tag {
  key: string
  name: string
  color: string
}
export const tag = (key: string, name: string, color = 'blue'): Tag => ({ key, name, color })

/** The feature is mounted (its runtime and its colour stylesheet are on the page). */
export async function tagsReady(page: Page) {
  await expect(page.getByTestId('tag-colors')).toBeAttached()
  await page.waitForFunction(() => !!(window as unknown as { __lobbyTags?: unknown }).__lobbyTags)
}

/** Lists tags on the board (lb_doc), as the panel's "New tag" would. */
export async function listOnBoard(page: Page, tags: Tag[]) {
  await page.evaluate((list) => {
    const t = (
      window as unknown as {
        __lobbyTags: { rt: { canvas: { doc: { set(e: Record<string, unknown>): void } } } }
      }
    ).__lobbyTags
    t.rt.canvas.doc.set(
      Object.fromEntries(list.map((x) => [`tagDef:${x.key}`, { name: x.name, color: x.color }])),
    )
  }, tags)
}

/**
 * Puts tags on elements (their definitions listed first, in the same push): test setup, one transact
 * like the picker's.
 */
export async function tagElements(page: Page, byId: Record<string, Tag[]>) {
  await page.evaluate((map) => {
    type Canvas = {
      doc: { set(e: Record<string, unknown>): void; get(k: string): unknown }
      transact(label: string, fn: (tx: { update(id: string, p: unknown): void }) => void): void
    }
    const c = (window as unknown as { __lobbyTags: { rt: { canvas: Canvas } } }).__lobbyTags.rt.canvas
    const defs: Record<string, unknown> = {}
    for (const list of Object.values(map))
      for (const x of list)
        if (!c.doc.get(`tagDef:${x.key}`)) defs[`tagDef:${x.key}`] = { name: x.name, color: x.color }
    if (Object.keys(defs).length) c.doc.set(defs)
    c.transact('seed tags', (tx) => {
      for (const [id, list] of Object.entries(map)) {
        if (!list.length) continue
        tx.update(id, {
          customData: {
            lobby: Object.fromEntries(list.map((x) => [`tag:${x.key}`, { name: x.name, color: x.color }])),
          },
        })
      }
    })
  }, byId)
}

/** Tag keys stored on an element (sorted), as this tab holds it. */
export const storedTagKeys = (page: Page, id: string) =>
  page.evaluate((elementId) => {
    const f = (
      window as unknown as {
        lobbyCanvas: { get(id: string): { customData?: { lobby?: Record<string, unknown> } } | null }
      }
    ).lobbyCanvas
    return Object.keys(f.get(elementId)?.customData?.lobby ?? {})
      .filter((k) => k.startsWith('tag:'))
      .map((k) => k.slice('tag:'.length))
      .sort()
  }, id)

/** The board's tag list (lb_doc) as this tab holds it: key → { name, color }. */
export const boardList = (page: Page) =>
  page.evaluate(() => {
    const t = (
      window as unknown as {
        __lobbyTags: {
          rt: { canvas: { doc: { entries(p: string): Map<string, { name: string; color: string }> } } }
        }
      }
    ).__lobbyTags
    const out: Record<string, { name: string; color: string }> = {}
    for (const [k, v] of t.rt.canvas.doc.entries('tagDef:')) if (v) out[k.slice('tagDef:'.length)] = v
    return out
  })

/** An element's chip box in the overlay. */
export const tagBox = (page: Page, id: string) =>
  page.locator(`[data-testid="tag-box"][data-element-id="${id}"]`)
/** The named chips drawn for an element. */
export const chips = (page: Page, id: string) => tagBox(page, id).locator('[data-testid="tag-chip"]')
export const chipKeys = async (page: Page, id: string) =>
  (await chips(page, id).evaluateAll((els) => els.map((e) => e.getAttribute('data-tag-key') ?? ''))).sort()
export const lod = (page: Page) => page.getByTestId('tag-scene').getAttribute('data-dr-tags-lod')

/** Selects elements (the bar shows under them when 3a's shell is on the page). */
export async function selectIds(page: Page, ids: readonly string[]) {
  await select(page, [...ids])
  await expect.poll(() => canvasCall(page, 'selection')).toEqual([...ids])
  if (await hostSlot(page, 'selectionBar')) await expect(page.getByTestId('selection-bar')).toBeVisible()
}

/**
 * Opens the picker: the selection bar's Tags button when 3a's shell is on the page, else the feature's
 * own command (what the context menu's "Tags…" runs).
 */
export async function openPicker(page: Page): Promise<Locator> {
  const picker = page.getByTestId('tag-picker')
  if (!(await picker.isVisible())) {
    const button = page.getByTestId('selection-tags')
    if ((await button.count()) > 0) await button.click()
    else
      await page.evaluate(() =>
        (window as unknown as { __lobbyTags: { rt: { openPicker(): void } } }).__lobbyTags.rt.openPicker(),
      )
  }
  await expect(picker).toBeVisible()
  return picker
}

export const option = (page: Page, key: string) =>
  page.locator(`[data-testid="tag-picker"] [data-testid="tag-option"][data-tag-key="${key}"]`)

/** Opens the Tags dock panel. */
export async function openTagsPanel(page: Page) {
  const panel = page.getByTestId('tags-panel')
  if (!(await panel.isVisible())) {
    // On a phone the rail is folded behind one button (R13).
    const toggle = page.getByTestId('dock-rail-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await page.getByTestId('dock-tab-tags').click()
  }
  await expect(panel).toBeVisible()
  return panel
}

export const row = (page: Page, key: string) =>
  page.locator(`[data-testid="tags-panel"] [data-testid="tag-row"][data-tag-key="${key}"]`)

/** Puts the camera's centre on a scene point at an exact zoom. */
export async function cameraAt(page: Page, center: { x: number; y: number }, zoom: number) {
  await canvasCall(page, 'setViewport', { zoom })
  await expect.poll(async () => (await viewport(page)).zoom).toBeCloseTo(zoom, 3)
  const v = await viewport(page)
  await canvasCall(page, 'setViewport', { x: center.x - v.width / 2, y: center.y - v.height / 2 })
  await expect.poll(async () => Math.round((await viewport(page)).x)).toBe(Math.round(center.x - v.width / 2))
}

export const N1 = 'tg-1'
export const N2 = 'tg-2'
export const N3 = 'tg-3'

/**
 * Three sticky notes in a row, 260 apart (the tldraw spec's), Saved after each (board-kit `settled`: spike
 * B's open O2 race).
 */
export async function threeNotes(page: Page) {
  for (const [id, x, text] of [
    [N1, 0, 'Checkout is slow'],
    [N2, 260, 'Search finds nothing'],
    [N3, 520, 'Love the new dashboard'],
  ] as const)
    await settled(page, createItem(page, 'note', { id, x, y: 0, text }))
}

/** Waits until every id exists on `page`. */
export async function seen(page: Page, ids: readonly string[]) {
  for (const id of ids) await waitForItem(page, id)
}

/** A rectangle (a shape: its chips sit above it). */
export const createShape = (page: Page, x: number, y: number) =>
  createItem(page, 'rectangle', { x, y, width: 200, height: 100 })

/** An element's rectangle on screen (client px). */
export async function screenBox(page: Page, id: string) {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`no bounds for ${id}`)
  const tl = await sceneToScreen(page, { x: b.x, y: b.y })
  const br = await sceneToScreen(page, { x: b.x + b.width, y: b.y + b.height })
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
}

/** The colour on screen at a client point (one screenshot pixel). */
export async function pixelAt(page: Page, p: { x: number; y: number }): Promise<[number, number, number]> {
  const buf = await page.screenshot({ clip: { x: Math.round(p.x), y: Math.round(p.y), width: 1, height: 1 } })
  const px = readPng(buf).topLeft
  if (!px) throw new Error('could not read the pixel')
  return [px[0], px[1], px[2]]
}

/** A spot inside a note away from its words and chips (lower left). */
export async function quietSpot(page: Page, id: string) {
  const b = await screenBox(page, id)
  return { x: b.x + b.width * 0.12, y: b.y + b.height * 0.9 }
}

/** Distance of a colour from white (0 = white). */
export const fromWhite = (c: readonly number[]) => Math.max(...c.map((v) => 255 - v))

/** Ids with a hole in the "Show only" veil (the elements that stay visible), or null without a veil. */
export async function veilHoles(page: Page): Promise<string[] | null> {
  const veil = page.getByTestId('tag-filter-veil')
  if ((await veil.count()) === 0) return null
  const ids = (await veil.getAttribute('data-holes')) ?? ''
  return ids.split(' ').filter(Boolean).sort()
}

// ---- name-only guests (as in tests/support/tags.ts) ------------------------------------------------

/** A fresh context with no sign-in that joins `link` with just a name, on the new canvas. */
export async function joinAsGuest(
  browser: Browser,
  link: string,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForCanvas(page)
  await expect.poll(async () => (await canvasCall(page, 'me'))?.guest).toBe(true)
  return { context, page }
}

/** Whether the element's box lies inside the browser viewport (with a margin). */
export async function insideViewport(page: Page, selector: string, margin = 0) {
  const box = await page.locator(selector).boundingBox()
  const vp = page.viewportSize()
  if (!box || !vp) return false
  return (
    box.x >= margin &&
    box.y >= margin &&
    box.x + box.width <= vp.width - margin &&
    box.y + box.height <= vp.height - margin
  )
}
