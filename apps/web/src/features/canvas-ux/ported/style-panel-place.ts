// P-021 (wave P): the style panel opens on request, as Miro's styling does, never by itself on every selection: the
// selection bar's quick styles (tier one) are always there, and its Styles button opens the full panel (the choice
// is this browser's, kept across boards and reloads), the panel's × closes it again. Open, it never covers what is
// selected: it sits at the canvas's top right, and moves to the top left (under the board menu) while the selection
// is under it there, whichever covers less when both would.
import { atom } from '../../../lib/signals.ts'

export const STYLE_PANEL_KEY = 'lobby:style-panel-open'

/** The stored choice; nothing stored (or no storage) means closed. */
export function readStylePanelPref(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    return store?.getItem(STYLE_PANEL_KEY) === 'true'
  } catch {
    return false
  }
}

/** Whether the full style panel is open (this browser's choice). */
export const stylePanelOpen = atom('cux-style-panel-open', readStylePanelPref())

export function setStylePanelOpen(open: boolean, storage?: Pick<Storage, 'setItem'> | null): void {
  stylePanelOpen.set(open)
  try {
    const store = storage === undefined ? globalThis.localStorage : storage
    store?.setItem(STYLE_PANEL_KEY, String(open))
  } catch {
    // not kept: this page still has it
  }
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const overlap = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** How far the panel's top left moves from its place at the right to the left (under the board menu). */
export const LEFT_INSET = { x: 12, y: 60 } as const

/**
 * Where the open panel goes (pure): its place at the right (`right`, client px), unless the selection's box on screen
 * is under it there and less of it would be under the panel at the left (`left`).
 */
export function stylePanelSide(right: Rect, left: Rect, selection: Rect | null): 'right' | 'left' {
  if (!selection) return 'right'
  const atRight = overlap(right, selection)
  if (atRight === 0) return 'right'
  return overlap(left, selection) < atRight ? 'left' : 'right'
}
