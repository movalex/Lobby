// The toolbar's layout on the Excalidraw canvas by canvas width, as tldraw 5.4.2 lays out its own toolbar
// on the tldraw page (DefaultToolbar, OverflowingToolbar, DefaultQuickActions, MobileStylePanel; the
// breakpoints are tldraw's PORTRAIT_BREAKPOINTS, measured on the canvas, not the window):
//  - a canvas of 840 px or less: the quick actions (Undo, Redo, Delete, Duplicate, Comment and the "⋮"
//    actions menu) sit in a strip on top of the tools, at its left (tldraw's wider canvas has them in its
//    top-left menu zone; this one has none there, ./QuickActions.tsx says why);
//  - 640 px or less: the style panel folds behind a Styles button to the right of the tools, and opens
//    above it; so it does on a canvas of 500 px or less in height (W5-46: at 200% page zoom the open panel
//    covered half the board and ran under the toolbar);
//  - a wider canvas (no quick actions on the toolbar): Undo and Redo in their own small bar left of the tools
//    (W5-33: the Lobby tour tells people to press Ctrl+Z; tldraw had them in its top-left menu zone);
//  - on a phone-width canvas the tool buttons are 44 px (W5-31: touch targets), so fewer of them show;
//  - the number of tools shown grows with the width (tldraw's `modulate(width, [320, 560], [5, n])`); the
//    tools that do not fit go into "More" in their order, and the one used last from "More" keeps a slot.
// One difference: tldraw let its phone toolbar run past the canvas's edge (at 390 px its Styles button is
// half off screen) and over the zoom buttons at the bottom left. Here the tools shown are also capped to
// what fits between the navigation slot (3b's, bottom left) and the right edge, and the bar moves right
// rather than cover it.
//
// Pure, except `useCanvasRoom` (a React hook over the canvas region's DOM).
import { useEffect, useState } from 'react'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'

/** tldraw's TABLET breakpoint: at this canvas width or less the quick actions sit on the toolbar. */
export const QUICK_ACTIONS_ON_TOOLBAR_MAX = 840
/** tldraw's TABLET_SM breakpoint: at this width or less the style panel folds behind a Styles button. */
export const STYLES_BUTTON_MAX = 640
/** W5-46: at this canvas height or less the style panel folds too (200% page zoom on a laptop). */
export const STYLES_FOLD_HEIGHT = 500

/** One tool button with its gap (canvas-tools.css `.cux-tool` 38 px + 2 px). */
export const SLOT_PX = 40
/** W5-31: a phone-width canvas's tool button with its gap (44 px touch targets + 2 px). */
export const PHONE_SLOT_PX = 46
/**
 * W5-33: the Undo / Redo bar left of the tools on a wider canvas, with its gap (2 × 34 + 8 + 6). It hangs
 * outside the centred row (canvas-tools.css `.cux-history`), so the tools do not move for it.
 */
export const HISTORY_BAR_PX = 82
/** The bar's padding and border (4 px + 1 px on each side), less the last button's gap. */
export const BAR_CHROME_PX = 8
/** The Styles button with its gap. */
export const STYLES_BUTTON_PX = 46
/** The margin kept from the canvas's edges and from the navigation slot. */
export const EDGE_PX = 12
/** The quick-actions strip's own left margin in the toolbar (canvas-tools.css `.cux-quick--toolbar`). */
export const QUICK_MARGIN_PX = 8
/**
 * The band above the tools the quick-actions strip takes, in px from the canvas's bottom: the toolbar's row
 * (12 px from the bottom, 48 px high), then the strip (6 px apart, 40 px high), with a little room.
 */
export const QUICK_BAND_PX: readonly [number, number] = [60, 116]

/** tldraw's `modulate` with clamping: `value` mapped from [a0, a1] onto [b0, b1]. Pure. */
export function modulate(value: number, [a0, a1]: [number, number], [b0, b1]: [number, number]): number {
  const t = a1 === a0 ? 1 : (value - a0) / (a1 - a0)
  const clamped = Math.max(0, Math.min(1, t))
  return b0 + clamped * (b1 - b0)
}

