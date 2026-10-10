// OWNER: W1 (wave M, M1-3; written in the wave M foundation, W1 owns its later changes). Board chrome that
// popovers must not cover, and one pure placement for them. Frozen API after the foundation: registerObstacle,
// obstacleRects, placePopover (and the obstacle ids below).
//
// Bars and popovers sat on top of each other (FTU-2, FTU-11): the selection bar over the flow '+' handles, the Sort
// menu under the style panel, AI's menu under the bottom toolbar. Each piece of chrome registers a getter for its
// box, in viewport (client) pixels, and every popover asks placePopover for a place clear of them all:
//
//   'style-panel'     W1 (canvas-ux)        'bottom-toolbar'  W1 (canvas-ux)     'selection-bar'  W1 (canvas-ux)
//   'top-centre'      W2 (chrome.tsx's top-centre stack)                         'flow-handles'   W4 (flow Handles.tsx)
//
// The registry is module state (one board page per tab) and reads the boxes only when asked, so a moving panel
// is always read as it is now. placePopover is pure: the same input gives the same answer, whatever the obstacles'
// order, so a component that re-measures and feeds the answer back settles at once.

/** A box in viewport (client) pixels. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type ObstacleKind = 'panel' | 'toolbar' | 'bar' | 'stack' | 'handles'

/** The registered obstacles (frozen by the wave M foundation; a new one is a change to this list). */
export const OBSTACLE_IDS = {
  stylePanel: 'style-panel',
  bottomToolbar: 'bottom-toolbar',
  selectionBar: 'selection-bar',
  topCentre: 'top-centre',
  flowHandles: 'flow-handles',
} as const
export type ObstacleId = (typeof OBSTACLE_IDS)[keyof typeof OBSTACLE_IDS]

export interface ObstacleRect {
  id: ObstacleId
  kind: ObstacleKind
  rect: Rect
}

interface Entry {
  kind: ObstacleKind
  getRect: () => Rect | null
  token: symbol
}

const registry = new Map<ObstacleId, Entry>()

/**
 * Registers a piece of chrome as an obstacle; `getRect` answers its box now (null while it is not shown).
 * Registering an id again replaces the earlier getter. Returns the unregister function (a no-op once the id was
 * registered again by someone else, or already removed).
 */
export function registerObstacle(id: ObstacleId, kind: ObstacleKind, getRect: () => Rect | null): () => void {
  const token = Symbol(id)
  registry.set(id, { kind, getRect, token })
  return () => {
    if (registry.get(id)?.token === token) registry.delete(id)
  }
}

const usable = (r: Rect | null | undefined): r is Rect =>
  !!r &&
  Number.isFinite(r.x) &&
  Number.isFinite(r.y) &&
  Number.isFinite(r.width) &&
  Number.isFinite(r.height) &&
  r.width > 0 &&
  r.height > 0

/**
 * The registered obstacles' boxes now, in registration order, without `excludeIds` (a popover leaves itself
 * out). Hidden ones (null), empty or malformed boxes and getters that throw are left out.
 */
export function obstacleRects(excludeIds: readonly string[] = []): ObstacleRect[] {
  const out: ObstacleRect[] = []
  for (const [id, e] of registry) {
    if (excludeIds.includes(id)) continue
    let rect: Rect | null = null
    try {
      rect = e.getRect()
    } catch {
      rect = null
    }
    if (usable(rect)) out.push({ id, kind: e.kind, rect: { ...rect } })
  }
  return out
}

/** Tests only: forget every registration. */
export function resetObstaclesForTests(): void {
  registry.clear()
}

// ---- geometry --------------------------------------------------------------------------------------------------

const right = (r: Rect) => r.x + r.width
const bottom = (r: Rect) => r.y + r.height

/** The area two boxes share (0 when they only touch). */
export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x)
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Whether two boxes overlap (touching edges do not). */
export const rectsIntersect = (a: Rect, b: Rect): boolean => intersectionArea(a, b) > 0

// ---- placement ---------------------------------------------------------------------------------------------------

