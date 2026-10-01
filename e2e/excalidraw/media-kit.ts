// Helpers for the ported media specs (media-*.spec.ts, wave 3g): inserting and dropping files on the
// Excalidraw board page, the file elements the facade holds, the page's image loader state (through the
// dev-only `window.__lobbyBoard` handle: `canvas.files.status`, `canvas.files.urlOf`, the engine's files
// map) and template scenes pushed like the templates spec does (packages/templates/src/scene).
import type { Locator, Page } from '@playwright/test'
import { installServerTextMetrics } from '../../packages/canvas-schema/src/engine/index.ts'
import type { Ack, Welcome } from '../../packages/canvas-schema/src/protocol.ts'
import { instantiateSceneTemplate } from '../../packages/templates/src/scene/index.ts'
import { forgeSession } from '../spike-b/support/forge.ts'
import { type CanvasElement, expect, items } from '../tests/support/canvas.ts'
import { type FilePayload, fileFromPath } from '../tests/support/files.ts'

installServerTextMetrics()

export const DERIVATIVE_SRC =
  /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_[0-9A-Za-z]{20}\?board=/
export const ORIGINAL_HREF = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original\?board=/

export interface FileFacts {
  assetId: string
  versionId: string
  kind: 'image' | 'pdf' | 'video' | 'other'
  name: string
  mimeType: string
  sizeBytes: number
}

/** A file element (an image, a placed page or a card) as the facade holds it. */
export interface FileItem {
  id: string
  fileId: string
  facts: FileFacts
  x: number
  y: number
  width: number
  height: number
  frameId: string | null
  crop: unknown
  alt: string | null
  pdfPage: number | null
  index: string
}

const PAGE_RE = /\.p\d+(?:@\w+)?$/

export async function fileItems(page: Page): Promise<FileItem[]> {
  const all = await items(page)
  const out: FileItem[] = []
  for (const e of all as (CanvasElement & Record<string, unknown>)[]) {
    const lobby = (e.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby
    const facts = lobby?.file as FileFacts | undefined
    if (e.type !== 'image' || !facts) continue
    out.push({
      id: e.id,
      fileId: String(e.fileId ?? ''),
      facts,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      frameId: (e.frameId as string | null) ?? null,
      crop: e.crop ?? null,
      alt: (lobby?.alt as string | undefined) ?? null,
      pdfPage: (lobby?.pdfPage as number | undefined) ?? null,
      index: String(e.index ?? ''),
    })
  }
  return out
}

/** Plain images (not cards, not placed pages). */
export const imageItems = async (page: Page) =>
  (await fileItems(page)).filter((f) => f.facts.kind === 'image' && !PAGE_RE.test(f.fileId))
/** Placed PDF pages. */
export const pageItems = async (page: Page) => (await fileItems(page)).filter((f) => PAGE_RE.test(f.fileId))
/** File cards (PDF, video, other). */
export const cardItems = async (page: Page) =>
  (await fileItems(page)).filter((f) => f.facts.kind !== 'image' && !PAGE_RE.test(f.fileId))

/** Waits for exactly `n` new file elements of `pick` not in `before`. */
export async function newItems(
  page: Page,
  pick: (page: Page) => Promise<FileItem[]>,
  before: ReadonlySet<string>,
  n: number,
  timeout = 60_000,
): Promise<FileItem[]> {
  let found: FileItem[] = []
  await expect
    .poll(
      async () => {
        found = (await pick(page)).filter((f) => !before.has(f.id))
        return found.length
      },
      { timeout, message: `${n} new file elements` },
    )
    .toBe(n)
  return found
}

export const allIds = async (page: Page) => new Set((await items(page)).map((e) => e.id))

/** The dev-only board handle: the LobbyCanvas and the engine API. */
type Handle = {
  canvas: {
    files: {
      status(id: string): string | null
      urlOf(id: string, o?: { original?: boolean }): Promise<string | null>
    }
    focus(): void
    hasKeyboard(): boolean
    viewport: { moving(): boolean }
  }
  api: { getFiles(): Record<string, { dataURL: string; mimeType: string }>; getAppState(): unknown }
}

/** What the canvas shows for an image element: the loader's state, the URL it loads, the decoded size. */
export async function imageState(
  page: Page,
  id: string,
): Promise<{
  status: string | null
  url: string | null
  natural: { w: number; h: number } | null
  /** why a loaded image did not decode here (diagnostics) */
  debug: string
}> {
  return page.evaluate(async (elId) => {
    const h = (window as unknown as { __lobbyBoard?: Handle }).__lobbyBoard
    if (!h) throw new Error('no window.__lobbyBoard')
    const status = h.canvas.files.status(elId)
    const url = await h.canvas.files.urlOf(elId)
    const el = (
      window as unknown as { lobbyCanvas: { get(i: string): { fileId?: string } | null } }
    ).lobbyCanvas.get(elId)
    const file = el?.fileId ? h.api.getFiles()[el.fileId] : undefined
    // the rendering the loader loads for the element's current local derivative, decoded here (the
    // engine's files map keeps the first blob: URL it was given for a key, which the loader may have
    // revoked and replaced since: the canvas keeps drawing its decoded copy)
    let natural: { w: number; h: number } | null = null
    let debug = `fileId=${el?.fileId ?? '-'} file=${file ? file.dataURL.slice(0, 16) : 'absent'}`
    if (status === 'loaded' && file && url) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        const bmp = await createImageBitmap(await res.blob())
        natural = { w: bmp.width, h: bmp.height }
        bmp.close()
      } catch (e) {
        debug += ` decode=${String(e)}`
      }
    }
    return { status, url, natural, debug }
  }, id)
}

