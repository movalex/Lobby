// "Place on board" from the PDF page viewer (FIL-04): one image shape per selected page, in a row
// next to the card, as one undo step. Each page gets its own image asset whose `src` is the PDF
// version's stable, host-less ref and whose `meta` names the page; resolve() (assets/asset-store.ts)
// turns that into the page's derivative for every viewer. No bytes are copied and no URL is stored.
import type { FileCardShape } from '@draftroom/canvas-schema'
import {
  AssetRecordType,
  createShapeId,
  type Editor,
  type TLAssetId,
  type TLImageAsset,
  type TLShapeId,
} from 'tldraw'
import { PDF_PAGE_META_KEY } from '../assets/asset-store.ts'
import { stableFileRef } from '../assets/contract.ts'
import { cameraTargetAfterDrop, type DropContainer, placeBlock, type Rect } from '../assets/drop-layout.ts'
import {
  layoutPageRow,
  PAGE_GAP,
  PAGE_PIXEL_RATIO,
  type PreviewPage,
  pageAltText,
  pageAssetName,
  placedPageSize,
} from './pdf-pages.ts'

const toRect = (b: { x: number; y: number; w: number; h: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.w,
  h: b.h,
})

/** The image asset record for one page (exported for tests). */
export function pageAssetRecord(
  card: Pick<FileCardShape['props'], 'assetId' | 'versionId' | 'name'>,
  page: PreviewPage,
  id: TLAssetId = AssetRecordType.createId(),
): TLImageAsset {
  const d = page.full
  return {
    id,
    typeName: 'asset',
    type: 'image',
    props: {
      name: pageAssetName(card.name, page.page, d.mimeType),
      src: stableFileRef(card.assetId, card.versionId),
      w: d.width,
      h: d.height,
      mimeType: d.mimeType,
      isAnimated: false,
      ...(d.bytes > 0 ? { fileSize: d.bytes } : {}),
      pixelRatio: PAGE_PIXEL_RATIO,
    },
    meta: { [PDF_PAGE_META_KEY]: page.page },
  }
}

/** Where the row may go: the card's frame (if any, unlocked, visible) with its children, then the page. */
function containersFor(editor: Editor, card: FileCardShape): DropContainer[] {
  const out: DropContainer[] = []
  const parent = editor.getShape(card.parentId as TLShapeId)
  if (parent?.type === 'frame' && !editor.isShapeOrAncestorLocked(parent) && !editor.isShapeHidden(parent)) {
    const b = editor.getShapePageBounds(parent)
    if (b) {
      out.push({
        id: parent.id,
        bounds: toRect(b),
        obstacles: editor.getSortedChildIdsForParent(parent.id).flatMap((id) => {
          const cb = editor.getShapePageBounds(id)
          return cb ? [toRect(cb)] : []
        }),
      })
    }
  }
  out.push({
    id: null,
    bounds: null,
    obstacles: editor.getSortedChildIdsForParent(editor.getCurrentPageId()).flatMap((id) => {
      const b = editor.getShapePageBounds(id)
      return b ? [toRect(b)] : []
    }),
  })
  return out
}

/**
 * Puts `pages` (in page order) on the board to the right of `card`, tops aligned with it, clear of
 * other content, inside the card's frame when the whole row fits there. Selects them and brings them
 * into view. Returns the new shape ids ([] for a read-only editor: the sync server would refuse the
 * write anyway, see apps/sync's read-only sessions).
 */
export function placePdfPages(
  editor: Editor,
  card: FileCardShape,
  pages: readonly PreviewPage[],
): TLShapeId[] {
  if (!pages.length || editor.getIsReadonly()) return []
  const cardBounds = editor.getShapePageBounds(card.id)
  if (!cardBounds) return []
  const row = layoutPageRow(pages.map((p) => placedPageSize(p.full)))
  // Just right of the card, top-aligned. placeBlock keeps PAGE_GAP from everything (the card too) and
  // moves the row to the nearest free spot when something is already there.
  const center = { x: cardBounds.maxX + PAGE_GAP + 0.5 + row.w / 2, y: cardBounds.y + row.h / 2 }
  const { containerId, topLeft } = placeBlock(
    { w: row.w, h: row.h },
    center,
    containersFor(editor, card),
    PAGE_GAP,
  )
  const frame = containerId ? editor.getShape(containerId as TLShapeId) : undefined
  const assets = pages.map((p) => pageAssetRecord(card.props, p))
  const ids = pages.map(() => createShapeId())
  const viewport = toRect(editor.getViewportPageBounds())
  const zoom = editor.getZoomLevel()

  editor.markHistoryStoppingPoint('place pdf pages')
  editor.run(() => {
    editor.createAssets(assets)
    editor.createShapes(
      pages.map((p, i) => {
        const r = row.items[i] ?? { x: 0, y: 0, w: 1, h: 1 }
        const pagePoint = { x: topLeft.x + r.x, y: topLeft.y + r.y }
        const at = frame ? editor.getPointInShapeSpace(frame, pagePoint) : pagePoint
        return {
          id: ids[i],
          type: 'image' as const,
          parentId: frame ? frame.id : editor.getCurrentPageId(),
          x: at.x,
          y: at.y,
          props: {
            assetId: assets[i]?.id ?? null,
            w: r.w,
            h: r.h,
            altText: pageAltText(card.props.name, p.page),
          },
        }
      }),
    )
    editor.select(...ids)
  })

  // Bring the new row into view, zooming out only as far as needed (like a drop).
  const target = cameraTargetAfterDrop(viewport, { x: topLeft.x, y: topLeft.y, w: row.w, h: row.h })
  if (target) {
    editor.zoomToBounds(target, {
      targetZoom: zoom,
      animation: { duration: editor.options.animationMediumMs },
    })
  }
  return ids.filter((id) => editor.getShape(id))
}
