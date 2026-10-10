// OWNER: W4 (wave M, M4-3, FTU-2). The layer the board's own popovers open in (the AI menu, the Sort menu, the AI
// preview's panel, Diagram from words, the Mermaid paste prompt, the AI provenance card), and their placement.
//
// The feature overlays sit in the overlay root (z-index 5), under every host slot: the style panel and the bottom
// toolbar (20), the selection bar (21). A popover there could open under the style panel, and a click on what showed
// of it could land on the panel instead (restyling the notes instead of sorting them). These popovers render in a
// layer of their own over the board's canvas region (`canvas.container()`), above the host slots (BOARD_POPOVER_Z,
// as the comment popovers' layer does) and below the context menu (40) and the shortcuts dialog (45), and they are
// placed clear of the style panel, the bottom toolbar, the top-centre stack and the selection bar
// (./board-chrome.ts). When nothing fits and the style panel is what is in the way, the style panel is folded away
// while the popover is open (an attribute on the canvas region, ./board-popover.css), never restyled or closed.
// The layer takes no clicks; the popovers do. Nothing here writes the board.

import { type ReactNode, type RefObject, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { OBSTACLE_IDS } from '../../lib/overlay-obstacles.ts'
import { type BoardPlace, boardObstacles, type PopoverSide, placeInBoard, type Rect } from './board-chrome.ts'
import './board-popover.css'

/** Above the host slots (toolbar and style panel 20, selection bar 21, phone sheet 30), below the menus (40, 45). */
export const BOARD_POPOVER_Z = 34

/** The canvas region's attribute that folds the style panel away while a popover covers its place. */
export const COVERS_STYLE_PANEL = 'data-dr-covers-style-panel'

/** A layer of its own over the canvas region while the component is mounted (null until then, or with no board). */
export function usePopoverLayer(canvas: LobbyCanvas): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const root = canvas.container()
    if (!root) return
    const el = root.ownerDocument.createElement('div')
    el.className = 'dr-board-pops'
    el.setAttribute('data-testid', 'board-popover-layer')
    el.style.zIndex = String(BOARD_POPOVER_Z)
    root.appendChild(el)
    setHost(el)
    return () => {
      el.remove()
      setHost(null)
    }
  }, [canvas])
  return host
}

/**
 * `node` in the layer `host` (from usePopoverLayer in the same component, so the component that places the popover
 * renders again once the layer is there); in place when there is no board DOM (a server render, a unit test).
 */
export function inPopoverLayer(canvas: LobbyCanvas, host: HTMLElement | null, node: ReactNode): ReactNode {
  if (!canvas.container()) return node
  return host ? createPortal(node, host) : null
}

/**
 * `children` in the popover layer (see inPopoverLayer). The component that places the popover must be inside
 * `children` (its measure runs once it is in the layer); a component that places its own popover uses
 * usePopoverLayer and inPopoverLayer itself.
 */
export function InPopoverLayer({ canvas, children }: { canvas: LobbyCanvas; children: ReactNode }) {
  const host = usePopoverLayer(canvas)
  return <>{inPopoverLayer(canvas, host, children)}</>
}

/** Popovers that fold the style panel away now (one count per canvas region). */
const covering = new WeakMap<HTMLElement, number>()

/** Folds the style panel away while `on` (see the header). */
export function useCoverStylePanel(canvas: LobbyCanvas, on: boolean): void {
  useLayoutEffect(() => {
    const root = canvas.container()
    if (!on || !root) return
    covering.set(root, (covering.get(root) ?? 0) + 1)
    root.setAttribute(COVERS_STYLE_PANEL, '')
    return () => {
      const n = (covering.get(root) ?? 1) - 1
      covering.set(root, n)
      if (n <= 0) root.removeAttribute(COVERS_STYLE_PANEL)
    }
  }, [canvas, on])
}

export interface PlacementOptions {
  /** the side(s) to try first (the others follow: below, above, right, left) */
  readonly prefer?: PopoverSide | readonly PopoverSide[]
  /** fold the style panel away when only it is in the way (default true) */
  readonly coverStylePanel?: boolean
}

const near = (a: BoardPlace, b: BoardPlace) =>
  Math.abs(a.left - b.left) <= 0.5 &&
  Math.abs(a.top - b.top) <= 0.5 &&
  Math.abs(a.maxHeight - b.maxHeight) <= 0.5 &&
  a.fits === b.fits

/**
 * Where the popover `ref` goes for `anchor` (a box in client px, read each time: a selection-bar button, a point in
 * the view): measured after every render (its natural size: scrollHeight is not capped by the max-height a previous
 * pass set) and fed back only when it moved, so it settles at once. Null until the first measure.
 */
export function useBoardPlacement(
  canvas: LobbyCanvas,
  ref: RefObject<HTMLElement | null>,
  anchor: () => Rect | null,
  opts: PlacementOptions = {},
): BoardPlace | null {
  const [place, setPlace] = useState<BoardPlace | null>(null)
  const [cover, setCover] = useState(false)
  useCoverStylePanel(canvas, cover)
  useLayoutEffect(() => {
    const el = ref.current
    const root = canvas.container()
    const a = anchor()
    if (!el || !root || !a) return
    const box = root.getBoundingClientRect()
    const size = { width: el.offsetWidth, height: el.scrollHeight + (el.offsetHeight - el.clientHeight) }
    const doc = root.ownerDocument
    const input = { container: box, anchor: a, size, ...(opts.prefer ? { prefer: opts.prefer } : {}) }
    const exclude = cover ? [OBSTACLE_IDS.stylePanel] : []
    const obstacles = boardObstacles(doc, exclude)
    let next = placeInBoard({ ...input, obstacles })
    if (!next.fits && !cover && opts.coverStylePanel !== false) {
      // nothing fits: when the style panel is all that is in the way, it folds away while this is open
      if (obstacles.some((o) => o.id === OBSTACLE_IDS.stylePanel)) {
        const without = placeInBoard({ ...input, obstacles: boardObstacles(doc, [OBSTACLE_IDS.stylePanel]) })
        if (without.fits) {
          setCover(true)
          next = without
        }
      }
    }
    if (!place || !near(place, next)) setPlace(next)
  })
  return place
}
