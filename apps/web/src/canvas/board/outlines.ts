/**
 * An outline the board page draws over the canvas in Lobby's accent (wave C; drawn by ./chrome.tsx, styled in
 * ./board.css), where the engine draws none:
 *
 *  - W5-38, the hover outline: the element under the pointer while the select tool is at rest (tldraw's hover
 *    indicator), so people see what a click will pick. Not for what is already selected (the engine's box is
 *    there), a locked or collapsed element (a click does not pick it), or while anything else happens (a press,
 *    a drag, a tool, an open editor).
 *
 * The boxes are overlay pixels around the element (its own box turned by its angle for a rotated shape, its
 * bounds for anything else), the same 4 px outside it as the engine's selection box, so hovering and
 * selecting read as one outline. Pure: reads a LobbyCanvas only (Node-tested in ./outlines.test.ts).
 */
import type { LobbyCanvas } from '../api/lobby-canvas.ts'

/** Screen px between an element and its outline (the engine's selection box: 2 × its handle spacing). */
export const OUTLINE_PAD = 4

export interface OutlineBox {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** radians, about the box's centre (a rotated shape); 0 otherwise */
  readonly angle: number
}

export type OutlineCanvas = Pick<
  LobbyCanvas,
  | 'get'
  | 'bounds'
  | 'selection'
  | 'viewport'
  | 'sceneToOverlay'
  | 'gesture'
  | 'hovered'
  | 'tool'
  | 'isLocked'
  | 'isHidden'
>

/** Elements whose box is their points' (an angle does not turn an outline drawn from their bounds). */
const POINTS = new Set(['arrow', 'line', 'freedraw'])

function outlineOf(canvas: OutlineCanvas, id: string): OutlineBox | null {
  const el = canvas.get(id)
  if (!el || el.isDeleted) return null
  const angle = !POINTS.has(el.type) && el.angle ? el.angle : 0
  const b = angle ? { x: el.x, y: el.y, width: el.width, height: el.height } : canvas.bounds(id)
  if (!b) return null
  const zoom = canvas.viewport.get().zoom
  const at = canvas.sceneToOverlay({ x: b.x, y: b.y })
  return {
    id,
    x: Math.round(at.x - OUTLINE_PAD),
    y: Math.round(at.y - OUTLINE_PAD),
    w: Math.round(b.width * zoom + 2 * OUTLINE_PAD),
    h: Math.round(b.height * zoom + 2 * OUTLINE_PAD),
    angle,
  }
}

/** W5-38: the hover outline now, or null (see the header). */
export function hoverOutline(canvas: OutlineCanvas): OutlineBox | null {
  // the select tool at rest (no press, no drag, no editor); a read-only Hand is the same engine state
  if (canvas.gesture() !== 'idle' || canvas.tool() === 'hand') return null
  const id = canvas.hovered()
  if (!id || canvas.selection.includes(id) || canvas.isLocked(id) || canvas.isHidden(id)) return null
  return outlineOf(canvas, id)
}