export type PopoverSide = 'above' | 'below' | 'left' | 'right'
const DEFAULT_ORDER: readonly PopoverSide[] = ['below', 'above', 'right', 'left']

/**
 * The least height a placed popover is given (or its natural height, when that is less). A side with less room than
 * this is not offered as a sliver: the popover keeps this height there and the part over an obstacle or off screen
 * counts against that side, so a full-height place that covers a little of an obstacle beats a 4 px strip.
 */
export const MIN_SHOWN_HEIGHT = 120

export interface PlacePopoverInput {
  /** What the popover belongs to (a button, a selection's box), viewport pixels. */
  anchor: Rect
  /** The popover's natural size. */
  size: { width: number; height: number }
  /** The visible area, usually { x: 0, y: 0, width: innerWidth, height: innerHeight }. */
  viewport: Rect
  /** Boxes to keep clear of: obstacleRects() (the popover's own id excluded), or plain boxes. */
  obstacles: readonly (Rect | ObstacleRect)[]
  /** The side(s) to try first, in order; the others follow in the default order below, above, right, left. */
  prefer?: PopoverSide | readonly PopoverSide[]
  /** Space between the popover and its anchor, and between it and an obstacle. Default 8. */
  gap?: number
  /** Space kept inside the viewport's edges. Default 8. */
  margin?: number
  /** The least height to give it (see MIN_SHOWN_HEIGHT, the default); capped at its natural height. */
  minHeight?: number
}

export interface Placement {
  x: number
  y: number
  side: PopoverSide
  /**
   * The most height the popover has there before an obstacle or the viewport's edge (the bottom toolbar, for one
   * below its anchor): give it as max-height and let it scroll. At least the natural height when it fits, and never
   * less than min(natural height, minHeight), even when that covers an obstacle (then `fits` is false).
   */
  maxHeight: number
  /**
   * Whether the whole natural size fits there, inside the viewport (less the margin) and clear of every obstacle.
   * False means nothing fit and this is the best there is: it is clipped (maxHeight < natural height), or it covers
   * part of an obstacle or the screen's edge, or both. A caller may then choose another layout (a sheet, a smaller
   * popover); W1's SelectionBar and W4's popovers check it rather than comparing heights themselves.
   */
  fits: boolean
}

interface Candidate {
  x: number
  y: number
  side: PopoverSide
  maxHeight: number
  /** area covering obstacles or outside the viewport */
  overlap: number
  /** natural height it is not given (clipped off) */
  missing: number
  sideIndex: number
  /** distance from the centred position on the anchor */
  drift: number
}

const isObstacle = (o: Rect | ObstacleRect): o is ObstacleRect => 'rect' in o

function sideOrder(prefer: PlacePopoverInput['prefer']): PopoverSide[] {
  const first = prefer === undefined ? [] : typeof prefer === 'string' ? [prefer] : [...prefer]
  const out: PopoverSide[] = []
  for (const s of [...first, ...DEFAULT_ORDER]) if (!out.includes(s)) out.push(s)
  return out
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi))

/**
 * Where a popover goes: the first side (in `prefer` order, then below, above, right, left) where its whole natural
 * size fits inside the viewport clear of every obstacle, slid along that side if an obstacle is in the way (the
 * position closest to centred on the anchor wins); `fits` is then true. When no side fits (`fits` false), the best
 * there is: each place gets the height it has room for, but at least min(natural height, minHeight), and the winner
 * is the one with the least area over obstacles or off screen at that height, then the most of its natural height,
 * then the side order. Pure and deterministic.
 */