/** tldraw's OverflowingToolbar item count for the canvas width (DraftroomToolbar: 5 at 320 px, all at 560). */
export function tldrawItemsToShow(width: number, mainCount: number): number {
  const max = Math.max(5, mainCount)
  return Math.floor(modulate(width, [320, 560], [5, max]))
}

/** How many buttons (tools and More) fit in `room` px. Pure. */
export const slotsThatFit = (room: number, slot = SLOT_PX) =>
  Math.max(1, Math.floor((room - BAR_CHROME_PX + 2) / slot))

/** W5-46: the style panel folds behind the toolbar's Styles button (a narrow or a low canvas). Pure. */
export const stylesFold = (room: Pick<ToolbarRoom, 'width' | 'height'>) =>
  room.width <= STYLES_BUTTON_MAX || (room.height ?? Number.POSITIVE_INFINITY) <= STYLES_FOLD_HEIGHT

export interface ToolbarRoom {
  /** the canvas region's width */
  readonly width: number
  /** the canvas region's height (unknown: tall enough) */
  readonly height?: number
  /** px kept free at the left: the navigation slot's right edge plus a margin, or the edge margin */
  readonly left: number
  readonly right: number
  /**
   * px from the canvas's left the quick-actions strip keeps free: the navigation slot's right edge plus a
   * margin where the slot reaches into the strip's band (the board page lifts it above the tools' row on a
   * narrow canvas, 2C's board.css), else 0. The wave-3b integration: the two collided at 390 to 800 px.
   */
  readonly quickLeft?: number
}

export interface ToolbarPlan<T> {
  /** the tools shown, in their order (the last-used overflow tool may be the last) */
  readonly shown: readonly T[]
  /** the tools in "More", in their order */
  readonly more: readonly T[]
  /** the quick actions sit on the toolbar (a wider canvas has none: ./QuickActions.tsx) */
  readonly quickOnToolbar: boolean
  /** W5-33: Undo and Redo left of the tools (a wider canvas, where the quick actions are not shown) */
  readonly historyBar: boolean
  /** W5-31: the tool buttons' size, px (44 on a phone-width canvas, else 38) */
  readonly toolPx: number
  /** the Styles button (the folded style panel) */
  readonly stylesButton: boolean
  /** px the bar moves right from the canvas's centre so that it clears the navigation slot */
  readonly shift: number
  /** px the quick-actions strip moves right of its place (the bar's left) to clear the navigation slot */
  readonly quickIndent: number
}

/**
 * Which tools the toolbar shows and which go into "More" (tldraw's rule: `n` = tldrawItemsToShow; with no
 * last-used overflow tool the first n + 1 tools show, else the first n and the last-used one), capped to
 * what fits in the room, and how far the bar moves to clear the navigation slot. `ordered` is the main
 * tools followed by the overflow tools; `mainCount` of them are main tools. Pure.
 */
