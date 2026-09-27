// Where dropped or uploaded files land on the board (FIL-06). Pure page-space layout; the editor
// wiring is in board/ExternalContent.tsx.
//
// tldraw 5.4.2 creates dropped images at their native pixel size in one long row (47 photos were
// 88,000 units wide), parents each one to whatever frame is under its own top-left corner, and then
// moves the row, so images end up outside the frame that clips them. Instead:
//   - sizes are relative to the screen: one image gets a longest side of about 40 % of the viewport's
//     shorter side; several share a grid of ceil(sqrt(n)) columns of equal square cells;
//   - the grid (and the row of file cards under it) is centred on the drop point, moved to the nearest
//     empty spot if that would cover existing content, and goes into a frame only when all of it fits
//     inside that frame.

import {
  findEmptySpot,
  type Point,
  type Rect,
  rectContains,
  rectsOverlap,
  unionRects,
} from '../features/canvas-ux/placement.ts'

export type { Point, Rect }

export interface Size {
  w: number
  h: number
}

export const DROP_LAYOUT = {
  /** One image: its longest side as a fraction of the viewport's shorter side. */
  singleFraction: 0.4,
  /** Grid cells never get smaller than this fraction of the viewport's shorter side. */
  minCellFraction: 0.2,
  /** A grid tries to fit into this fraction of the viewport before it overflows it. */
  gridFill: 0.85,
  /** Gap between grid cells, in screen px. */
  gapPx: 20,
  /** Clearance kept from existing content and from a frame's border, in screen px. */
  clearancePx: 32,
  /** Never enlarge an image past this many screen px per image px. */
  maxUpscale: 2,
  /** A row of file cards wraps at this fraction of the viewport width (or the grid's width). */
  cardRowFraction: 0.8,
} as const

/** The camera when the files arrived: viewport in page units and the zoom level. */
export interface View {
  viewport: Rect
  zoom: number
}

/** Rects relative to the block's top-left; `w`/`h` are the tight extent of all of them. */
export interface Block {
  w: number
  h: number
  items: Rect[]
}

const finitePositive = (n: number) => Number.isFinite(n) && n > 0
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const saneSize = (s: Size): Size => (finitePositive(s.w) && finitePositive(s.h) ? s : { w: 1, h: 1 })
const saneZoom = (z: number) => (finitePositive(z) ? z : 1)

function normalize(items: Rect[]): Block {
  const u = unionRects(items)
  if (!u) return { w: 0, h: 0, items: [] }
  return { w: u.w, h: u.h, items: items.map((r) => ({ ...r, x: r.x - u.x, y: r.y - u.y })) }
}

/** Contain-fits `size` into a square of side `side`, never enlarging past maxUpscale on screen. */
function fitSquare(size: Size, side: number, zoom: number): Size {
  const s = saneSize(size)
  const longest = Math.max(s.w, s.h)
  const target = Math.min(side, (DROP_LAYOUT.maxUpscale * longest) / zoom)
  const k = target / longest
  return { w: s.w * k, h: s.h * k }
}

/**
 * Image shapes for `sizes` (native pixel sizes, aspect ratio kept): one image at about 40 % of the
 * viewport's shorter side; several in ceil(sqrt(n)) columns of equal square cells, each image
 * centred in its cell, with even gaps. Cells shrink (down to 20 % of the shorter side) to keep the
 * grid inside the viewport; past that the grid overflows and the caller zooms out.
 */
export function layoutImageGrid(sizes: readonly Size[], view: View): Block {
  const n = sizes.length
  if (!n) return { w: 0, h: 0, items: [] }
  const zoom = saneZoom(view.zoom)
  const vp = view.viewport
  const short = Math.min(vp.w, vp.h)
  const gap = DROP_LAYOUT.gapPx / zoom
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const fill = DROP_LAYOUT.gridFill
  const fit = Math.min((vp.w * fill - (cols - 1) * gap) / cols, (vp.h * fill - (rows - 1) * gap) / rows)
  const cell = clamp(fit, short * DROP_LAYOUT.minCellFraction, short * DROP_LAYOUT.singleFraction)
  const items = sizes.map((size, i) => {
    const { w, h } = fitSquare(size, cell, zoom)
    const col = i % cols
    const row = Math.floor(i / cols)
    return { x: col * (cell + gap) + (cell - w) / 2, y: row * (cell + gap) + (cell - h) / 2, w, h }
  })
  return normalize(items)
}

