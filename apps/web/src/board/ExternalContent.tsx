import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { IMAGE_SLOT_META } from '@draftroom/templates'
import { useEffect, useRef } from 'react'
import {
  createShapeId,
  defaultHandleExternalFileContent,
  type Editor,
  type IndexKey,
  type TLAssetId,
  type TLDefaultExternalContentHandlerOpts,
  type TLImageShape,
  type TLParentId,
  type TLShape,
  type TLShapeId,
  useEditor,
  useToasts,
  useTranslation,
  type VecLike,
} from 'tldraw'
import { type AssetKind, type AssetVersionMeta, LIMITS } from '../assets/contract.ts'
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
} from '../assets/drop-layout.ts'
import { type AssetMetaStore, watchMeta } from '../assets/meta-store.ts'
import { type CardFile, NATIVE_IMAGE_MIME_TYPES, partitionFiles } from '../assets/partition.ts'
import { UploadError, uploadFile } from '../assets/upload.ts'
import { unionRects } from '../features/canvas-ux/placement.ts'
import { CARD_SIZE, changedHints, hintPropsFromMeta } from '../file-card/card-model.ts'
import { PdfViewerHost } from '../file-card/PdfViewer.tsx'
import { type BoardContextValue, useBoard } from './board-context.ts'

const CARD_GAP = 24
/** Template image slots carry this meta marker (packages/templates builder.imageSlot). */
const isImageSlot = (s: TLShape) =>
  Object.entries(IMAGE_SLOT_META).every(([k, v]) => (s.meta as Record<string, unknown>)?.[k] === v)

/** Options shared by <Tldraw> and our delegation to the default image handler. */
export const IMAGE_HANDLER_LIMITS = {
  maxAssetSize: LIMITS.maxBytes.image,
  acceptedImageMimeTypes: NATIVE_IMAGE_MIME_TYPES,
  // Videos become dr-file-cards (poster + original playback), never native video shapes.
  acceptedVideoMimeTypes: [] as readonly string[],
}

/**
 * Replaces tldraw's 'files' handler: images keep the native image-shape path (through our
 * TLAssetStore), everything else is uploaded to the board's upload route and becomes a dr-file-card.
 * Text, URL, tldraw and excalidraw pastes keep their default handlers because only 'files' is replaced.
 *
 * tldraw creates the images (upload, local preview, its toasts); we then replace its placement
 * (native pixel size, one long row, auto-parented by top-left corner) with drop-layout.ts's:
 * screen-relative sizes in a grid, clear of existing content, inside a frame only when all of it
 * fits there; a drop on a frame with empty template image slots fills them in reading order (images,
 * then videos), and the images left over go under that frame at the slots' size (F6).
 *
 * Rendered as a child of <Tldraw> so it can reach the UI toasts/translations the default handler
 * needs. Its effect runs after <Tldraw> registers the defaults (those run in a layout effect).
 *
 * It is also where the board's media UI outside the canvas mounts: the PDF page viewer (FIL-04),
 * which "View pages" on a PDF card opens and which places the chosen pages back on the board.
 */
export function ExternalContentHandlers() {
  const editor = useEditor()
  const board = useBoard()
  const toasts = useToasts()
  const msg = useTranslation()
  // Read at call time: `msg` changes identity when translations finish loading, and re-running the
  // effect for that would abort uploads that are still in flight.
  const ui = useRef({ toasts, msg })
  ui.current = { toasts, msg }

  useEffect(() => {
    if (!board) return
    const controller = new AbortController()
    const defaults = (): TLDefaultExternalContentHandlerOpts => ({ ...IMAGE_HANDLER_LIMITS, ...ui.current })
    editor.registerExternalContentHandler('files', async ({ files, point }) => {
      // Checked before any bytes are sent: a read-only session could not place the card anyway
      // (and the upload route refuses anyone without `edit`).
      if (editor.getIsReadonly()) {
        board.notify({ key: 'readonly-upload', text: 'You can view this board but not add files to it.' })
        return
      }
      const { images, cards, rejected } = partitionFiles(files)
      for (const r of rejected) {
        board.notify({ key: `reject:${r.file.name}`, text: `${r.file.name} ${r.reason}.`, tone: 'error' })
      }
      if (!images.length && !cards.length) return
      const centre = editor.getViewportPageBounds().center
      const at = point ?? centre
      // "Insert file" (Ctrl+U) passes the viewport centre as its point: only a real drop or paste
      // position aims at something (a template image slot).
      const aimed =
        !!point && Math.hypot(point.x - centre.x, point.y - centre.y) * editor.getZoomLevel() > 0.5
      // Card uploads start immediately; each card appears in the slot this drop planned for it (under
      // the images) as soon as its own upload finishes.
      const slots = placeDrop(editor, images, cards, { x: at.x, y: at.y, aimed }, defaults())
      await uploadFileCards(editor, board, cards, slots, controller.signal)
    })
    return () => {
      controller.abort()
      editor.registerExternalContentHandler('files', (content) =>
        defaultHandleExternalFileContent(editor, content, defaults()),
      )
    }
  }, [editor, board])

  return <PdfViewerHost />
}

