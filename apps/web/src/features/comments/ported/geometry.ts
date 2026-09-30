// OWNER: 3c. The comments feature's anchor math on the Excalidraw canvas (the tldraw page's ../geometry.ts):
// element frames, click targets, placing an anchor, the label of where a thread is, and moving the camera to
// a thread. The anchor formats are unchanged (docs/EXCALIDRAW-MIGRATION.md §3.6): shape and file anchors
// name the element as `shape:<elementId>`, so every existing thread keeps its place.
//
// One page: a point anchor made on the Excalidraw page carries no page id. A LEGACY point anchor made on
// tldraw page 2..n carries its page id; it is drawn shifted by that page's frozen offset from
// `lb_doc.import.legacyPages` (§5.8), where the converter put that page's content. A page id the board's
// import does not list (the first page, or a board that was never converted) is not shifted.

import { fromShapeRef, toShapeRef } from '@draftroom/canvas-schema/refs'
import type { CommentAnchor } from '@draftroom/contracts'
import {
  type CanvasElement,
  items as elementsApi,
  type LobbyCanvas,
  SINGLE_PAGE_ID,
} from '../../../canvas/api/index.ts'
import { isPhoneViewport, markerCovered, revealTarget } from '../layout.ts'
import {
  type AnchorContext,
  type AnchorPlacement,
  anchorForClick,
  anchorLabel,
  type ClickTarget,
  frameDisplayName,
  type Point,
  placeAnchor,
  type ShapeFrame,
} from '../model.ts'

/** The tldraw shape type a comment label names for an element kind (model.ts `friendlyShapeType`). */
function shapeTypeOf(el: CanvasElement): string | null {
  const kind = elementsApi.itemKindOf(el)
  switch (kind) {
    case 'note':
      return 'note'
    case 'text':
      return 'text'
    case 'shape':
      return 'geo'
    case 'arrow':
      return 'arrow'
    case 'line':
      return 'line'
    case 'draw':
      return 'draw'
    case 'highlight':
      return 'highlight'
    case 'frame':
      return 'frame'
    case 'file-card':
      return 'dr-file-card'
    case 'image': {
      const file = elementsApi.lobbyValue(el, 'file') as { kind?: string } | undefined
      return file?.kind === 'video' ? 'video' : 'image'
    }
    default:
      return null
  }
}

/** A live element by its api ref (`shape:<id>`), or null. */
function elementOf(canvas: LobbyCanvas, ref: string): CanvasElement | null {
  const id = fromShapeRef(ref)
  const el = id ? canvas.get(id) : undefined
  return el && !el.isDeleted ? el : null
}

/** An element's frame (its own unrotated box, rotated about its centre by `angle`, like Excalidraw). */
export function elementFrame(el: CanvasElement): ShapeFrame {
  const w = el.width
  const h = el.height
  const cos = Math.cos(el.angle ?? 0)
  const sin = Math.sin(el.angle ?? 0)
  const cx = el.x + w / 2
  const cy = el.y + h / 2
  return {
    pageId: SINGLE_PAGE_ID,
    bounds: { x: 0, y: 0, w, h },
    toPage: (p) => {
      const dx = p.x - w / 2
      const dy = p.y - h / 2
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
    },
    toLocal: (p) => {
      const dx = p.x - cx
      const dy = p.y - cy
      return { x: w / 2 + dx * cos + dy * sin, y: h / 2 - dx * sin + dy * cos }
    },
  }
}

export function shapeFrame(canvas: LobbyCanvas, ref: string): ShapeFrame | null {
  const el = elementOf(canvas, ref)
  return el ? elementFrame(el) : null
}

interface LegacyPage {
  readonly dx: number
  readonly dy: number
}

/** The frozen offset of a legacy tldraw page (lb_doc.import.legacyPages), or null. */
export function legacyPageOffset(canvas: LobbyCanvas, pageId: string): LegacyPage | null {
  const imp = canvas.doc.get('import') as { legacyPages?: Record<string, LegacyPage> } | undefined
  const page = imp?.legacyPages?.[pageId]
  return page && Number.isFinite(page.dx) && Number.isFinite(page.dy) ? page : null
}

/** Where an anchor sits on the board now (one page: every placement is on it). */
export function placeOnBoard(canvas: LobbyCanvas, anchor: CommentAnchor): AnchorPlacement {
  if (anchor.kind === 'point') {
    const shift = anchor.pageId ? legacyPageOffset(canvas, anchor.pageId) : null
    return {
      kind: 'placed',
      pageId: SINGLE_PAGE_ID,
      point: { x: anchor.x + (shift?.dx ?? 0), y: anchor.y + (shift?.dy ?? 0) },
    }
  }
  return placeAnchor(anchor, (ref) => shapeFrame(canvas, ref))
}

const area = (el: CanvasElement) => el.width * el.height

/** The innermost frame whose box holds `point` (hidden frames left out), or null. */
function frameAt(canvas: LobbyCanvas, point: Point): CanvasElement | null {
  let best: CanvasElement | null = null
  for (const el of canvas.items()) {
    if (el.type !== 'frame' || el.isDeleted || canvas.isHidden(el.id)) continue
    if (point.x < el.x || point.y < el.y || point.x > el.x + el.width || point.y > el.y + el.height) continue
    if (!best || area(el) < area(best)) best = el
  }
  return best
}

const nameOf = (el: CanvasElement) => (el as { name?: unknown }).name

