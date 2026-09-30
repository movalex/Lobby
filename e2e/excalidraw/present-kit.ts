// Helpers for the ported present-export, thumbnail and export-control specs (wave 3e) on the Excalidraw
// board page: a deck of frames and notes written through the page's canvas (every write a `transact`,
// Saved before the next: board-kit `settled`), an uploaded image placed in a frame, the view as the
// facade reports it, and the presentation's locators. The file readers (PNG, SVG, PDF, CSV, clipboard,
// downloads, request logs) are the tldraw specs' own (../tests/support/present-export.ts): they read
// files, not the canvas.
import { expect, type Page } from '@playwright/test'
import { makePng } from '../spike-b/support/png.ts'
import {
  createItem,
  expectSaved,
  item,
  itemBounds,
  sceneToScreen,
  viewport,
  waitForItem,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'

export interface FrameSpec {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** "skip in presentation" (customData.lobby.present.skip) */
  skip?: boolean
  /** an explicit presentation index (customData.lobby.present.index) */
  index?: number
}

export interface NoteSpec {
  id: string
  /** the frame it sits in; x, y are then relative to the frame */
  frame?: string
  x: number
  y: number
  text?: string
  /** a note fill (default: Lobby's yellow, "Marigold") */
  color?: string
}

export interface DeckSpec {
  frames?: FrameSpec[]
  notes?: NoteSpec[]
}

/** Lobby's note fills by palette name (board-ops/elements palette.ts). */
export const NOTE_FILL = { yellow: '#f6c453', blue: '#a7b7f6', green: '#8fd3a5', black: '#f8e48f' } as const

/** The page's LobbyCanvas as these helpers use it (dev-auth builds: `window.__lobbyBoard.canvas`). */
interface CanvasView {
  transact<T>(
    label: string,
    fn: (tx: {
      setFrame(ids: string[], frameId: string | null): void
      createMany(items: { kind: string; props: Record<string, unknown> }[]): string[]
    }) => T,
  ): T
  files: { status(id: string): string | null }
  settings: { get(): { focusMode: boolean } }
  history: { canUndo(): boolean }
}
type LobbyWindow = { __lobbyBoard?: { canvas: CanvasView } }

/** Puts `ids` (with their labels) into `frameId` through the canvas (one transact). */
export const setFrame = (page: Page, ids: string[], frameId: string | null) =>
  page.evaluate(
    (a) =>
      (window as unknown as LobbyWindow).__lobbyBoard?.canvas.transact('seed frame', (tx) =>
        tx.setFrame(a.ids, a.frameId),
      ),
    { ids, frameId },
  )

const presentData = (f: Pick<FrameSpec, 'skip' | 'index'>) =>
  f.skip !== undefined || f.index !== undefined
    ? {
        customData: {
          lobby: {
            present: {
              ...(f.skip ? { skip: true } : {}),
              ...(f.index !== undefined ? { index: f.index } : {}),
            },
          },
        },
      }
    : {}

/** Writes the deck: frames first, then notes (each into its frame), Saved after every write. */
export async function seedDeck(page: Page, spec: DeckSpec): Promise<void> {
  const frames = new Map((spec.frames ?? []).map((f) => [f.id, f]))
  for (const f of spec.frames ?? []) {
    await createItem(page, 'frame', {
      id: f.id,
      x: f.x,
      y: f.y,
      width: f.w,
      height: f.h,
      name: f.name,
      ...presentData(f),
    })
    await expectSaved(page)
  }
  for (const n of spec.notes ?? []) {
    const f = n.frame ? frames.get(n.frame) : undefined
    await createItem(page, 'note', {
      id: n.id,
      x: (f?.x ?? 0) + n.x,
      y: (f?.y ?? 0) + n.y,
      ...(n.text !== undefined ? { text: n.text } : {}),
      backgroundColor: n.color ?? NOTE_FILL.yellow,
    })
    await expectSaved(page)
    if (n.frame) {
      await setFrame(page, [n.id], n.frame)
      await expectSaved(page)
    }
  }
}

/** Sets a frame's presentation data (the Frames panel's skip toggle and reorder write these). */
export async function setPresent(
  page: Page,
  frameId: string,
  present: { skip?: boolean; index?: number } | null,
) {
  await page.evaluate(
    ({ id, present }) =>
      (window as unknown as { lobbyCanvas: { update(id: string, p: unknown): void } }).lobbyCanvas.update(
        id,
        {
          customData: { lobby: { present } },
        },
      ),
    { id: frameId, present },
  )
}

/** Waits until `page` holds every id. */
export async function expectItems(page: Page, ids: string[], timeout = 15_000): Promise<void> {
  for (const id of ids) await waitForItem(page, id, () => true, timeout)
}

/** How `frameId` sits in the view: fully inside, how far its centre is from the view's, how much it fills. */
export async function slidePlacement(page: Page, frameId: string) {
  const [v, f] = await Promise.all([viewport(page), itemBounds(page, frameId)])
  if (!f) return null
  const eps = 1
  return {
    inside:
      f.x >= v.x - eps &&
      f.y >= v.y - eps &&
      f.x + f.width <= v.x + v.width + eps &&
      f.y + f.height <= v.y + v.height + eps,
    centreOffset: Math.hypot(
      f.x + f.width / 2 - (v.x + v.width / 2),
      f.y + f.height / 2 - (v.y + v.height / 2),
    ),
    fill: Math.max(f.width / v.width, f.height / v.height),
  }
}

/** The frame is the slide on screen: inside the view, centred and fitted (camera animation done). */
export async function expectSlideOnScreen(page: Page, frameId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const p = await slidePlacement(page, frameId)
        return !!p && p.inside && p.centreOffset < 1 && p.fill > 0.98
      },
      { message: `${frameId} fitted on screen`, timeout: 10_000 },
    )
    .toBe(true)
}

