// OWNER: 3g. Paste, drop and "Insert file" on the Excalidraw canvas (board/ExternalContent.tsx on tldraw;
// docs/EXCALIDRAW-MIGRATION.md §2.10.1 "Uploads", §2.10.4; FIL-06, F1/F2/F5/F6/F9/F12).
//
// Excalidraw's own image path (base64 copies, 1440 px, a 4 MiB cap) never runs: every file is uploaded to
// the board's upload route and only then becomes ONE `image` element through `transact`, holding the
// version id (`fileId`) and the stable facts (`customData.lobby.file`). No bytes, `data:`, `blob:` or
// signed URL ever reach an element. Each upload is tracked, so "Saved" waits for it.
//
// Where files land is today's layout (assets/drop-layout.ts, unchanged): page-space sizes that are the
// same for every upload (the median image size of the frame or page under the drop point), a grid clear
// of existing content, inside a frame only when all of it fits there, template image slots filled in
// reading order from the slot under the pointer (images centre-cropped, videos fitted), the images left
// over under the slots' frame; images and cards of one drop at one scale (F12). The camera zooms out
// only as far as needed to show what the drop placed.
//
// What differs from tldraw (docs/research/excalidraw/wave3/3G.md): an image appears once its upload has
// finished (tldraw showed a local preview while uploading); the drop's images are created together, in
// one undo step, when all of their uploads have finished; a card appears as soon as its own upload has.

import { trackBoardUpload } from '../../assets/board-media.ts'
import {
  type AssetKind,
  type AssetVersionMeta,
  classifyUpload,
  maxUploadBytes,
} from '../../assets/contract.ts'
import {
  cameraTargetAfterDrop,
  coverSlot,
  DROP_LAYOUT,
  type DropContainer,
  fitInSlot,
  imageSideFor,
  layoutCellGrid,
  placeUnder,
  planDrop,
  type Rect,
  type Size,
  slotFillOrder,
  slotRows,
  type View,
} from '../../assets/drop-layout.ts'
import { UploadError, uploadFile } from '../../assets/upload.ts'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas, ScenePoint } from '../../canvas/api/index.ts'
import { unionRects } from '../../features/canvas-ux/placement.ts'
import { formatBytes, pluralize } from '../../lib/format.ts'
import { CARD_SIZE } from '../card-model.ts'
import { excalidrawCrop, type FileFacts, factsOf, imageSizeFromHeader, type PixelSize } from './model.ts'

const CARD_GAP = 24
/** A dropped image whose header says nothing (an SVG): laid out as a square. */
const UNKNOWN_SIZE: PixelSize = { w: 1000, h: 1000 }
/** Cards that show a picture and so may fill a template image slot: videos (their poster). */
const SLOT_CARD_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['video'])

export type InsertSource = 'paste' | 'drop' | 'insert'

// ---- partition (assets/partition.ts on tldraw) --------------------------------------------------------

export interface CardFile {
  readonly file: File
  readonly kind: AssetKind
}
export interface Partitioned {
  readonly images: File[]
  readonly cards: CardFile[]
  readonly rejected: { file: File; reason: string }[]
}

/**
 * Images (every file the api calls an image: raster types and SVG, which the canvas shows through its
 * raster derivative) and cards (PDF, video, Office, anything else); files over their kind's limit are
 * refused before any byte is sent, with the file named.
 */
export function partitionUploads(files: readonly File[]): Partitioned {
  const out: Partitioned = { images: [], cards: [], rejected: [] }
  for (const file of files) {
    const kind = classifyUpload(file.type, file.name)
    const limit = maxUploadBytes(kind, file.type, file.name)
    if (kind === 'image') {
      if (file.size > limit)
        out.rejected.push({ file, reason: `is larger than ${formatBytes(limit)}, the limit for images` })
      else out.images.push(file)
    } else if (file.size > limit) {
      out.rejected.push({ file, reason: `is larger than the ${formatBytes(limit)} limit for this file type` })
    } else out.cards.push({ file, kind })
  }
  return out
}

