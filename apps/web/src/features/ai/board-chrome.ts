// OWNER: W4 (wave M, M4-3 and M4-4). Where the board's own chrome is, for the popovers and the camera of the AI, sort,
// diagram, paste and Pieces features: the obstacles a popover keeps clear of (lib/overlay-obstacles.ts, W1's
// registry, frozen by the wave M foundation), one pure placement in the canvas region's pixels, and the part of the
// view a new result is safe to land in (the view less the chrome along its edges, ./reveal.ts).
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

/**
 * The middle of the canvas region's top, under its top band: where a prompt about the whole view opens. A popover
 * below it starts exactly at the top of the room placeInBoard gives (the band, then the margin).
 */
export function topCentreAnchor(canvas: { container(): HTMLElement | null }): Rect | null {
  const box = canvas.container()?.getBoundingClientRect()
  if (!box) return null
  return {
    x: box.left + box.width / 2 - 1,
    y: box.top + BOARD_TOP_BAND + BOARD_POP_MARGIN - BOARD_POP_GAP,
    width: 2,
    height: 0,
  }
}

// ---- the safe part of the view (M4-4) -------------------------------------------------------------------------

/** Kept between a revealed result and the safe view's edges (client px). */
export const SAFE_INSET = 24

/** How near a view edge a piece of chrome must sit to count as along it (client px). */
export const EDGE_REACH = 64

/** Chrome that follows the selection (it moves with the camera): never a reason to move the camera. */
const FOLLOWS_SELECTION: ReadonlySet<string> = new Set([OBSTACLE_IDS.selectionBar, OBSTACLE_IDS.flowHandles])

/**
 * The part of the view (`view`, client px) a new result can be seen in: the view less the chrome along its edges.
 * Each obstacle along an edge (within EDGE_REACH of it) takes the edge strip it covers least of (the style panel at
 * the top right takes its width off the right, the bottom toolbar its height off the bottom), so what is left is one
 * rectangle. The selection bar and the flow + handles are left out: they follow the selection, and move with the
 * camera; so is anything out in the middle of the view. Pure.
 */
export function safeViewRect(view: Rect, obstacles: readonly (Rect | ObstacleRect)[]): Rect {
  let left = view.x
  let top = view.y
  let right = view.x + view.width
  let bottom = view.y + view.height
  for (const o of obstacles) {
    if ('id' in o && FOLLOWS_SELECTION.has(o.id)) continue
    const r = 'rect' in o ? o.rect : o
    const alongAnEdge =
      r.x <= view.x + EDGE_REACH ||
      r.y <= view.y + EDGE_REACH ||
      r.x + r.width >= view.x + view.width - EDGE_REACH ||
      r.y + r.height >= view.y + view.height - EDGE_REACH
    if (!alongAnEdge) continue
    const x0 = Math.max(r.x, view.x)
    const y0 = Math.max(r.y, view.y)
    const x1 = Math.min(r.x + r.width, view.x + view.width)
    const y1 = Math.min(r.y + r.height, view.y + view.height)
    if (x1 <= x0 || y1 <= y0) continue
    // what each edge strip would lose to take this obstacle out
    const cuts = [
      { edge: 'top', loss: (y1 - view.y) * view.width },
      { edge: 'bottom', loss: (view.y + view.height - y0) * view.width },
      { edge: 'left', loss: (x1 - view.x) * view.height },
      { edge: 'right', loss: (view.x + view.width - x0) * view.height },
    ].sort((a, b) => a.loss - b.loss)
    switch (cuts[0]?.edge) {
      case 'top':
        top = Math.max(top, y1)
        break
      case 'bottom':
        bottom = Math.min(bottom, y0)
        break
      case 'left':
        left = Math.max(left, x1)
        break
      default:
        right = Math.min(right, x0)
    }
  }
  // never less than a third of the view each way (a phone's chrome must not leave nothing)
  const minW = view.width / 3
  const minH = view.height / 3
  const keep = (lo: number, hi: number, min: number, from: number, size: number): [number, number] => {
    if (hi - lo >= min) return [lo, hi]
    const start = Math.max(from, Math.min((lo + hi) / 2 - min / 2, from + size - min))
    return [start, start + min]
  }
  ;[left, right] = keep(left, right, minW, view.x, view.width)
  ;[top, bottom] = keep(top, bottom, minH, view.y, view.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}