/** The view rounded (scene rectangle and zoom), for before/after comparisons. */
export const roundView = (v: { x: number; y: number; zoom: number }) => ({
  x: Math.round(v.x),
  y: Math.round(v.y),
  zoom: Math.round(v.zoom * 1000) / 1000,
})

/** Screen centre of an element, for page.mouse. */
export async function centreOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`${id} has no bounds`)
  return sceneToScreen(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
}

export const presentUi = (page: Page) => ({
  button: page.getByTestId('present-button'),
  overlay: page.getByTestId('present-overlay'),
  counter: page.getByTestId('present-counter'),
  title: page.locator('.dr-present__title'),
  grid: page.getByTestId('present-grid'),
  exit: page.getByTestId('present-exit'),
})

/** Whether the board page is in focus mode (its chrome hidden: presenting). */
export const focusMode = (page: Page) =>
  page.evaluate(
    () => (window as unknown as LobbyWindow).__lobbyBoard?.canvas.settings.get().focusMode ?? null,
  )

/** The image loader's state of an image element. */
export const fileStatus = (page: Page, id: string) =>
  page.evaluate((a) => (window as unknown as LobbyWindow).__lobbyBoard?.canvas.files.status(a) ?? null, id)

/**
 * Uploads a 1920×1080 PNG to the board through the api (as a file drop does), places it as an image
 * element in `frameId` at `box` (frame-relative), and waits until the canvas shows it (its preview
 * derivative is loaded), so that any /files request made afterwards comes from an export.
 */
export async function placeUploadedImage(
  page: Page,
  users: Users,
  board: string,
  frame: FrameSpec,
  box: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const alice = await users.api('alice')
  const bytes = makePng(1920, 1080, 3)
  const up = await alice.request.post(`${WEB_URL}/api/boards/${board}/assets`, {
    headers: { origin: WEB_URL, 'content-type': 'image/png', 'x-file-name': 'photo.png' },
    data: bytes,
  })
  expect(up.status(), await up.text()).toBeLessThan(300)
  const meta = (await up.json()) as { assetId: string; versionId: string; name?: string; sizeBytes?: number }
  const id = 'pe-image'
  await createItem(page, 'image', {
    id,
    x: frame.x + box.x,
    y: frame.y + box.y,
    width: box.w,
    height: box.h,
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
  await expectSaved(page)
  await setFrame(page, [id], frame.id)
  await expectSaved(page)
  await expect
    .poll(() => fileStatus(page, id), { timeout: 60_000, message: 'the image shows on the canvas' })
    .toBe('loaded')
  expect((await item(page, id))?.frameId).toBe(frame.id)
  return id
}

/** Whether this tab has a step to undo (LobbyCanvas.history; the facade verb is 2E's). */
export const canUndo = (page: Page) =>
  page.evaluate(() => (window as unknown as LobbyWindow).__lobbyBoard?.canvas.history.canUndo() ?? null)

/** Many elements in ONE transact (one undo step, one push): a large board without 200 separate writes. */
export async function createMany(
  page: Page,
  list: { kind: string; props: Record<string, unknown> }[],
): Promise<string[]> {
  const ids = await page.evaluate(
    (a) =>
      (window as unknown as LobbyWindow).__lobbyBoard?.canvas.transact('seed', (tx) => tx.createMany(a)) ??
      [],
    list,
  )
  await expectSaved(page)
  return ids
}