/** The stable facts an element stores for an uploaded version (canvas-schema `file`). */
export function factsFromMeta(meta: AssetVersionMeta): FileFacts {
  return {
    assetId: meta.assetId,
    versionId: meta.versionId,
    kind: meta.kind,
    name: (meta.name || 'file').slice(0, 200),
    mimeType: (meta.mimeType || meta.declaredMimeType || 'application/octet-stream').slice(0, 255),
    sizeBytes: Math.max(0, Math.round(meta.sizeBytes || 0)),
  }
}

// ---- the scene as the layout sees it ---------------------------------------------------------------------

const rectOf = (b: { x: number; y: number; width: number; height: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.width,
  h: b.height,
})

const isLabel = (el: CanvasElement) => !!(el as { containerId?: string | null }).containerId
const isFrame = (el: CanvasElement) => el.type === 'frame'
const isImageSlot = (el: CanvasElement) =>
  (el.customData as { lobby?: { slot?: unknown } } | undefined)?.lobby?.slot === 'image'
/** What already fills a slot: an image, a placed page or a card (a video's poster). */
const fillsSlot = (el: CanvasElement) => el.type === 'image'

function contains(r: Rect, p: ScenePoint) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

export interface Scene {
  readonly items: readonly CanvasElement[]
  readonly bounds: (id: string) => Rect | null
  readonly usable: (el: CanvasElement) => boolean
}

export function sceneOf(canvas: LobbyCanvas): Scene {
  return {
    items: canvas.items(),
    bounds: (id) => {
      const b = canvas.bounds(id)
      return b ? rectOf(b) : null
    },
    usable: (el) => !canvas.isHidden(el.id),
  }
}

function childRects(scene: Scene, frameId: string | null, exclude: ReadonlySet<string>): Rect[] {
  const out: Rect[] = []
  for (const el of scene.items) {
    if (exclude.has(el.id) || isLabel(el) || (el.frameId ?? null) !== frameId) continue
    const b = scene.bounds(el.id)
    if (b) out.push(b)
  }
  return out
}

/** Unlocked, visible frames under `at` (innermost first), each with its children, then the page. */
function containersAt(
  canvas: LobbyCanvas,
  scene: Scene,
  at: ScenePoint,
  exclude: ReadonlySet<string>,
): DropContainer[] {
  const frames: { id: string; bounds: Rect }[] = []
  for (const el of scene.items) {
    if (!isFrame(el) || exclude.has(el.id) || canvas.isLocked(el.id) || !scene.usable(el)) continue
    const b = scene.bounds(el.id)
    if (b && contains(b, at)) frames.push({ id: el.id, bounds: b })
  }
  frames.sort((a, b) => a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h)
  return [
    ...frames.map((f) => ({ id: f.id, bounds: f.bounds, obstacles: childRects(scene, f.id, exclude) })),
    { id: null, bounds: null, obstacles: childRects(scene, null, exclude) },
  ]
}

/** F2-01: the drop's longest image side, from the images already in the frame (or on the page) under it. */
function imageSideAt(scene: Scene, containers: readonly DropContainer[], exclude: ReadonlySet<string>) {
  const target = containers[0]?.id ?? null
  const sizes: Size[] = []
  for (const el of scene.items) {
    if (exclude.has(el.id) || el.type !== 'image' || (el.frameId ?? null) !== target) continue
    const f = factsOf(el)
    if (f && f.kind !== 'image') continue // cards are not images
    const b = scene.bounds(el.id)
    if (b) sizes.push({ w: b.w, h: b.h })
  }
  return imageSideFor(sizes)
}

export interface Slot {
  readonly id: string
  readonly frameId: string | null
  readonly bounds: Rect
}