/** Where the files arrived (page space). `aimed`: a real drop/paste position, not Ctrl+U's centre. */
interface DropPoint {
  x: number
  y: number
  aimed: boolean
}

/** Where a file card goes: in `parentId`'s space when that frame still exists, else on the page. */
interface CardSlot {
  page: VecLike
  parentId: TLShapeId | null
  local: VecLike | null
  /**
   * A template image slot the card fills instead (F9): fitted into the slot as it is when the upload
   * finishes, and stacked just above it, like an image dropped there.
   */
  imageSlot?: TLShapeId
  /** F12: the card's scale in a drop of images and cards (it shares the images' grid cells). */
  scale?: number
  /**
   * F12: this drop's shapes. While the selection is still only these (the images tldraw selected,
   * the cards that arrived so far), the card joins it, so the selection bar sits under the whole block.
   */
  dropGroup?: Set<TLShapeId>
}

/** Cards that show a picture and so may fill a template image slot: videos (poster) and images. */
const SLOT_CARD_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['video', 'image'])

const toRect = (b: { x: number; y: number; w: number; h: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.w,
  h: b.h,
})
const isImage = (s: TLShape | undefined): s is TLImageShape => s?.type === 'image'

/**
 * Lets tldraw create this drop's images, then lays out the images and plans the card slots (one
 * editor.run after tldraw's own creation, so the whole drop is still one undo step).
 */
async function placeDrop(
  editor: Editor,
  images: File[],
  cards: CardFile[],
  at: DropPoint,
  opts: TLDefaultExternalContentHandlerOpts,
): Promise<CardSlot[]> {
  const vp = editor.getViewportPageBounds()
  const view: View = { viewport: toRect(vp), zoom: editor.getZoomLevel() }
  const camera = editor.getCamera()
  let created: TLImageShape[] = []
  if (images.length) {
    const before = new Set(editor.getCurrentPageShapeIds())
    try {
      // createShapesForAssets runs synchronously at its end: once this resolves, the new images
      // exist and are selected.
      await defaultHandleExternalFileContent(editor, { point: at, files: images }, opts)
    } catch (e) {
      console.error('image drop failed', e)
    }
    // tldraw zooms to its own (native-size, one-row) layout; undo that camera move, ours follows.
    editor.stopCameraAnimation()
    const now = editor.getCamera()
    if (now.x !== camera.x || now.y !== camera.y || now.z !== camera.z) {
      editor.setCamera(camera, { immediate: true })
    }
    created = editor
      .getSelectedShapeIds()
      .filter((id) => !before.has(id))
      .map((id) => editor.getShape(id))
      .filter(isImage)
  }
  return layoutDrop(editor, created, cards, at, view)
}

