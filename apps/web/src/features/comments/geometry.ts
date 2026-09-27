// Editor adapters for the pure anchor math in model.ts: shape frames, click targets, placing an
// anchor on the current page and moving the camera to a thread.

import type { CommentAnchor } from '@draftroom/contracts'
import type { Editor, TLPageId, TLShape, TLShapeId } from 'tldraw'
import {
  type AnchorPlacement,
  anchorForClick,
  type ClickTarget,
  type Point,
  placeAnchor,
  type ShapeFrame,
} from './model.ts'

export function shapeFrame(editor: Editor, shapeId: string): ShapeFrame | null {
  const shape = editor.getShape(shapeId as TLShapeId)
  if (!shape) return null
  const pageId = editor.getAncestorPageId(shape)
  if (!pageId) return null
  const b = editor.getShapeGeometry(shape).bounds
  const m = editor.getShapePageTransform(shape)
  const inv = m.clone().invert()
  return {
    pageId,
    bounds: { x: b.x, y: b.y, w: b.w, h: b.h },
    toPage: (p) => m.applyToPoint(p),
    toLocal: (p) => inv.applyToPoint(p),
  }
}

export function placeOnBoard(editor: Editor, anchor: CommentAnchor): AnchorPlacement {
  return placeAnchor(anchor, (id) => shapeFrame(editor, id))
}

/** The page point an anchor sits at on the current page, or null (other page / orphan). */
export function anchorPointOnCurrentPage(editor: Editor, anchor: CommentAnchor): Point | null {
  const p = placeOnBoard(editor, anchor)
  if (p.kind !== 'placed') return null
  if (p.pageId && p.pageId !== editor.getCurrentPageId()) return null
  return p.point
}

/** The top-most shape under a page point that a comment can attach to (hidden shapes excluded). */
export function commentTargetAt(editor: Editor, point: Point): ClickTarget | null {
  const shape: TLShape | undefined = editor.getShapeAtPoint(point, {
    hitInside: true,
    hitLabels: true,
    hitLocked: true,
    hitFrameInside: true,
    margin: 2 / editor.getZoomLevel(),
    renderingOnly: true,
    filter: (s) => !editor.isShapeHidden(s),
  })
  if (!shape) return null
  const frame = shapeFrame(editor, shape.id)
  if (!frame) return null
  return { shapeId: shape.id, type: shape.type, props: shape.props as Record<string, unknown>, frame }
}

export function anchorAt(editor: Editor, point: Point): CommentAnchor {
  return anchorForClick(point, commentTargetAt(editor, point), editor.getCurrentPageId())
}

/**
 * Brings a thread into view: switches to its page and centres on it, zooming in to at least 60% when
 * the board is zoomed far out. Returns false for orphans (nothing to show on the board).
 */
export function revealAnchor(editor: Editor, anchor: CommentAnchor): boolean {
  const p = placeOnBoard(editor, anchor)
  if (p.kind !== 'placed') return false
  if (p.pageId && p.pageId !== editor.getCurrentPageId()) editor.setCurrentPage(p.pageId as TLPageId)
  const animation = { duration: editor.options.animationMediumMs ?? 320 }
  const zoom = editor.getZoomLevel()
  if (zoom < 0.6) {
    const vp = editor.getViewportScreenBounds()
    const z = 1
    editor.setCamera({ x: -p.point.x + vp.w / 2 / z, y: -p.point.y + vp.h / 2 / z, z }, { animation })
  } else {
    editor.centerOnPoint(p.point, { animation })
  }
  return true
}