function emptySlot(scene: Scene, el: CanvasElement, exclude: ReadonlySet<string>): Slot | null {
  if (exclude.has(el.id) || !isImageSlot(el) || !scene.usable(el)) return null
  const bounds = scene.bounds(el.id)
  if (!bounds) return null
  const inside = { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 }
  const frameId = el.frameId ?? null
  const occupied = scene.items.some((o) => {
    if (o.id === el.id || exclude.has(o.id) || !fillsSlot(o) || (o.frameId ?? null) !== frameId) return false
    const b = scene.bounds(o.id)
    return (
      !!b &&
      b.x >= inside.x &&
      b.y >= inside.y &&
      b.x + b.w <= inside.x + inside.w &&
      b.y + b.h <= inside.y + inside.h
    )
  })
  return occupied ? null : { id: el.id, frameId, bounds }
}

/**
 * F6: the empty template image slots a drop at `at` fills, in fill order: those of the frame under the
 * drop point (the frame of the slot under the pointer, else the innermost frame that has slots), in
 * reading order from the slot under the pointer. Slots arrive locked, so this is Lobby's own hit test;
 * a locked frame takes nothing.
 */
export function emptySlotsAt(
  canvas: LobbyCanvas,
  scene: Scene,
  at: ScenePoint,
  exclude: ReadonlySet<string>,
): Slot[] {
  let frameId: string | null = null
  let underPointer: CanvasElement | null = null
  for (let i = scene.items.length - 1; i >= 0; i--) {
    const el = scene.items[i]
    if (!el || exclude.has(el.id) || !isImageSlot(el) || !scene.usable(el)) continue
    const b = scene.bounds(el.id)
    if (!b || !contains(b, at)) continue
    underPointer = el
    frameId = el.frameId ?? null
    break
  }
  if (!underPointer) {
    let best: { id: string; area: number } | null = null
    for (const f of scene.items) {
      if (!isFrame(f) || exclude.has(f.id) || !scene.usable(f)) continue
      const b = scene.bounds(f.id)
      if (!b || !contains(b, at) || (best && best.area <= b.w * b.h)) continue
      if (scene.items.some((c) => c.frameId === f.id && isImageSlot(c))) best = { id: f.id, area: b.w * b.h }
    }
    frameId = best?.id ?? null
  }
  if (!frameId) {
    const slot = underPointer ? emptySlot(scene, underPointer, exclude) : null
    return slot ? [slot] : []
  }
  if (canvas.isLocked(frameId)) return []
  const slots: Slot[] = []
  for (const el of scene.items) {
    if (el.frameId !== frameId) continue
    const s = emptySlot(scene, el, exclude)
    if (s) slots.push(s)
  }
  return slotFillOrder(slots, underPointer?.id ?? null)
}

/** F6: rects for the images that found no free slot: a grid right under the slots' frame. */
function planUnderSlots(
  scene: Scene,
  sizes: readonly Size[],
  slots: readonly Slot[],
  exclude: ReadonlySet<string>,
  view: View,
): Rect[] | null {
  const first = slots[0]
  const frame = first?.frameId ? scene.bounds(first.frameId) : null
  if (!first || !frame) return null
  const all: { id: string; bounds: Rect }[] = []
  for (const el of scene.items) {
    if (el.frameId !== first.frameId || !isImageSlot(el)) continue
    const b = scene.bounds(el.id)
    if (b) all.push({ id: el.id, bounds: b })
  }
  const rows = slotRows(all)
  const top = rows[0] ?? []
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const [a, b] = top
  const gap = a && b ? Math.max(0, b.bounds.x - (a.bounds.x + a.bounds.w)) : DROP_LAYOUT.gapPx / view.zoom
  const block = layoutCellGrid(
    sizes,
    { w: first.bounds.w, h: first.bounds.h },
    Math.min(cols, sizes.length),
    gap,
  )
  const clearance = DROP_LAYOUT.clearancePx / (view.zoom > 0 ? view.zoom : 1)
  const topLeft = placeUnder(block, frame, childRects(scene, null, exclude), clearance)
  return block.items.map((r) => ({ ...r, x: r.x + topLeft.x, y: r.y + topLeft.y }))
}

// ---- the plan ------------------------------------------------------------------------------------------