function layoutDrop(
  editor: Editor,
  created: TLImageShape[],
  cards: CardFile[],
  at: DropPoint,
  view: View,
): CardSlot[] {
  const pageId = editor.getCurrentPageId()
  const createdIds = created.map((s) => s.id)
  const exclude = new Set<TLShapeId>(createdIds)
  // F6 (and F9): a drop on a frame with empty template image slots fills them in reading order,
  // starting at the slot under the pointer: the images first, then videos (or other picture cards).
  // Images left over go right under the frame at the slots' size; other cards are laid out as usual.
  const pictureCards = cards.filter((c) => SLOT_CARD_KINDS.has(c.kind))
  const slots = at.aimed && (created.length || pictureCards.length) ? emptySlotsAt(editor, at, exclude) : []
  // F2-02: an image fills its slot, centre-cropped, so the slot's placeholder never shows beside it.
  const slottedImages = created.slice(0, slots.length).map((shape, i) => {
    const slot = slots[i] as Slot
    return { shape, slot, ...coverSlot(nativeSize(editor, shape), slot.bounds) }
  })
  const slottedCards = pictureCards.slice(0, slots.length - slottedImages.length).map((card, i) => {
    const slot = slots[slottedImages.length + i] as Slot
    return { card, slot, rect: fitInSlot(CARD_SIZE[card.kind], slot.bounds) }
  })
  const leftOver = created.slice(slottedImages.length)
  const under =
    slots.length && leftOver.length ? planUnderSlots(editor, leftOver, slots, exclude, view) : null
  const gridShapes = under ? [] : leftOver
  const gridCards = cards.filter((c) => !slottedCards.some((s) => s.card === c))
  const containers = containersAt(editor, at, exclude)
  const plan = planDrop({
    images: gridShapes.map((s) => nativeSize(editor, s)),
    cards: gridCards.map((c) => CARD_SIZE[c.kind]),
    center: at,
    view,
    containers,
    cardGap: CARD_GAP,
    imageSide: imageSideAt(editor, containers, exclude),
  })
  const container = plan.containerId ? editor.getShape(plan.containerId as TLShapeId) : undefined

  if (createdIds.length) {
    editor.run(() => {
      // tldraw parented each image to the frame under its own top-left corner before moving the row,
      // which left images outside the frame that clips them. Start every image on the page.
      editor.reparentShapes(createdIds, pageId)
      for (const { shape, slot, rect, crop } of slottedImages) {
        editor.updateShapes([
          { id: shape.id, type: 'image', x: rect.x, y: rect.y, props: { w: rect.w, h: rect.h, crop } },
        ])
        // The slot's frame, stacked just above the slot (under the panel's notes and text).
        editor.reparentShapes([shape.id], slot.parentId, slot.index)
      }
      if (under) {
        editor.updateShapes(
          leftOver.flatMap((s, i) => {
            const r = under[i]
            return r ? [{ id: s.id, type: 'image' as const, x: r.x, y: r.y, props: { w: r.w, h: r.h } }] : []
          }),
        )
      }
      editor.updateShapes(
        gridShapes.flatMap((s, i) => {
          const r = plan.images[i]
          return r ? [{ id: s.id, type: 'image' as const, x: r.x, y: r.y, props: { w: r.w, h: r.h } }] : []
        }),
      )
      if (container && gridShapes.length) {
        editor.reparentShapes(
          gridShapes.map((s) => s.id),
          container.id,
        )
      }
      editor.select(...createdIds)
    })
  }

  // Zoom out only as far as needed to show everything this drop placed, cards included.
  const content = unionRects([
    ...slottedImages.map((s) => s.rect),
    ...slottedCards.map((s) => s.rect),
    ...(under ?? []),
    ...plan.images,
    ...plan.cards,
  ])
  const target = cameraTargetAfterDrop(view.viewport, content, view.zoom)
  if (target) {
    editor.zoomToBounds(target, {
      targetZoom: view.zoom,
      animation: { duration: editor.options.animationMediumMs },
    })
  }

  let next = 0
  const dropGroup = createdIds.length ? new Set<TLShapeId>(createdIds) : undefined
  return cards.map((card): CardSlot => {
    const slotted = slottedCards.find((s) => s.card === card)
    if (slotted) {
      return {
        page: { x: slotted.rect.x, y: slotted.rect.y },
        parentId: null,
        local: null,
        imageSlot: slotted.slot.id,
        dropGroup,
      }
    }
    const r = plan.cards[next++]
    const at0 = r ?? { x: at.x, y: at.y }
    return {
      page: { x: at0.x, y: at0.y },
      parentId: container ? container.id : null,
      local: container ? editor.getPointInShapeSpace(container, { x: at0.x, y: at0.y }) : null,
      scale: r ? r.w / CARD_SIZE[card.kind].w : 1,
      dropGroup,
    }
  })
}

/** The asset's native pixel size (tldraw caps it at maxImageDimension), else the shape's. */
function nativeSize(editor: Editor, shape: TLImageShape): Size {
  const asset = shape.props.assetId ? editor.getAsset(shape.props.assetId) : undefined
  const w = asset && 'w' in asset.props ? asset.props.w : 0
  const h = asset && 'h' in asset.props ? asset.props.h : 0
  return w > 0 && h > 0 ? { w, h } : { w: shape.props.w, h: shape.props.h }
}

