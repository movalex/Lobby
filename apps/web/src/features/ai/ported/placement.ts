// Where the AI popover sits (wave K.1, follow-up 8). K7 grew the popover by a row or two (Expand with AI, Mind
// map from a prompt), and with no max-height it could run off a short viewport, or be pushed up by the clamp onto
// the selection bar it was opened from (the bar drew over it). Now it goes below its anchor when its content fits
// there, else above when it fits there, else on the side with more room with a max-height that keeps it there
// (it scrolls, ai.css). It never covers its anchor (the bar) unless the canvas has no room on either side, and
// it always stays inside the canvas. Pure: unit-tested in Node (placement.test.ts).

/** Space kept between the popover and the canvas's edges. */
export const POP_EDGE = 12
/** Space between the popover and its anchor (the AI button, or the point the menu opened at). */
export const POP_GAP = 10
/** The board menu and the top chrome: the popover's top never goes above this. */
export const POP_TOP_MIN = 56
/** Below this much room on the side it picked, the popover may cover its anchor rather than shrink further. */
export const POP_MIN_HEIGHT = 160

export interface PopPlacement {
  readonly left: number
  readonly top: number
  /** the popover's max-height (px): it scrolls inside when its content is taller */
  readonly maxHeight: number
}

/**
 * The popover's place inside a `box` (the canvas region) for an anchor (`x` its centre, `top` and `bottom` its
 * vertical extent, in the box's px), a popover `w` wide whose content is `h` tall (its natural height, not
 * capped by an earlier max-height).
 */
export function placeAiPopover(o: {
  readonly box: { readonly width: number; readonly height: number }
  readonly at: { readonly x: number; readonly top: number; readonly bottom: number }
  readonly w: number
  readonly h: number
}): PopPlacement {
  const { box, at, w, h } = o
  const left = Math.max(POP_EDGE, Math.min(box.width - w - POP_EDGE, at.x - w / 2))
  const belowTop = at.bottom + POP_GAP
  const roomBelow = box.height - POP_EDGE - belowTop
  const aboveBottom = at.top - POP_GAP
  const roomAbove = aboveBottom - POP_TOP_MIN
  if (h <= roomBelow) return { left, top: belowTop, maxHeight: roomBelow }
  if (h <= roomAbove) return { left, top: aboveBottom - h, maxHeight: roomAbove }
  // neither side holds all of it: the side with more room, scrolling inside
  const below = roomBelow >= roomAbove
  const room = Math.max(roomBelow, roomAbove)
  if (room >= POP_MIN_HEIGHT)
    return below
      ? { left, top: belowTop, maxHeight: roomBelow }
      : { left, top: POP_TOP_MIN, maxHeight: roomAbove }
  // a very short canvas (a phone held sideways): the whole height under the top chrome
  const all = Math.max(0, box.height - POP_EDGE - POP_TOP_MIN)
  return { left, top: POP_TOP_MIN, maxHeight: all }
}