export interface ImagePlan {
  readonly rect: Rect
  readonly frameId: string | null
  /** the slot it fills (its rect is re-read when the upload has finished) */
  readonly slot: Slot | null
  readonly crop: ReturnType<typeof excalidrawCrop> | null
}
export interface CardPlan {
  readonly rect: Rect
  readonly frameId: string | null
  readonly slot: Slot | null
}
export interface DropLayout {
  readonly images: ImagePlan[]
  readonly cards: CardPlan[]
  /** everything placed, for the camera */
  readonly content: Rect | null
}

/** Where a drop's images (native sizes, in order) and cards go (board/ExternalContent.tsx `layoutDrop`). */
export function layoutFiles(
  canvas: LobbyCanvas,
  imageSizes: readonly PixelSize[],
  cards: readonly CardFile[],
  at: ScenePoint,
  aimed: boolean,
): DropLayout {
  const scene = sceneOf(canvas)
  const vp = canvas.viewport.get()
  const view: View = { viewport: { x: vp.x, y: vp.y, w: vp.width, h: vp.height }, zoom: vp.zoom }
  const exclude = new Set<string>()
  const pictureCards = cards.filter((c) => SLOT_CARD_KINDS.has(c.kind))
  const slots =
    aimed && (imageSizes.length || pictureCards.length) ? emptySlotsAt(canvas, scene, at, exclude) : []
  const slottedImages = imageSizes.slice(0, slots.length).map((size, i) => {
    const slot = slots[i] as Slot
    const { rect, crop } = coverSlot(size, slot.bounds)
    return { slot, rect, crop: crop ? excalidrawCrop(crop, size) : null }
  })
  const slottedCards = pictureCards.slice(0, slots.length - slottedImages.length).map((card, i) => {
    const slot = slots[slottedImages.length + i] as Slot
    return { card, slot, rect: fitInSlot(CARD_SIZE[card.kind], slot.bounds) }
  })
  const leftOver = imageSizes.slice(slottedImages.length)
  const under = slots.length && leftOver.length ? planUnderSlots(scene, leftOver, slots, exclude, view) : null
  const gridSizes = under ? [] : leftOver
  const gridCards = cards.filter((c) => !slottedCards.some((s) => s.card === c))
  const containers = containersAt(canvas, scene, at, exclude)
  const plan = planDrop({
    images: gridSizes,
    cards: gridCards.map((c) => CARD_SIZE[c.kind]),
    center: at,
    view,
    containers,
    cardGap: CARD_GAP,
    imageSide: imageSideAt(scene, containers, exclude),
  })
  const gridFrame = plan.containerId
  const images: ImagePlan[] = [
    ...slottedImages.map((s) => ({ rect: s.rect, frameId: s.slot.frameId, slot: s.slot, crop: s.crop })),
    ...(under ?? []).map((rect) => ({ rect, frameId: null, slot: null, crop: null })),
    ...plan.images.map((rect) => ({ rect, frameId: gridFrame, slot: null, crop: null })),
  ]
  let next = 0
  const cardPlans: CardPlan[] = cards.map((card) => {
    const slotted = slottedCards.find((s) => s.card === card)
    if (slotted) return { rect: slotted.rect, frameId: slotted.slot.frameId, slot: slotted.slot }
    const r = plan.cards[next++] ?? {
      x: at.x - CARD_SIZE[card.kind].w / 2,
      y: at.y,
      w: CARD_SIZE[card.kind].w,
      h: CARD_SIZE[card.kind].h,
    }
    return { rect: r, frameId: gridFrame, slot: null }
  })
  return {
    images,
    cards: cardPlans,
    content: unionRects([...images.map((i) => i.rect), ...cardPlans.map((c) => c.rect)]),
  }
}