/** Waits until the canvas shows `id` from a board-scoped derivative (decoded). */
export async function expectLoadedImage(page: Page, id: string, board: string, timeout = 60_000) {
  let last: Awaited<ReturnType<typeof imageState>> | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await imageState(page, id)
          return last.status === 'loaded' && (last.natural?.w ?? 0) > 0
        },
        { timeout, message: `image ${id} loaded and decoded` },
      )
      .toBe(true)
  } catch (e) {
    throw new Error(`${(e as Error).message}
last state: ${JSON.stringify(last)}`)
  }
  const s = last as unknown as Awaited<ReturnType<typeof imageState>>
  expect(s.url).toMatch(DERIVATIVE_SRC)
  expect(s.url).toMatch(new RegExp(`\\?board=${board}$`))
}

export const urlOf = (page: Page, id: string, original = false) =>
  page.evaluate(
    ({ elId, original }) => {
      const h = (window as unknown as { __lobbyBoard?: Handle }).__lobbyBoard
      return h?.canvas.files.urlOf(elId, { original }) ?? null
    },
    { elId: id, original },
  )

/** The card face named `name` (the overlay keeps today's test ids). */
export const fileCard = (page: Page, name: string): Locator =>
  page.getByTestId('file-card').filter({ has: page.getByText(name, { exact: true }) })

/** Lobby's placeholder over an image the canvas cannot show (yet). */
export const placeholder = (page: Page, id: string): Locator =>
  page.locator(`[data-lobby-image-placeholder="${id}"]`)

/** Gives the board the keyboard (a click on empty canvas, right half, lower third). */
export async function focusBoard(page: Page): Promise<void> {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
}

/** "Insert file" (Ctrl/Cmd+U) with the board's keyboard, picking `files` (paths or payloads). */
export async function insertFiles(page: Page, files: (string | FilePayload)[]): Promise<void> {
  await focusBoard(page)
  const payloads = files.map((f) => (typeof f === 'string' ? fileFromPath(f) : f))
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('ControlOrMeta+u')
  await (await chooser).setFiles(payloads)
}

