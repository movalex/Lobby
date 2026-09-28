// R7 (final demo walk): a mind map started while a frame fills the view belongs to that frame, so it
// is on that frame's slide in Present and on its page in the PDF. It used to be created on the page,
// under the frame, and so was in neither. Pure page-space geometry; runtime.ts reads the editor.

import { findEmptySpotWithin, type Point, type Rect, unionRects } from '../canvas-ux/placement.ts'

/** Space kept between a new map and the frame's edges (page units). */
export const FRAME_PLACE_PAD = 48
/** Space the keeper keeps between a growing map and the frame's edges. */
export const FRAME_FIT_PAD = 32

export interface FramePlacement {
  /** Top-left of the new map's room (page space). */
  at: Point
  /** The room, narrowed to the frame's inner width when the frame is narrower. */
  room: { w: number; h: number }
  /** The frame's new height when the room only fits below its content (the frame grows downward). */
  growToH: number | null
}

/**
 * Where a new map's room goes inside `frame`: the free spot nearest `center` inside it (clear of
 * `children`), else below everything in the frame, which then grows downward to hold it.
 */
export function placeInFrame(
  room: { w: number; h: number },
  center: Point,
  frame: Rect,
  children: readonly Rect[],
  pad = FRAME_PLACE_PAD,
): FramePlacement {
  const inner = {
    x: frame.x + pad,
    y: frame.y + pad,
    w: Math.max(1, frame.w - 2 * pad),
    h: frame.h - 2 * pad,
  }
  const r = { w: Math.min(room.w, inner.w), h: room.h }
  if (inner.h >= r.h) {
    const at = findEmptySpotWithin(r, center, children, inner, { gap: 40 })
    if (at) return { at, room: r, growToH: null }
  }
  const content = unionRects(children)
  const below = content ? Math.max(content.y + content.h + pad, frame.y + pad) : frame.y + pad
  const x = Math.min(Math.max(center.x - r.w / 2, inner.x), inner.x + inner.w - r.w)
  const y = Math.max(below, frame.y + pad)
  return { at: { x, y }, room: r, growToH: Math.max(frame.h, y + r.h + pad - frame.y) }
}

export interface FrameFit {
  /** Move the map by this much (page space) so it clears the frame's left and top edges. */
  dx: number
  dy: number
  /** The frame's new size (never smaller than now). */
  w: number
  h: number
}

/**
 * How a frame holds a map that grew (more branches, longer text): the map moves right or down off the
 * frame's left and top edges, and the frame grows right and down around it. Null when nothing changes,
 * or when the map lies wholly outside the frame (someone moved it out: not this frame's map any more).
 */
export function fitFrameAround(frame: Rect, content: Rect | null, pad = FRAME_FIT_PAD): FrameFit | null {
  if (!content || ![frame.x, frame.y, frame.w, frame.h].every(Number.isFinite)) return null
  const overlaps =
    content.x < frame.x + frame.w &&
    frame.x < content.x + content.w &&
    content.y < frame.y + frame.h &&
    frame.y < content.y + content.h
  if (!overlaps) return null
  const dx = Math.max(0, frame.x + pad - content.x)
  const dy = Math.max(0, frame.y + pad - content.y)
  const w = Math.max(frame.w, Math.ceil(content.x + dx + content.w + pad - frame.x))
  const h = Math.max(frame.h, Math.ceil(content.y + dy + content.h + pad - frame.y))
  if (!dx && !dy && w === frame.w && h === frame.h) return null
  return { dx: Math.ceil(dx), dy: Math.ceil(dy), w, h }
}