/** Brings `content` into view like tldraw's zoomToBounds(target, {targetZoom}): never zooms in. */
export function bringIntoView(canvas: LobbyCanvas, content: Rect | null): void {
  const vp = canvas.viewport.get()
  const target = cameraTargetAfterDrop({ x: vp.x, y: vp.y, w: vp.width, h: vp.height }, content, vp.zoom)
  if (!target) return
  const sw = vp.width * vp.zoom
  const sh = vp.height * vp.zoom
  const inset = Math.min(128, sw * 0.28)
  const fit = Math.min((sw - inset) / Math.max(1, target.w), (sh - inset) / Math.max(1, target.h))
  const zoom = Math.max(0.1, Math.min(vp.zoom, fit))
  canvas.viewport.set(
    {
      x: target.x + target.w / 2 - sw / zoom / 2,
      y: target.y + target.h / 2 - sh / zoom / 2,
      zoom,
    },
    { animate: true },
  )
}

// ---- the flow --------------------------------------------------------------------------------------------

async function nativeSize(file: File): Promise<PixelSize> {
  try {
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
    return imageSizeFromHeader(head) ?? UNKNOWN_SIZE
  } catch {
    return UNKNOWN_SIZE
  }
}

let dropSeq = 0

/** The slot's rect as it is now (someone may have moved its frame while the files were uploading). */
function slotNow(canvas: LobbyCanvas, slot: Slot | null): Rect | null {
  if (!slot || !canvas.get(slot.id) || canvas.get(slot.id)?.isDeleted) return null
  const b = canvas.bounds(slot.id)
  return b ? rectOf(b) : null
}

function imageProps(meta: AssetVersionMeta, rect: Rect, frameId: string | null, crop: ImagePlan['crop']) {
  return {
    x: Math.round(rect.x * 100) / 100,
    y: Math.round(rect.y * 100) / 100,
    width: Math.max(1, Math.round(rect.w * 100) / 100),
    height: Math.max(1, Math.round(rect.h * 100) / 100),
    fileId: meta.versionId,
    status: 'saved',
    scale: [1, 1],
    ...(frameId ? { frameId } : {}),
    ...(crop ? { crop } : {}),
    customData: { lobby: { file: factsFromMeta(meta) } },
  }
}

/** Uploads one file (tracked: the save indicator waits for it). */
function upload(ctx: CanvasFeatureContext, file: File, signal?: AbortSignal): Promise<AssetVersionMeta> {
  return trackBoardUpload(ctx.registries, uploadFile({ boardId: ctx.board.id, file, signal }))
}

const reasonOf = (e: unknown) => (e instanceof UploadError ? e.message : 'Upload failed.')

/**
 * Uploads `files` and places them like a drop at `at` (the viewport centre when null: Ctrl+U). Resolves
 * with the new element ids once every upload has settled.
 */