/**
 * F2-01: the longest side (page units) for this drop's images: the median of the images already in
 * the innermost frame under the drop point, or on the page when it is not over a frame, else the
 * default. Never the zoom, so separate uploads come out at one size.
 */
function imageSideAt(editor: Editor, containers: readonly DropContainer[], exclude: Set<TLShapeId>): number {
  const target = containers[0]?.id ?? editor.getCurrentPageId()
  const sizes: Size[] = []
  for (const id of editor.getSortedChildIdsForParent(target as TLParentId)) {
    if (exclude.has(id)) continue
    const s = editor.getShape(id)
    const b = isImage(s) ? editor.getShapePageBounds(s) : undefined
    if (b) sizes.push({ w: b.w, h: b.h })
  }
  return imageSideFor(sizes)
}

function childRects(editor: Editor, parentId: TLParentId, exclude: Set<TLShapeId>): Rect[] {
  return editor.getSortedChildIdsForParent(parentId).flatMap((id) => {
    if (exclude.has(id)) return []
    const b = editor.getShapePageBounds(id)
    return b ? [toRect(b)] : []
  })
}

/** Unlocked, visible frames under `at` (innermost first), each with its children, then the page. */
function containersAt(editor: Editor, at: VecLike, exclude: Set<TLShapeId>): DropContainer[] {
  const frames: { id: TLShapeId; bounds: Rect }[] = []
  for (const s of editor.getCurrentPageShapes()) {
    if (s.type !== 'frame' || exclude.has(s.id)) continue
    if (editor.isShapeOrAncestorLocked(s) || editor.isShapeHidden(s)) continue
    const b = editor.getShapePageBounds(s)
    if (b?.containsPoint(at)) frames.push({ id: s.id, bounds: toRect(b) })
  }
  frames.sort((a, b) => a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h)
  return [
    ...frames.map((f) => ({ id: f.id, bounds: f.bounds, obstacles: childRects(editor, f.id, exclude) })),
    { id: null, bounds: null, obstacles: childRects(editor, editor.getCurrentPageId(), exclude) },
  ]
}

interface Slot {
  id: TLShapeId
  parentId: TLParentId
  index: IndexKey
  bounds: Rect
}

/** What already fills a slot: an image, or a file card (a video's poster). */
const fillsSlot = (s: TLShape | undefined) => isImage(s) || s?.type === FILE_CARD_TYPE

/** A template image slot as a Slot, or null while something already fills it (or it is hidden). */
function emptySlot(editor: Editor, s: TLShape, exclude: Set<TLShapeId>): Slot | null {
  if (exclude.has(s.id) || !isImageSlot(s) || editor.isShapeHidden(s)) return null
  const b = editor.getShapePageBounds(s)
  if (!b) return null
  const bounds = toRect(b)
  const inside = { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 }
  const occupied = editor.getSortedChildIdsForParent(s.parentId).some((id) => {
    if (exclude.has(id) || !fillsSlot(editor.getShape(id))) return false
    const ib = editor.getShapePageBounds(id)
    return (
      !!ib &&
      ib.x >= inside.x &&
      ib.y >= inside.y &&
      ib.maxX <= inside.x + inside.w &&
      ib.maxY <= inside.y + inside.h
    )
  })
  return occupied ? null : { id: s.id, parentId: s.parentId, index: s.index, bounds }
}

/**
 * F6: the empty template image slots a drop at `at` fills, in fill order: those of the frame under
 * the drop point (the innermost frame that has slots, or the frame of the slot under the pointer),
 * in reading order from the slot under the pointer. Slots arrive locked, so this is our own hit
 * test; a locked frame takes nothing. Boards made before slots were marked have no marker and keep
 * the plain grid.
 */
