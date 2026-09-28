// Where the tag picker opens, relative to the selection bar's Tags button. Pure.

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PickerPlacement {
  /** Sideways shift from centred under the button (px). */
  dx: number
  /** Open above the bar. */
  above: boolean
  /** Cap on the list's height when neither side has room for all of it, else null. */
  listMax: number | null
}

/** The list's own cap (tags.css .dr-tag-picker__list max-height). */
export const PICKER_LIST_MAX = 240
const GAP = 10
const MARGIN = 8
const MIN_LIST = 72

/**
 * Centred under the button, shifted to stay inside `bounds` (the editor minus its top row and bottom
 * toolbar); below when it fits, else above when that fits, else on the roomier side with the list
 * shortened to fit.
 */
export function placePicker(
  anchor: Box,
  size: { width: number; height: number; list: number },
  bounds: Box,
): PickerPlacement {
  const natural = (anchor.left + anchor.right) / 2 - size.width / 2
  const minLeft = bounds.left + MARGIN
  const maxLeft = Math.max(minLeft, bounds.right - MARGIN - size.width)
  const dx = Math.min(Math.max(natural, minLeft), maxLeft) - natural
  const below = bounds.bottom - MARGIN - (anchor.bottom + GAP)
  const above = anchor.top - GAP - (bounds.top + MARGIN)
  if (size.height <= below) return { dx, above: false, listMax: null }
  if (size.height <= above) return { dx, above: true, listMax: null }
  const up = above > below
  const room = Math.max(above, below)
  return { dx, above: up, listMax: Math.max(MIN_LIST, Math.floor(size.list - (size.height - room))) }
}

export const samePlacement = (a: PickerPlacement, b: PickerPlacement) =>
  Math.abs(a.dx - b.dx) < 0.5 && a.above === b.above && a.listMax === b.listMax