export async function insertFiles(
  ctx: CanvasFeatureContext,
  files: readonly File[],
  point: ScenePoint | null,
  source: InsertSource,
  signal?: AbortSignal,
): Promise<string[]> {
  const canvas = ctx.canvas
  // Checked before any bytes are sent: a read-only session could not place the files anyway (and the
  // upload route refuses anyone without `edit`).
  if (canvas.readOnly()) {
    ctx.notify({ key: 'readonly-upload', text: 'You can view this board but not add files to it.' })
    return []
  }
  const { images, cards, rejected } = partitionUploads(files)
  // the files refused before any byte is sent are named, after the upload notices (which they must
  // not push out of the notice region)
  const reject = () => {
    for (const r of rejected)
      ctx.notify({ key: `reject:${r.file.name}`, text: `${r.file.name} ${r.reason}.`, tone: 'error' })
  }
  if (!images.length && !cards.length) {
    reject()
    return []
  }

  const vp = canvas.viewport.get()
  const centre = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 }
  const at = point ?? centre
  // "Insert file" (Ctrl+U) passes no point: only a real drop or paste position aims at a slot.
  const aimed =
    source !== 'insert' && !!point && Math.hypot(point.x - centre.x, point.y - centre.y) * vp.zoom > 0.5
  const sizes = await Promise.all(images.map(nativeSize))
  const plan = layoutFiles(canvas, sizes, cards, at, aimed)
  bringIntoView(canvas, plan.content)

  const seq = ++dropSeq
  const created: string[] = []
  const dropGroup = new Set<string>()
  /** what this drop last selected, and when (the engine's selection lags a render behind a select) */
  const chosen = new Set<string>()
  let chosenAt = 0
  const choose = () => {
    chosenAt = Date.now()
    canvas.select([...chosen])
  }

  const imagesDone = (async () => {
    if (!images.length) return
    const key = `upload:images:${seq}`
    ctx.notify({
      key,
      text:
        images.length === 1
          ? `Uploading ${images[0]?.name}…`
          : `Uploading ${pluralize(images.length, 'image')}…`,
      timeoutMs: null,
      testId: 'upload-toast',
    })
    const results = await Promise.allSettled(images.map((f) => upload(ctx, f, signal)))
    ctx.dismiss(key)
    if (signal?.aborted) return
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const f = images[i] as File
        ctx.notify({
          key: `upload:${seq}:${i}:${f.name}`,
          text: `${f.name}: ${reasonOf(r.reason)}`,
          tone: 'error',
        })
      }
    })
    const ok = results.flatMap((r, i) => (r.status === 'fulfilled' ? [{ meta: r.value, i }] : []))
    if (!ok.length) return
    if (canvas.readOnly()) {
      ctx.notify({ key: `upload:${seq}`, text: 'This board is read-only.', tone: 'error' })
      return
    }
    const ids = canvas.transact('Add images', (tx) =>
      ok.map(({ meta, i }) => {
        const p = plan.images[i] as ImagePlan
        const size = sizes[i] ?? UNKNOWN_SIZE
        // the slot as it is now: fill it again (it may have moved while the files were uploading)
        const slotRect = slotNow(canvas, p.slot)
        const filled = slotRect ? coverSlot(size, slotRect) : null
        const rect = filled?.rect ?? p.rect
        const crop = filled?.crop ? excalidrawCrop(filled.crop, size) : p.crop
        return tx.create('image', imageProps(meta, rect, p.frameId, crop))
      }),
    )
    for (const id of ids) {
      created.push(id)
      dropGroup.add(id)
      chosen.add(id)
    }
    choose()
  })()

  const cardsDone = Promise.all(
    cards.map(async ({ file }, i) => {
      const key = `upload:${seq}:${i}:${file.name}:${file.size}:${file.lastModified}`
      ctx.notify({ key, text: `Uploading ${file.name}…`, timeoutMs: null, testId: 'upload-toast' })
      try {
        const meta = await upload(ctx, file, signal)
        if (signal?.aborted) return
        if (canvas.readOnly()) throw new UploadError('READONLY', 'This board is read-only.', 403)
        // F12: the images of this drop go first, so a card never lands before the grid it sits under
        await imagesDone
        const p = plan.cards[i] as CardPlan
        const slotRect = slotNow(canvas, p.slot)
        const kind = meta.kind in CARD_SIZE ? meta.kind : 'other'
        const rect = slotRect ? fitInSlot(CARD_SIZE[kind], slotRect) : p.rect
        const id = canvas.transact('Add file', (tx) =>
          tx.create('image', imageProps(meta, rect, p.frameId, null)),
        )
        created.push(id)
        ctx.dismiss(key)
        // F12: the card joins the drop's selection while nobody has changed it
        if (dropGroup.size) {
          // still only this drop's (an empty selection right after ours is the engine catching up)
          const selected = canvas.selection
          const ours = selected.length
            ? selected.every((s) => dropGroup.has(s))
            : Date.now() - chosenAt < 1000
          if (ours) {
            chosen.add(id)
            choose()
          }
          dropGroup.add(id)
        }
      } catch (e) {
        if (signal?.aborted) return
        ctx.notify({ key, text: `${file.name}: ${reasonOf(e)}`, tone: 'error' })
      }
    }),
  )
  reject()
  await Promise.all([imagesDone, cardsDone])
  return created
}