function emptySlotsAt(editor: Editor, at: VecLike, exclude: Set<TLShapeId>): Slot[] {
  const sorted = editor.getCurrentPageShapesSorted()
  let parentId: TLParentId | null = null
  let underPointer: TLShapeId | null = null
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]
    if (!s || exclude.has(s.id) || !isImageSlot(s) || editor.isShapeHidden(s)) continue
    if (!editor.isPointInShape(s, at, { hitInside: true, margin: 0 })) continue
    parentId = s.parentId
    underPointer = s.id
    break
  }
  if (!parentId) {
    // Not on a slot: the innermost frame under the drop point that holds any.
    let best: { id: TLShapeId; area: number } | null = null
    for (const f of editor.getCurrentPageShapes()) {
      if (f.type !== 'frame' || exclude.has(f.id) || editor.isShapeHidden(f)) continue
      const b = editor.getShapePageBounds(f)
      if (!b?.containsPoint(at) || (best && best.area <= b.w * b.h)) continue
      const hasSlots = editor.getSortedChildIdsForParent(f.id).some((id) => {
        const c = editor.getShape(id)
        return !!c && isImageSlot(c)
      })
      if (hasSlots) best = { id: f.id, area: b.w * b.h }
    }
    parentId = best?.id ?? null
  }
  if (!parentId || parentId === editor.getCurrentPageId()) {
    // A slot straight on the page (no frame): only that one.
    const s = underPointer ? editor.getShape(underPointer) : undefined
    const slot = s ? emptySlot(editor, s, exclude) : null
    return slot ? [slot] : []
  }
  const parent = editor.getShape(parentId as TLShapeId)
  if (parent && editor.isShapeOrAncestorLocked(parent)) return []
  const slots = editor.getSortedChildIdsForParent(parentId).flatMap((id) => {
    const s = editor.getShape(id)
    const slot = s ? emptySlot(editor, s, exclude) : null
    return slot ? [slot] : []
  })
  return slotFillOrder(slots, underPointer)
}

/**
 * F6: page rects for the images that found no free slot: a grid right under the slots' frame (clear
 * of other content), each image in a cell of the slots' size, as many per row as the frame's rows.
 */
function planUnderSlots(
  editor: Editor,
  images: TLImageShape[],
  slots: readonly Slot[],
  exclude: Set<TLShapeId>,
  view: View,
): Rect[] | null {
  const first = slots[0]
  const frameShape = first ? editor.getShape(first.parentId as TLShapeId) : undefined
  const frame = frameShape ? editor.getShapePageBounds(frameShape) : undefined
  if (!first || !frame) return null
  const all = editor.getSortedChildIdsForParent(first.parentId).flatMap((id) => {
    const s = editor.getShape(id)
    const b = s && isImageSlot(s) ? editor.getShapePageBounds(s) : undefined
    return b ? [{ id, bounds: toRect(b) }] : []
  })
  const rows = slotRows(all)
  const top = rows[0] ?? []
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const [a, b] = top
  const gap = a && b ? Math.max(0, b.bounds.x - (a.bounds.x + a.bounds.w)) : DROP_LAYOUT.gapPx / view.zoom
  const block = layoutCellGrid(
    images.map((s) => nativeSize(editor, s)),
    { w: first.bounds.w, h: first.bounds.h },
    Math.min(cols, images.length),
    gap,
  )
  const clearance = DROP_LAYOUT.clearancePx / (view.zoom > 0 ? view.zoom : 1)
  const topLeft = placeUnder(
    block,
    toRect(frame),
    childRects(editor, editor.getCurrentPageId(), exclude),
    clearance,
  )
  return block.items.map((r) => ({ ...r, x: r.x + topLeft.x, y: r.y + topLeft.y }))
}

async function uploadFileCards(
  editor: Editor,
  board: BoardContextValue,
  files: CardFile[],
  slots: Promise<CardSlot[]>,
  signal: AbortSignal,
) {
  if (!files.length) return
  await Promise.all(
    files.map(async ({ file }, i) => {
      const key = `upload:${i}:${file.name}:${file.size}:${file.lastModified}`
      board.notify({ key, text: `Uploading ${file.name}…`, timeoutMs: null, testId: 'upload-toast' })
      try {
        const meta = await uploadFile({ boardId: board.boardId, file, signal })
        const slot = (await slots)[i]
        if (signal.aborted || !slot) return
        if (editor.getIsReadonly()) throw new UploadError('READONLY', 'This board is read-only.', 403)
        const id = createFileCard(editor, meta, slot)
        board.dismiss(key)
        if (id) watchCardHints(editor, board.metaStore, board.boardId, id, meta, signal)
      } catch (e) {
        if (signal.aborted) return
        const reason = e instanceof UploadError ? e.message : 'Upload failed.'
        board.notify({ key, text: `${file.name}: ${reason}`, tone: 'error' })
      }
    }),
  )
}