/** The camera is not moving (an animated zoom after a drop has finished). */
export async function settleCamera(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __lobbyBoard?: Handle }).__lobbyBoard?.canvas.viewport.moving(),
      ),
    )
    .toBe(false)
  await page.waitForTimeout(100)
}

/** Records every request URL a page makes from now on (the originals it fetched). */
export function recordRequests(page: Page) {
  const urls: string[] = []
  page.on('request', (r) => urls.push(new URL(r.url()).pathname + new URL(r.url()).search))
  return {
    urls,
    originals: () => urls.filter((u) => /\/files\/[^/]+\/[^/]+\/original/.test(u)),
  }
}

// ---- template scenes ------------------------------------------------------------------------------------------

type Any = Record<string, unknown>

/**
 * Pushes a template's scene (packages/templates/src/scene) as `create` ops over a raw socket with the
 * page's ticket, the way the templates spec does: locked labelled containers (the image slots) are
 * created unlocked and locked in a second push (CR-2D-1). The template insert itself is 3b's (and waits
 * for CR-2D-2); these specs need the slots and frames, not the insert.
 */
export async function pushTemplate(
  page: Page,
  board: string,
  templateId: string,
  origin = { x: 0, y: 0 },
): Promise<Any[]> {
  const scene = instantiateSceneTemplate(templateId as never, { origin })
  const elements = scene.elements as unknown as Any[]
  const { socket, welcome } = await forgeSession(page, board)
  let clock = (welcome as Welcome).clock
  let seq = 0
  const push = async (ops: unknown[]): Promise<Ack> => {
    seq++
    await socket.send(JSON.stringify({ type: 'push', seq, base: clock, ops }))
    const ack = (await socket.next('ack', 30_000)) as Ack
    clock = ack.clock
    const refused = ack.r.filter((r) => !r.ok)
    expect(refused, 'template ops refused').toEqual([])
    return ack
  }
  const lockedWithLabel = new Set(
    elements
      .filter(
        (e) =>
          e.locked === true &&
          ((e.boundElements as { type: string }[] | null) ?? []).some((r) => r.type === 'text'),
      )
      .map((e) => e.id as string),
  )
  const ack = await push(
    elements.map((el) => ({
      k: 'c',
      el: lockedWithLabel.has(el.id as string) ? { ...el, locked: false } : el,
    })),
  )
  if (lockedWithLabel.size) {
    const v = new Map<string, number>()
    for (const r of ack.r) if (r.ok) v.set(r.id, r.v)
    await push(
      [...lockedWithLabel].map((id) => ({ k: 'p', id, pv: v.get(id), g: { meta: { locked: true } } })),
    )
  }
  await socket.close()
  await expect
    .poll(async () => (await items(page)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(elements.length)
  return elements
}

/** A frame by its name, with its bounds (scene units). */
export async function frameByName(page: Page, name: string) {
  const f = (await items(page)).find((e) => e.type === 'frame' && (e as { name?: string }).name === name)
  return f ? { id: f.id, x: f.x, y: f.y, w: f.width, h: f.height } : null
}

/** A frame's template image slots (customData.lobby.slot === 'image'), in paint order. */
export async function slotsOf(page: Page, frameId: string) {
  return (await items(page))
    .filter(
      (e) =>
        e.frameId === frameId &&
        (e.customData as { lobby?: { slot?: unknown } } | undefined)?.lobby?.slot === 'image',
    )
    .map((e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      w: e.width,
      h: e.height,
      locked: e.locked,
      index: String(e.index),
    }))
}

export const contains = (
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
  tol = 0.5,
) =>
  inner.x >= outer.x - tol &&
  inner.y >= outer.y - tol &&
  inner.x + inner.w <= outer.x + outer.w + tol &&
  inner.y + inner.h <= outer.y + outer.h + tol

export const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5

export const boxOf = (f: { x: number; y: number; width: number; height: number }) => ({
  x: f.x,
  y: f.y,
  w: f.width,
  h: f.height,
})