export function planToolbar<T>(opts: {
  readonly ordered: readonly T[]
  readonly mainCount: number
  readonly lastUsed: T | null
  readonly room: ToolbarRoom
  readonly editor: boolean
  readonly styles: boolean
}): ToolbarPlan<T> {
  const { ordered, mainCount, lastUsed, room } = opts
  const quickOnToolbar = opts.editor && room.width <= QUICK_ACTIONS_ON_TOOLBAR_MAX
  const historyBar = opts.editor && !quickOnToolbar
  const stylesButton = opts.editor && opts.styles && stylesFold(room)
  const phone = room.width <= STYLES_BUTTON_MAX
  const slot = phone ? PHONE_SLOT_PX : SLOT_PX
  const extras = (stylesButton ? STYLES_BUTTON_PX : 0) + (historyBar ? HISTORY_BAR_PX : 0)
  const free = room.width - room.left - room.right - extras
  const fit = slotsThatFit(free, slot)
  const all = ordered.length
  const lastIndex = lastUsed === null ? -1 : ordered.indexOf(lastUsed)
  // tldraw's rule for n: the first n + 1 tools, or the first n and the last-used one when it is further on
  const shownFor = (n: number): T[] =>
    lastIndex > n && lastUsed !== null
      ? [...ordered.slice(0, n), lastUsed]
      : ordered.slice(0, Math.min(all, n + 1))
  let n = tldrawItemsToShow(room.width, mainCount)
  let shown = shownFor(n)
  // fewer while they (and More, when anything is hidden) do not fit
  while (n > 0 && shown.length + (shown.length < all ? 1 : 0) > fit) {
    n--
    shown = shownFor(n)
  }
  const more = ordered.filter((t) => !shown.includes(t))
  // the row the bar centres: the tools (and the Styles button); the history bar hangs left of it, outside
  // the centring, so the tools stay where they were (it only counts against the navigation slot)
  const leftExtra = historyBar ? HISTORY_BAR_PX : 0
  const barWidth =
    (shown.length + (more.length ? 1 : 0)) * slot + BAR_CHROME_PX + (stylesButton ? STYLES_BUTTON_PX : 0)
  // centred on the canvas unless that covers the navigation slot; never past the right edge
  const centredLeft = room.width / 2 - barWidth / 2
  const maxShift = Math.max(0, room.width - room.right - barWidth - centredLeft)
  const shift = Math.min(maxShift, Math.max(0, room.left + leftExtra - centredLeft))
  const quickIndent = quickOnToolbar
    ? Math.max(0, (room.quickLeft ?? 0) - (centredLeft + shift) - QUICK_MARGIN_PX)
    : 0
  return {
    shown,
    more,
    quickOnToolbar,
    historyBar,
    toolPx: phone ? 44 : 38,
    stylesButton,
    shift,
    quickIndent,
  }
}

/**
 * The canvas region's width and the room the navigation slot (bottom left) leaves the toolbar, measured in
 * the board page's DOM (the canvas region, `canvas.container()`, and its `[data-lobby-slot="navigation"]`)
 * and kept current on every resize of either and when a slot mounts or goes. (The canvas's own
 * `viewport.screenRect()` follows the camera, not a resize of the window.)
 */
export function useCanvasRoom(canvas: LobbyCanvas): ToolbarRoom {
  const [room, setRoom] = useState<ToolbarRoom>(() => ({
    width: Math.round(canvas.container()?.getBoundingClientRect().width ?? 0),
    height: Math.round(canvas.container()?.getBoundingClientRect().height ?? 0) || undefined,
    left: EDGE_PX,
    right: EDGE_PX,
    quickLeft: 0,
  }))
  useEffect(() => {
    const root = canvas.container()
    if (!root || typeof ResizeObserver === 'undefined') return
    let nav: Element | null = null
    const measure = () => {
      const r = root.getBoundingClientRect()
      const el = root.querySelector('[data-lobby-slot="navigation"]')
      let left = EDGE_PX
      let quickLeft = 0
      if (el) {
        let right = -1
        let quickRight = -1
        const [bandLow, bandHigh] = QUICK_BAND_PX
        for (const c of [el, ...el.querySelectorAll('*')]) {
          const b = c.getBoundingClientRect()
          if (b.width <= 0 || b.height <= 0) continue
          if (b.bottom > r.bottom - 64) right = Math.max(right, b.right)
          if (b.bottom > r.bottom - bandHigh && b.top < r.bottom - bandLow)
            quickRight = Math.max(quickRight, b.right)
        }
        if (right >= 0) left = Math.ceil(right - r.left) + EDGE_PX / 2
        if (quickRight >= 0) quickLeft = Math.ceil(quickRight - r.left) + EDGE_PX / 2
      }
      const width = Math.round(r.width)
      const height = Math.round(r.height) || undefined
      setRoom((v) =>
        v.width === width && v.height === height && v.left === left && v.quickLeft === quickLeft
          ? v
          : { width, height, left, right: EDGE_PX, quickLeft },
      )
      if (el !== nav) {
        if (nav) ro.unobserve(nav)
        nav = el
        if (el) ro.observe(el)
      }
    }
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    // the host slots are the region's own children: a slot that mounts later is seen here
    const mo = new MutationObserver(measure)
    mo.observe(root, { childList: true })
    measure()
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [canvas])
  return room.width > 0 ? room : { ...room, width: 1024 }
}