function createFileCard(editor: Editor, meta: AssetVersionMeta, slot: CardSlot): TLShapeId | null {
  const id = createShapeId()
  // The image slot as it is now: someone may have moved its frame while the file was uploading.
  const slotShape = slot.imageSlot ? editor.getShape(slot.imageSlot) : undefined
  const slotBounds = slotShape ? editor.getShapePageBounds(slotShape) : undefined
  const fill = slotShape && slotBounds ? fitInSlot(CARD_SIZE[meta.kind], toRect(slotBounds)) : null
  const k = slot.scale && Number.isFinite(slot.scale) && slot.scale > 0 ? slot.scale : 1
  const size = fill ?? { w: CARD_SIZE[meta.kind].w * k, h: CARD_SIZE[meta.kind].h * k }
  // An explicit parent: createShape would otherwise pick the frame under the card's top-left corner.
  const parent = slot.parentId && slot.local && editor.getShape(slot.parentId) ? slot.parentId : null
  const at = fill ?? (parent && slot.local ? slot.local : slot.page)
  editor.run(() => {
    editor.createShape({
      id,
      type: FILE_CARD_TYPE,
      parentId: fill ? editor.getCurrentPageId() : (parent ?? editor.getCurrentPageId()),
      x: at.x,
      y: at.y,
      props: {
        w: size.w,
        h: size.h,
        assetId: meta.assetId,
        versionId: meta.versionId,
        kind: meta.kind,
        name: meta.name,
        mimeType: meta.mimeType || meta.declaredMimeType || 'application/octet-stream',
        sizeBytes: Math.max(0, Math.round(meta.sizeBytes)),
        ...hintPropsFromMeta(meta),
      },
    })
    // Into the slot's frame, stacked just above the slot (under the panel's notes and text), like an
    // image dropped on it.
    if (fill && slotShape && editor.getShape(id))
      editor.reparentShapes([id], slotShape.parentId, slotShape.index)
    // F12: joins the drop's selection while nobody has changed it, so the selection bar moves under
    // the whole block instead of covering the card.
    const group = slot.dropGroup
    const selected = editor.getSelectedShapeIds()
    if (group && editor.getShape(id)) {
      group.add(id)
      if (selected.length && editor.isIn('select.idle') && selected.every((s) => group.has(s))) {
        editor.select(...selected, id)
      }
    }
  })
  return editor.getShape(id) ? id : null
}

/**
 * Uploading tab only: mirror server meta into the card's hint props until the version is terminal,
 * so a stale or offline reader still sees roughly the right state. Written with history 'ignore' so
 * the user's undo stack only contains their own actions.
 */
function watchCardHints(
  editor: Editor,
  metaStore: AssetMetaStore,
  boardId: string,
  shapeId: TLShapeId,
  initial: AssetVersionMeta,
  signal: AbortSignal,
) {
  watchMeta(metaStore, boardId, initial.assetId, initial.versionId, signal, ({ meta }) => {
    const shape = editor.getShape(shapeId)
    if (!shape || shape.type !== FILE_CARD_TYPE) return true
    if (!meta) return false
    const patch = changedHints(shape.props, hintPropsFromMeta(meta))
    if (patch) {
      editor.run(() => editor.updateShape({ id: shapeId, type: FILE_CARD_TYPE, props: patch }), {
        history: 'ignore',
      })
    }
    return false
  })
}

/**
 * Uploading tab only, for native image shapes: once derivatives exist (or the worker gave up), touch
 * the asset record so every tab re-runs TLAssetStore.resolve() at once and swaps its loading tile (or
 * the uploading tab's local preview) for a sized derivative or the "couldn't process" tile. resolve()
 * also polls by itself (asset-store.ts), so a tab whose uploader left still gets there.
 */
export function watchImagePreview(
  editor: Editor,
  metaStore: AssetMetaStore,
  boardId: string,
  assetRecordId: TLAssetId,
  meta: AssetVersionMeta,
  signal: AbortSignal,
) {
  watchMeta(metaStore, boardId, meta.assetId, meta.versionId, signal, (snap) => {
    const status = snap.missing ? 'failed' : snap.meta?.status
    if (status !== 'ready' && status !== 'failed') return false
    const asset = editor.getAsset(assetRecordId)
    // The default handler writes src right after upload() resolves; if it has not landed yet there
    // is nothing to re-resolve, and the next render resolves against the (already cached) meta.
    if (!asset || asset.meta.previewStatus === status) return true
    editor.run(
      () =>
        editor.updateAssets([
          { id: asset.id, type: asset.type, meta: { ...asset.meta, previewStatus: status } },
        ]),
      { history: 'ignore' },
    )
    return true
  })
}