export function placePopover(input: PlacePopoverInput): Placement {
  const gap = input.gap ?? 8
  const margin = input.margin ?? 8
  const { anchor } = input
  const w = Math.max(0, input.size.width)
  const h = Math.max(0, input.size.height)
  /** The least height a place gives it (a sliver is never offered as clear). */
  const minShown = Math.min(h, Math.max(0, input.minHeight ?? MIN_SHOWN_HEIGHT))
  const vp = {
    left: input.viewport.x + margin,
    top: input.viewport.y + margin,
    right: input.viewport.x + input.viewport.width - margin,
    bottom: input.viewport.y + input.viewport.height - margin,
  }
  const vpRect: Rect = { x: vp.left, y: vp.top, width: vp.right - vp.left, height: vp.bottom - vp.top }
  const obstacles = input.obstacles.map((o) => (isObstacle(o) ? o.rect : o)).filter((r) => usable(r))
  const cx = anchor.x + anchor.width / 2
  const cy = anchor.y + anchor.height / 2

  /** Area of `r` over obstacles, plus its area outside the viewport. */
  const cost = (r: Rect) => {
    let a = 0
    for (const o of obstacles) a += intersectionArea(r, o)
    return a + (r.width * r.height - intersectionArea(r, vpRect))
  }
  /** How far down from `y` a column [x, x + w] is free (the viewport's bottom or the next obstacle's top). */
  const freeBelow = (x: number, y: number) => {
    let limit = vp.bottom
    for (const o of obstacles)
      if (o.x < x + w && right(o) > x && bottom(o) > y) limit = Math.min(limit, Math.max(y, o.y - gap))
    return Math.max(0, limit - y)
  }
  /** How far up from `y` a column [x, x + w] is free. */
  const freeAbove = (x: number, y: number) => {
    let limit = vp.top
    for (const o of obstacles)
      if (o.x < x + w && right(o) > x && o.y < y) limit = Math.max(limit, Math.min(y, bottom(o) + gap))
    return Math.max(0, y - limit)
  }

  const xs = () => {
    const raw = [cx - w / 2, anchor.x, right(anchor) - w]
    for (const o of obstacles) raw.push(o.x - gap - w, right(o) + gap)
    return [...new Set(raw.map((x) => clamp(x, vp.left, vp.right - w)))]
  }
  const ys = () => {
    const raw = [cy - h / 2, anchor.y, bottom(anchor) - h]
    for (const o of obstacles) raw.push(o.y - gap - h, bottom(o) + gap)
    return [...new Set(raw.map((y) => clamp(y, vp.top, vp.bottom - h)))]
  }

  const candidates: Candidate[] = []
  sideOrder(input.prefer).forEach((side, sideIndex) => {
    if (side === 'below' || side === 'above') {
      for (const x of xs()) {
        const edge = side === 'below' ? bottom(anchor) + gap : anchor.y - gap
        const room = side === 'below' ? freeBelow(x, edge) : freeAbove(x, edge)
        const shown = Math.max(Math.min(h, room), minShown)
        const y = side === 'below' ? edge : edge - shown
        candidates.push({
          x,
          y,
          side,
          maxHeight: Math.max(room, shown),
          overlap: cost({ x, y, width: w, height: shown }),
          missing: h - shown,
          sideIndex,
          drift: Math.abs(x + w / 2 - cx),
        })
      }
    } else {
      const x = side === 'right' ? right(anchor) + gap : anchor.x - gap - w
      for (const y0 of ys()) {
        const room = freeBelow(x, y0)
        const shown = Math.max(Math.min(h, room), minShown)
        candidates.push({
          x,
          y: y0,
          side,
          maxHeight: Math.max(room, shown),
          overlap: cost({ x, y: y0, width: w, height: shown }),
          missing: h - shown,
          sideIndex,
          drift: Math.abs(y0 + h / 2 - cy),
        })
      }
    }
  })

  const EPS = 0.5
  candidates.sort(
    (a, b) =>
      (a.overlap > EPS ? a.overlap : 0) - (b.overlap > EPS ? b.overlap : 0) ||
      (a.missing > EPS ? a.missing : 0) - (b.missing > EPS ? b.missing : 0) ||
      a.sideIndex - b.sideIndex ||
      a.drift - b.drift ||
      a.x - b.x ||
      a.y - b.y,
  )
  const best = candidates[0] as Candidate
  return {
    x: Math.round(best.x),
    y: Math.round(best.y),
    side: best.side,
    maxHeight: Math.max(0, Math.floor(best.maxHeight)),
    fits: best.overlap <= EPS && best.missing <= EPS,
  }
}
