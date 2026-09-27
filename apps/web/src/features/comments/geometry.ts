// Editor adapters for the pure anchor math in model.ts: shape frames, click targets, placing an
// anchor on the current page and moving the camera to a thread.

import type { CommentAnchor } from '@draftroom/contracts'
import type { Editor, TLPageId, TLShape, TLShapeId } from 'tldraw'
import { isPhoneViewport, markerCovered, revealTarget } from './layout.ts'
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

const isFrame = (s: TLShape) => s.type === 'frame'
const nameOf = (s: TLShape) => (s.props as { name?: unknown }).name

/**
 * The shape type and the surrounding frame of an anchor, for its label: the anchored shape's nearest
 * frame (itself when it is a frame), or the innermost frame a point pin sits in (current page only;
 * pins on other pages get no frame).
 */
export function anchorContext(
  editor: Editor,
  anchor: CommentAnchor,
  placement: AnchorPlacement,
): AnchorContext {
  if (placement.kind !== 'placed') return {}
  if (anchor.kind === 'point') {
    if (placement.pageId && placement.pageId !== editor.getCurrentPageId()) return {}
    const frame = editor.getShapeAtPoint(placement.point, {
      hitInside: true,
      hitFrameInside: true,
      hitLocked: true,
      filter: (s) => isFrame(s) && !editor.isShapeHidden(s),
    })
    return { frameName: frame ? frameDisplayName(nameOf(frame)) : null }
  }
  const shape = editor.getShape(anchor.shapeId as TLShapeId)
  if (!shape) return {}
  const frame = isFrame(shape) ? shape : editor.findShapeAncestor(shape, isFrame)
  return { shapeType: shape.type, frameName: frame ? frameDisplayName(nameOf(frame)) : null }
}

/** "Concept B · note", "In Concept B", "On the board"… (model.ts anchorLabel) for the board as it is now. */
export function describeAnchor(editor: Editor, anchor: CommentAnchor): string {
  const placement = placeOnBoard(editor, anchor)
  return anchorLabel(anchor, placement, editor.getCurrentPageId(), anchorContext(editor, anchor, placement))
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
 * The anchor for a keyboard comment (Enter with the comment tool): the selected object's top-right
 * corner (so the marker does not cover it), or a point pin in the middle of the view when nothing is
 * selected. With several objects selected, the first one.
 */
export function anchorForKeyboard(editor: Editor): CommentAnchor {
  const shape = editor.getSelectedShapes().find((s) => !editor.isShapeHidden(s))
  const frame = shape ? shapeFrame(editor, shape.id) : null
  if (shape && frame) {
    const corner = frame.toPage({ x: frame.bounds.x + frame.bounds.w, y: frame.bounds.y })
    return anchorForClick(
      corner,
      { shapeId: shape.id, type: shape.type, props: shape.props as Record<string, unknown>, frame },
      editor.getCurrentPageId(),
    )
  }
  return anchorForClick(editor.getViewportPageBounds().center, null, editor.getCurrentPageId())
}

/**
 * Brings a thread into view: switches to its page and puts its marker in the middle of what the
 * popover leaves visible (the viewport's centre; above the bottom sheet on phones, layout.ts),
 * zooming in to 100% when the board is zoomed out below 60%. Returns false for orphans (nothing to
 * show on the board).
 */
export function revealAnchor(editor: Editor, anchor: CommentAnchor): boolean {
  const p = placeOnBoard(editor, anchor)
  if (p.kind !== 'placed') return false
  if (p.pageId && p.pageId !== editor.getCurrentPageId()) editor.setCurrentPage(p.pageId as TLPageId)
  const animation = { duration: editor.options.animationMediumMs ?? 320 }
  const vp = editor.getViewportScreenBounds()
  const target = revealTarget(vp)
  const z = editor.getZoomLevel() < 0.6 ? 1 : editor.getCamera().z
  editor.setCamera({ x: -p.point.x + target.x / z, y: -p.point.y + target.y / z, z }, { animation })
  return true
}

/** Phones: a marker the bottom sheet would cover (or off screen) is brought into view above it. */
export function keepAnchorAboveSheet(editor: Editor, anchor: CommentAnchor) {
  const vp = editor.getViewportScreenBounds()
  if (!isPhoneViewport(vp)) return
  const point = anchorPointOnCurrentPage(editor, anchor)
  if (point && markerCovered(vp, editor.pageToViewport(point))) revealAnchor(editor, anchor)
}
