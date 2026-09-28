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
  type DropContainer,
  fitInSlot,
  planDrop,
  type Rect,
  type Size,
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
 * fits there, and the first image (or, with no image, the first video) into an empty template image
 * slot under the drop point.
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
  // An empty template image slot under the drop point takes the first image, else the first video
  // (or other picture card): F9, a video dropped on a Mood board slot used to land above the frame.
  const slotCard = created.length ? -1 : cards.findIndex((c) => SLOT_CARD_KINDS.has(c.kind))
  const slot = at.aimed && (created.length || slotCard >= 0) ? slotAt(editor, at, exclude) : null
  const slotted = slot ? created[0] : undefined
  const slotRect = slot && slotted ? fitInSlot(nativeSize(editor, slotted), slot.bounds) : null
  const slottedCard = slot && !slotted ? cards[slotCard] : undefined
  const cardSlotRect = slot && slottedCard ? fitInSlot(CARD_SIZE[slottedCard.kind], slot.bounds) : null
  const gridShapes = slotted ? created.slice(1) : created
  const gridCards = slottedCard ? cards.filter((c) => c !== slottedCard) : cards
  const plan = planDrop({
    images: gridShapes.map((s) => nativeSize(editor, s)),
    cards: gridCards.map((c) => CARD_SIZE[c.kind]),
    center: at,
    view,
    containers: containersAt(editor, at, exclude),
    cardGap: CARD_GAP,
  })
  const container = plan.containerId ? editor.getShape(plan.containerId as TLShapeId) : undefined

  if (createdIds.length) {
    editor.run(() => {
      // tldraw parented each image to the frame under its own top-left corner before moving the row,
      // which left images outside the frame that clips them. Start every image on the page.
      editor.reparentShapes(createdIds, pageId)
      if (slot && slotted && slotRect) {
        editor.updateShapes([
          {
            id: slotted.id,
            type: 'image',
            x: slotRect.x,
            y: slotRect.y,
            props: { w: slotRect.w, h: slotRect.h },
          },
        ])
        // The slot's frame, stacked just above the slot (under the panel's notes and text).
        editor.reparentShapes([slotted.id], slot.parentId, slot.index)
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
    ...(slotRect ? [slotRect] : []),
    ...(cardSlotRect ? [cardSlotRect] : []),
    ...plan.images,
    ...plan.cards,
  ])
  const target = cameraTargetAfterDrop(view.viewport, content)
  if (target) {
    editor.zoomToBounds(target, {
      targetZoom: view.zoom,
      animation: { duration: editor.options.animationMediumMs },
    })
  }

  let next = 0
  return cards.map((card): CardSlot => {
    if (card === slottedCard && slot && cardSlotRect) {
      return {
        page: { x: cardSlotRect.x, y: cardSlotRect.y },
        parentId: null,
        local: null,
        imageSlot: slot.id,
      }
    }
    const r = plan.cards[next++] ?? { x: at.x, y: at.y }
    return {
      page: { x: r.x, y: r.y },
      parentId: container ? container.id : null,
      local: container ? editor.getPointInShapeSpace(container, { x: r.x, y: r.y }) : null,
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

/**
 * The topmost template image slot under `at` (slots arrive locked, so this is our own hit test), if
 * it is empty and its frame is not locked. Boards made before slots were marked have no marker and
 * keep the plain grid.
 */
function slotAt(editor: Editor, at: VecLike, exclude: Set<TLShapeId>): Slot | null {
  const sorted = editor.getCurrentPageShapesSorted()
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]
    if (!s || exclude.has(s.id) || !isImageSlot(s)) continue
    if (editor.isShapeHidden(s)) continue
    if (!editor.isPointInShape(s, at, { hitInside: true, margin: 0 })) continue
    const parent = editor.getShape(s.parentId as TLShapeId)
    if (parent && editor.isShapeOrAncestorLocked(parent)) return null
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
  return null
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
  const size = fill ?? CARD_SIZE[meta.kind]
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
