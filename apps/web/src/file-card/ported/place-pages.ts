// OWNER: 3g. "Place on board" from the PDF page viewer on the Excalidraw canvas (file-card/place-pages.ts
// on tldraw; FIL-04): one `image` element per selected page, in a row right of the card, tops aligned,
// clear of other content, inside the card's frame when the whole row fits there, as ONE undo step.
//
// A placed page's `fileId` is the PDF version's `ver_….p<n>` (canvas-schema §3.1), its
// `customData.lobby.file` the PDF's own facts (the server canonicalizes them from the file-refs answer
// and derives `pdfPage` from the suffix), `alt` its alt text. The image loader shows the worker's
// rendering of that page (canvas/files/resolve.ts); no bytes are copied and no URL is stored.
import { type DropContainer, placeBlock, type Rect } from '../../assets/drop-layout.ts'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { layoutPageRow, PAGE_GAP, type PreviewPage, pageAltText, placedPageSize } from '../pdf-pages.ts'
import { bringIntoView } from './insert.ts'
import type { FileFacts } from './model.ts'

const rectOf = (b: { x: number; y: number; width: number; height: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.width,
  h: b.height,
})

/** Where the row may go: the card's frame (if any, unlocked, visible) with its children, then the page. */
function containersFor(canvas: LobbyCanvas, cardId: string): DropContainer[] {
  const out: DropContainer[] = []
  const items = canvas.items()
  const frameId = canvas.get(cardId)?.frameId ?? null
  const children = (parent: string | null) =>
    items.flatMap((el) => {
      if ((el.frameId ?? null) !== parent || (el as { containerId?: string | null }).containerId) return []
      const b = canvas.bounds(el.id)
      return b ? [rectOf(b)] : []
    })
  const frame = frameId ? canvas.get(frameId) : undefined
  if (frame && frameId && !canvas.isLocked(frameId) && !canvas.isHidden(frameId)) {
    const b = canvas.bounds(frameId)
    if (b) out.push({ id: frameId, bounds: rectOf(b), obstacles: children(frameId) })
  }
  out.push({ id: null, bounds: null, obstacles: children(null) })
  return out
}

/**
 * Puts `pages` (in page order) on the board right of the card `cardId`. Selects them and brings them
 * into view. Returns the new element ids ([] on a read-only canvas: the server refuses the write anyway).
 */
export function placePdfPages(
  canvas: LobbyCanvas,
  cardId: string,
  facts: FileFacts,
  pages: readonly PreviewPage[],
): string[] {
  if (!pages.length || canvas.readOnly()) return []
  const b = canvas.bounds(cardId)
  if (!b) return []
  const row = layoutPageRow(pages.map((p) => placedPageSize(p.full)))
  // Just right of the card, top-aligned. placeBlock keeps PAGE_GAP from everything (the card too) and
  // moves the row to the nearest free spot when something is already there.
  const center = { x: b.x + b.width + PAGE_GAP + 0.5 + row.w / 2, y: b.y + row.h / 2 }
  const { containerId, topLeft } = placeBlock(
    { w: row.w, h: row.h },
    center,
    containersFor(canvas, cardId),
    PAGE_GAP,
  )
  const ids = canvas.transact('Place PDF pages', (tx) =>
    pages.map((p, i) => {
      const r = row.items[i] ?? { x: 0, y: 0, w: 1, h: 1 }
      return tx.create('image', {
        x: Math.round((topLeft.x + r.x) * 100) / 100,
        y: Math.round((topLeft.y + r.y) * 100) / 100,
        width: r.w,
        height: r.h,
        fileId: `${facts.versionId}.p${p.page}`,
        status: 'saved',
        scale: [1, 1],
        ...(containerId ? { frameId: containerId } : {}),
        customData: {
          lobby: { file: { ...facts }, pdfPage: p.page, alt: pageAltText(facts.name, p.page) },
        },
      })
    }),
  )
  canvas.select(ids)
  // Bring the new row into view, zooming out only as far as needed (like a drop).
  bringIntoView(canvas, { x: topLeft.x, y: topLeft.y, w: row.w, h: row.h })
  return ids
}