/** F2-09: the file an image, video or file card shows (its `customData.lobby.file` name). */
function fileNameOf(el: CanvasElement): string | null {
  const file = elementsApi.lobbyValue(el, 'file') as { name?: unknown } | undefined
  const name = file?.name
  return typeof name === 'string' && name.trim() ? name : null
}

/** The element type and the surrounding frame of an anchor, for its label (../geometry.ts `anchorContext`). */
export function anchorContext(
  canvas: LobbyCanvas,
  anchor: CommentAnchor,
  placement: AnchorPlacement,
): AnchorContext {
  if (placement.kind !== 'placed') return {}
  if (anchor.kind === 'point') {
    const frame = frameAt(canvas, placement.point)
    return { frameName: frame ? frameDisplayName(nameOf(frame)) : null }
  }
  const el = elementOf(canvas, anchor.shapeId)
  if (!el) return {}
  const frame = el.type === 'frame' ? el : el.frameId ? (canvas.get(el.frameId) ?? null) : null
  return {
    shapeType: shapeTypeOf(el),
    frameName: frame ? frameDisplayName(nameOf(frame)) : null,
    fileName: fileNameOf(el),
  }
}

/** "Concept B · note", "In Concept B", "On the board"… (model.ts anchorLabel) for the board as it is now. */
export function describeAnchor(canvas: LobbyCanvas, anchor: CommentAnchor): string {
  const placement = placeOnBoard(canvas, anchor)
  return anchorLabel(anchor, placement, SINGLE_PAGE_ID, anchorContext(canvas, anchor, placement))
}

/** The scene point an anchor sits at, or null (its element was deleted: an orphan). */
export function anchorPoint(canvas: LobbyCanvas, anchor: CommentAnchor): Point | null {
  const p = placeOnBoard(canvas, anchor)
  return p.kind === 'placed' ? p.point : null
}

function targetOf(el: CanvasElement): ClickTarget {
  const file = elementsApi.lobbyValue(el, 'file') as { assetId?: unknown; versionId?: unknown } | undefined
  const type = shapeTypeOf(el) ?? el.type
  return {
    shapeId: toShapeRef(el.id),
    type,
    props: type === 'dr-file-card' ? { assetId: file?.assetId, versionId: file?.versionId } : {},
    frame: elementFrame(el),
  }
}

/**
 * The element under a scene point a comment attaches to (the container of a bound label, a locked element
 * too; hidden elements never), else the innermost frame the point is in (tldraw hit a frame's inside).
 */
export function commentTargetAt(canvas: LobbyCanvas, point: Point): ClickTarget | null {
  const hit = canvas.hitTest(point, { hitInside: true, margin: 2 }) ?? frameAt(canvas, point)
  if (!hit) return null
  const el = elementsApi.containerOf(hit, (id) => canvas.get(id))
  return targetOf(el)
}

/** A new anchor carries no page id (one page, §5.8). */
function withoutPage(anchor: CommentAnchor): CommentAnchor {
  if (anchor.kind !== 'point' || anchor.pageId === undefined) return anchor
  const { pageId: _legacy, ...rest } = anchor
  return rest
}

export function anchorAt(canvas: LobbyCanvas, point: Point): CommentAnchor {
  return withoutPage(anchorForClick(point, commentTargetAt(canvas, point), SINGLE_PAGE_ID))
}

/**
 * The anchor for a keyboard comment (Enter with the comment tool): the selected element's top-right
 * corner (so the marker does not cover it), or a point pin in the middle of the view when nothing is
 * selected. With several elements selected, the first one.
 */
export function anchorForKeyboard(canvas: LobbyCanvas): CommentAnchor {
  for (const id of canvas.selection) {
    const raw = canvas.get(id)
    if (!raw || raw.isDeleted || canvas.isHidden(id)) continue
    const el = elementsApi.containerOf(raw, (x) => canvas.get(x))
    const target = targetOf(el)
    const corner = target.frame.toPage({ x: el.width, y: 0 })
    return withoutPage(anchorForClick(corner, target, SINGLE_PAGE_ID))
  }
  const v = canvas.viewport.get()
  return withoutPage(anchorForClick({ x: v.x + v.width / 2, y: v.y + v.height / 2 }, null, SINGLE_PAGE_ID))
}

/** The canvas size as layout.ts reads it. */
export function canvasSize(canvas: LobbyCanvas): { w: number; h: number } {
  const r = canvas.viewport.screenRect()
  return { w: r.width, h: r.height }
}

/**
 * Brings a thread into view: its marker in the middle of what the popover leaves visible (the canvas
 * centre; above the bottom sheet on phones, layout.ts), zooming in to 100% when the board is zoomed out
 * below 60%. Returns false for orphans (nothing to show on the board).
 */
export function revealAnchor(canvas: LobbyCanvas, anchor: CommentAnchor): boolean {
  const point = anchorPoint(canvas, anchor)
  if (!point) return false
  const target = revealTarget(canvasSize(canvas))
  const current = canvas.viewport.get().zoom
  const zoom = current < 0.6 ? 1 : current
  canvas.viewport.set(
    { x: point.x - target.x / zoom, y: point.y - target.y / zoom, zoom },
    { animate: true, force: true },
  )
  return true
}

/** Phones: a marker the bottom sheet would cover (or off screen) is brought into view above it. */
export function keepAnchorAboveSheet(canvas: LobbyCanvas, anchor: CommentAnchor) {
  const vp = canvasSize(canvas)
  if (!isPhoneViewport(vp)) return
  const point = anchorPoint(canvas, anchor)
  if (point && markerCovered(vp, canvas.sceneToOverlay(point))) revealAnchor(canvas, anchor)
}