/** File cards in rows (tops aligned, each row centred), wrapping before `maxRowWidth`. */
export function layoutCardRows(sizes: readonly Size[], opts: { maxRowWidth: number; gap: number }): Block {
  if (!sizes.length) return { w: 0, h: 0, items: [] }
  const rows: Size[][] = []
  let row: Size[] = []
  let rowW = 0
  for (const raw of sizes) {
    const s = saneSize(raw)
    const next = row.length ? rowW + opts.gap + s.w : s.w
    if (row.length && next > opts.maxRowWidth) {
      rows.push(row)
      row = [s]
      rowW = s.w
    } else {
      row.push(s)
      rowW = next
    }
  }
  rows.push(row)
  const widths = rows.map((r) => r.reduce((sum, s) => sum + s.w, 0) + opts.gap * (r.length - 1))
  const blockW = Math.max(...widths)
  const items: Rect[] = []
  let y = 0
  rows.forEach((r, i) => {
    let x = (blockW - (widths[i] ?? 0)) / 2
    for (const s of r) {
      items.push({ x, y, w: s.w, h: s.h })
      x += s.w + opts.gap
    }
    y += Math.max(...r.map((s) => s.h)) + opts.gap
  })
  return normalize(items)
}

/** Contain-fits an image into a template image slot, centred. */
export function fitInSlot(size: Size, slot: Rect): Rect {
  const s = saneSize(size)
  const k = Math.min(slot.w / s.w, slot.h / s.h)
  const w = s.w * k
  const h = s.h * k
  return { x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h }
}

/**
 * Somewhere the block may go: a frame (`bounds`) with its children as obstacles, or the page
 * (`bounds: null`) with its top-level shapes as obstacles.
 */
export interface DropContainer {
  id: string | null
  bounds: Rect | null
  obstacles: readonly Rect[]
}

// Walls around a frame: findEmptySpot keeps `gap` clear of them, i.e. inside the frame's padding.
const WALL = 1e7
function walls(b: Rect): Rect[] {
  return [
    { x: b.x - WALL, y: b.y - WALL, w: WALL, h: b.h + 2 * WALL },
    { x: b.x + b.w, y: b.y - WALL, w: WALL, h: b.h + 2 * WALL },
    { x: b.x - WALL, y: b.y - WALL, w: b.w + 2 * WALL, h: WALL },
    { x: b.x - WALL, y: b.y + b.h, w: b.w + 2 * WALL, h: WALL },
  ]
}

/** Top-left for `size` inside the frame `bounds`, clear of `obstacles` by `pad`, or null. */
function placeInside(size: Size, center: Point, bounds: Rect, obstacles: readonly Rect[], pad: number) {
  if (size.w + 2 * pad > bounds.w || size.h + 2 * pad > bounds.h) return null
  const c = {
    x: clamp(center.x, bounds.x + pad + size.w / 2, bounds.x + bounds.w - pad - size.w / 2),
    y: clamp(center.y, bounds.y + pad + size.h / 2, bounds.y + bounds.h - pad - size.h / 2),
  }
  const spot = findEmptySpot(size, c, [...obstacles, ...walls(bounds)], {
    gap: pad,
    step: Math.max(4, Math.min(bounds.w, bounds.h) / 24),
    maxRings: 24,
  })
  const box = { x: spot.x, y: spot.y, w: size.w, h: size.h }
  const tol = 0.5
  const inner = {
    x: bounds.x + pad - tol,
    y: bounds.y + pad - tol,
    w: bounds.w - 2 * pad + 2 * tol,
    h: bounds.h - 2 * pad + 2 * tol,
  }
  if (!rectContains(inner, box) || obstacles.some((o) => rectsOverlap(box, o))) return null
  return spot
}

