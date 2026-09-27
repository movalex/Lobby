// Where comment popovers go (pure; unit-tested in Node). On wide boards a popover sits next to its
// marker, kept inside the editor viewport. On phones (an editor viewport narrower than
// PHONE_MAX_WIDTH) there is no room beside a marker: the popover becomes a bottom sheet across the
// canvas, and the camera puts the marker in the middle of what stays visible above it.

/** Marker size (px). The pointed bottom-left corner sits on the anchor. */
export const PIN_SIZE = 30
/** Below this editor-viewport width, popovers are bottom sheets. */
export const PHONE_MAX_WIDTH = 600
/** The narrowest popover that still reads well; a dock panel that leaves less than this is closed. */
export const MIN_POPOVER_WIDTH = 300
const MAX_POPOVER_WIDTH = 340
const MARGIN = 12
const SHEET_MARGIN = 8
const SHEET_MAX_HEIGHT = 420
const SHEET_MAX_SHARE = 0.55

export interface Size {
  w: number
  h: number
}

export interface PopoverLayout {
  left: number
  /** Set for popovers next to a marker (or top-left for a thread without one). */
  top: number | null
  /** Set for bottom sheets. */
  bottom: number | null
  width: number
  /** Bottom sheet (phones). */
  docked: boolean
  /** Bottom sheets: the tallest the sheet may get (px), so the marker above it stays visible. */
  maxHeight: number | null
}

export const isPhoneViewport = (vp: Size) => vp.w < PHONE_MAX_WIDTH

/** The tallest a bottom sheet gets in this viewport. */
export function sheetHeight(vp: Size): number {
  return Math.round(Math.min(SHEET_MAX_HEIGHT, vp.h * SHEET_MAX_SHARE))
}

/** Space (px, from the viewport's bottom edge) a bottom sheet may cover; 0 on wide viewports. */
export function coveredBottom(vp: Size): number {
  return isPhoneViewport(vp) ? sheetHeight(vp) + SHEET_MARGIN : 0
}

/**
 * The viewport point (relative to the editor viewport) where a thread's marker should end up when
 * the camera brings it into view: the middle of what the popover leaves visible.
 */
export function revealTarget(vp: Size): { x: number; y: number } {
  return { x: vp.w / 2, y: (vp.h - coveredBottom(vp)) / 2 }
}

/**
 * The popover for a marker whose anchor is at `anchor` (viewport coordinates; null when the thread
 * has no place on this page, e.g. its object was deleted).
 */
export function popoverLayout(vp: Size, anchor: { x: number; y: number } | null): PopoverLayout {
  if (isPhoneViewport(vp)) {
    const width = Math.max(0, Math.round(vp.w - SHEET_MARGIN * 2))
    return {
      left: SHEET_MARGIN,
      top: null,
      bottom: SHEET_MARGIN,
      width,
      docked: true,
      maxHeight: sheetHeight(vp),
    }
  }
  const width = Math.max(0, Math.min(MAX_POPOVER_WIDTH, vp.w - MARGIN * 2))
  if (!anchor) return { left: MARGIN, top: MARGIN, bottom: null, width, docked: false, maxHeight: null }
  let left = anchor.x + PIN_SIZE + 10
  if (left + width > vp.w - MARGIN) left = Math.max(MARGIN, anchor.x - width - 10)
  const top = Math.min(Math.max(MARGIN, anchor.y - PIN_SIZE - 8), Math.max(MARGIN, vp.h - 320))
  return {
    left: Math.round(left),
    top: Math.round(top),
    bottom: null,
    width,
    docked: false,
    maxHeight: null,
  }
}

/**
 * Whether the dock panel has to close before a thread chosen in it can be shown: on phones, and
 * whenever the panel leaves the canvas too narrow for a popover.
 */
export function panelBlocksPopover(windowWidth: number, editorViewportWidth: number): boolean {
  return windowWidth < PHONE_MAX_WIDTH || editorViewportWidth < MIN_POPOVER_WIDTH + MARGIN * 2
}

/** Whether a marker at viewport point `anchor` is hidden by a bottom sheet (or off screen). */
export function markerCovered(vp: Size, anchor: { x: number; y: number }): boolean {
  const bottom = vp.h - coveredBottom(vp)
  return anchor.x < 0 || anchor.x > vp.w || anchor.y - PIN_SIZE < 0 || anchor.y > bottom
}
