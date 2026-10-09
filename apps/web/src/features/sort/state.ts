// The sort menu's state, per canvas: where its popover points, which view it shows, and what it is about.
// Signals (lib/signals.ts), so the popover reads it with a narrow useValue; nothing runs per frame.
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

/** 'menu': the ways to sort; 'lens': the words to group by; 'axes': the two axes of a 2x2. */
export type SortView = 'menu' | 'lens' | 'axes'

/** Where the popover points, in px from the canvas container's top-left. */
export interface SortAnchor {
  readonly x: number
  readonly top: number
  readonly bottom: number
}

export interface SortMenuState {
  readonly at: SortAnchor
  readonly view: SortView
  /** the ids the menu was opened for (the selection then) */
  readonly ids: readonly string[]
  /** what had the keyboard when it opened: it gets it back */
  readonly opener: HTMLElement | null
}

function perCanvas<T>(make: () => T) {
  const map = new WeakMap<LobbyCanvas, T>()
  return (canvas: LobbyCanvas): T => {
    let v = map.get(canvas)
    if (v === undefined) {
      v = make()
      map.set(canvas, v)
    }
    return v
  }
}

export const sortMenu = perCanvas<Atom<SortMenuState | null>>(() =>
  atom<SortMenuState | null>('lobby-sort-menu', null),
)

/** The latest feature context, for code that only has the canvas. */
const contexts = new WeakMap<LobbyCanvas, CanvasFeatureContext>()
export const setSortCtx = (ctx: CanvasFeatureContext) => void contexts.set(ctx.canvas, ctx)
export const getSortCtx = (canvas: LobbyCanvas) => contexts.get(canvas)

/** A scene point as the popover's anchor. */
export function anchorAtScene(canvas: LobbyCanvas, scene: { x: number; y: number }): SortAnchor {
  const v = canvas.sceneToOverlay(scene)
  return { x: v.x, top: v.y, bottom: v.y }
}

/** The popover points at `el` (a selection-bar button), clear of the whole bar it is in. */
export function anchorAtElement(canvas: LobbyCanvas, el: HTMLElement): SortAnchor {
  const c = canvas.container()?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const r = el.getBoundingClientRect()
  const bar = el.closest('[data-testid="selection-bar"]')?.getBoundingClientRect() ?? r
  return {
    x: r.left + r.width / 2 - c.left,
    top: Math.min(r.top, bar.top) - c.top,
    bottom: Math.max(r.bottom, bar.bottom) - c.top,
  }
}

/** Under the selection's top edge, or the middle of the view when nothing is in sight. */
export function anchorAtSelection(canvas: LobbyCanvas, ids: readonly string[]): SortAnchor {
  const b = canvas.boundsOf(ids)
  const v = canvas.viewport.get()
  const p = b ? { x: b.x + b.width / 2, y: b.y } : { x: v.x + v.width / 2, y: v.y + v.height / 2 }
  return anchorAtScene(canvas, p)
}

export function openSortMenu(
  ctx: CanvasFeatureContext,
  view: SortView,
  at: SortAnchor,
  ids: readonly string[] = ctx.canvas.selection,
  opener: HTMLElement | null = null,
): void {
  setSortCtx(ctx)
  sortMenu(ctx.canvas).set({ at, view, ids: [...ids], opener })
}

export function closeSortMenu(canvas: LobbyCanvas, giveBack = true): void {
  const cur = sortMenu(canvas).get()
  sortMenu(canvas).set(null)
  if (!giveBack) return
  // a mouse user keeps the board; a keyboard user gets back what had the keyboard
  if (cur?.opener?.isConnected) cur.opener.focus({ preventScroll: true })
  else canvas.focus({ preventScroll: true })
}
