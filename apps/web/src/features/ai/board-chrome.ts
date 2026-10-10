// OWNER: W4 (wave M, M4-3). Where the board's own chrome is, for the popovers of the AI, sort, diagram and paste
// features: the obstacles a popover keeps clear of (lib/overlay-obstacles.ts, W1's registry, frozen by the wave M
// foundation) and one pure placement in the canvas region's pixels.
//
// Until W1 registers the style panel, the bottom toolbar and the selection bar (and on a page where it does not),
// their boxes are measured from the page by the same selectors canvas-ux's own SelectionBar reads; a registered id
// always wins over its fallback. Reads only: nothing here writes the board.

import {
  OBSTACLE_IDS,
  type ObstacleKind,
  type ObstacleRect,
  obstacleRects,
  type PopoverSide,
  placePopover,
  type Rect,
} from '../../lib/overlay-obstacles.ts'

export type { ObstacleRect, PopoverSide, Rect }

/** The chrome measured from the page when nobody registered it (client px). */
export const CHROME_FALLBACKS: readonly {
  readonly id: (typeof OBSTACLE_IDS)[keyof typeof OBSTACLE_IDS]
  readonly kind: ObstacleKind
  readonly selector: string
}[] = [
  {
    id: OBSTACLE_IDS.stylePanel,
    kind: 'panel',
    selector: '[data-lobby-slot="stylePanel"] [data-testid="style.panel"]',
  },
  { id: OBSTACLE_IDS.bottomToolbar, kind: 'toolbar', selector: '[data-lobby-slot="toolbar"]' },
  { id: OBSTACLE_IDS.selectionBar, kind: 'bar', selector: '[data-testid="selection-bar"]' },
]

type Query = Pick<Document, 'querySelector'>

/** A shown box (no empty, hidden or malformed ones), in client px. */
function boxOf(el: Element | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0) || ![r.left, r.top, r.width, r.height].every(Number.isFinite))
    return null
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/**
 * The board chrome a popover keeps clear of, now: what is registered (W1's registry) and, for the chrome nobody
 * registered, its box measured in `doc`. `exclude`: ids to leave out (a popover that covers the style panel).
 */
export function boardObstacles(doc: Query | null, exclude: readonly string[] = []): ObstacleRect[] {
  const out = obstacleRects(exclude)
  const have = new Set<string>(out.map((o) => o.id))
  if (!doc) return out
  for (const f of CHROME_FALLBACKS) {
    if (have.has(f.id) || exclude.includes(f.id)) continue
    const rect = boxOf(doc.querySelector(f.selector))
    if (rect) out.push({ id: f.id, kind: f.kind, rect })
  }
  return out
}

/** The canvas region's own top band (the board menu at its top left): a popover's top stays below it. */
export const BOARD_TOP_BAND = 48
/** Space kept between a popover and the canvas region's edges, and between it and its anchor. */
export const BOARD_POP_MARGIN = 12
export const BOARD_POP_GAP = 10

export interface BoardPlace {
  /** px from the canvas region's top-left */
  readonly left: number
  readonly top: number
  /** give it as max-height: it scrolls inside when its content is taller */
  readonly maxHeight: number
  /** its whole natural size fits there, clear of every obstacle (placePopover `fits`) */
  readonly fits: boolean
  readonly side: PopoverSide
}

/**
 * Where a popover goes in the canvas region (`container`, client px): W1's placePopover over the region less its top
 * band, its anchor and obstacles in client px; the answer in the region's own px (what an absolutely placed popover
 * inside it takes). Pure.
 */
export function placeInBoard(o: {
  readonly container: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  }
  readonly anchor: Rect
  readonly size: { readonly width: number; readonly height: number }
  readonly obstacles: readonly (Rect | ObstacleRect)[]
  readonly prefer?: PopoverSide | readonly PopoverSide[]
  readonly topBand?: number
  readonly minHeight?: number
}): BoardPlace {
  const band = Math.min(o.topBand ?? BOARD_TOP_BAND, Math.max(0, o.container.height / 3))
  const p = placePopover({
    anchor: o.anchor,
    size: o.size,
    viewport: {
      x: o.container.left,
      y: o.container.top + band,
      width: o.container.width,
      height: Math.max(0, o.container.height - band),
    },
    obstacles: o.obstacles,
    ...(o.prefer ? { prefer: o.prefer } : {}),
    gap: BOARD_POP_GAP,
    margin: BOARD_POP_MARGIN,
    ...(o.minHeight !== undefined ? { minHeight: o.minHeight } : {}),
  })
  return {
    left: p.x - o.container.left,
    top: p.y - o.container.top,
    maxHeight: p.maxHeight,
    fits: p.fits,
    side: p.side,
  }
}

/** An anchor in the canvas region's px (`x` its middle, `top` and `bottom` its extent) as a client-px box. */
export function anchorRect(
  container: { readonly left: number; readonly top: number },
  at: { readonly x: number; readonly top: number; readonly bottom: number },
): Rect {
  return {
    x: container.left + at.x - 1,
    y: container.top + at.top,
    width: 2,
    height: Math.max(0, at.bottom - at.top),
  }
}

/** The middle of the canvas region's top, under its top band: where a prompt about the whole view opens. */
export function topCentreAnchor(canvas: { container(): HTMLElement | null }): Rect | null {
  const box = canvas.container()?.getBoundingClientRect()
  return box ? { x: box.left + box.width / 2 - 1, y: box.top + BOARD_TOP_BAND, width: 2, height: 0 } : null
}