/**
 * Tries each container in order (innermost frame under the drop point first, the page last) and
 * returns the first one with room for the whole block, plus the block's top-left there.
 */
export function placeBlock(
  size: Size,
  center: Point,
  containers: readonly DropContainer[],
  clearance: number,
): { containerId: string | null; topLeft: Point } {
  for (const c of containers) {
    if (!c.bounds) {
      return { containerId: null, topLeft: findEmptySpot(size, center, c.obstacles, { gap: clearance }) }
    }
    const spot = placeInside(size, center, c.bounds, c.obstacles, clearance)
    if (spot) return { containerId: c.id, topLeft: spot }
  }
  return { containerId: null, topLeft: { x: center.x - size.w / 2, y: center.y - size.h / 2 } }
}

export interface DropPlanInput {
  /** Native sizes of the images that go into the grid, in drop order. */
  images: readonly Size[]
  /** Sizes of the file cards, in drop order. */
  cards: readonly Size[]
  /** The drop point (the viewport centre for "Insert file"). */
  center: Point
  view: View
  /** Innermost frame under the drop point first; the page (bounds null) last. */
  containers: readonly DropContainer[]
  /** Gap between file cards, page units. */
  cardGap: number
}

export interface DropPlan {
  /** The frame the whole block fits in, or null for the page. */
  containerId: string | null
  /** Page rects for the images, in input order. */
  images: Rect[]
  /** Page rects for the file cards, in input order (under the images). */
  cards: Rect[]
  /** Union of everything placed. */
  bounds: Rect | null
}

/** The whole drop: the image grid, the file cards under it, placed as one block. */
export function planDrop(input: DropPlanInput): DropPlan {
  const zoom = saneZoom(input.view.zoom)
  const grid = layoutImageGrid(input.images, input.view)
  const maxRowWidth = Math.max(grid.w, input.view.viewport.w * DROP_LAYOUT.cardRowFraction)
  const cards = layoutCardRows(input.cards, { maxRowWidth, gap: input.cardGap })
  if (!grid.items.length && !cards.items.length) {
    return { containerId: null, images: [], cards: [], bounds: null }
  }
  const gap = DROP_LAYOUT.gapPx / zoom
  const sectionGap = grid.items.length && cards.items.length ? Math.max(2 * gap, 2 * input.cardGap) : 0
  const w = Math.max(grid.w, cards.w)
  const h = grid.h + sectionGap + cards.h
  const gridX = (w - grid.w) / 2
  const cardsX = (w - cards.w) / 2
  const cardsY = grid.h + sectionGap
  // The image grid is centred on the drop point and the cards hang below it; cards alone are centred.
  const anchorY = grid.items.length ? grid.h / 2 : h / 2
  const center = { x: input.center.x, y: input.center.y - anchorY + h / 2 }
  const { containerId, topLeft } = placeBlock(
    { w, h },
    center,
    input.containers,
    DROP_LAYOUT.clearancePx / zoom,
  )
  const images = grid.items.map((r) => ({ ...r, x: r.x + topLeft.x + gridX, y: r.y + topLeft.y }))
  const cardRects = cards.items.map((r) => ({
    ...r,
    x: r.x + topLeft.x + cardsX,
    y: r.y + topLeft.y + cardsY,
  }))
  return { containerId, images, cards: cardRects, bounds: unionRects([...images, ...cardRects]) }
}

/**
 * The page rect to bring into view after a drop, or null when everything already is. Zooms out only
 * as far as needed: to the old viewport plus the new content when that costs at most 1.5x the zoom
 * change of the content alone (so the user sees where the files went), else to the content alone.
 */
export function cameraTargetAfterDrop(viewport: Rect, content: Rect | null): Rect | null {
  if (!content || rectContains(viewport, content)) return null
  const union = unionRects([viewport, content])
  if (!union) return content
  const zoomOut = (r: Rect) => Math.max(r.w / viewport.w, r.h / viewport.h)
  return zoomOut(union) <= Math.max(zoomOut(content), 1) * 1.5 ? union : content
}
