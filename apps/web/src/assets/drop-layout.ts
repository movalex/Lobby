// Where dropped or uploaded files land on the board (FIL-06). Pure page-space layout; the editor
// wiring is in board/ExternalContent.tsx.
//
// tldraw 5.4.2 creates dropped images at their native pixel size in one long row (47 photos were
// 88,000 units wide), parents each one to whatever frame is under its own top-left corner, and then
// moves the row, so images end up outside the frame that clips them. Instead:
//   - sizes are in page units, the same for every upload (F2-01: they used to follow the zoom, so
//     three uploads came out at 1x, 2.5x and 5x): the median longest side of the images already in
//     the frame (or on the page) under the drop point, else DEFAULT_IMAGE_SIDE; several images share a
//     grid of ceil(sqrt(n)) columns of equal square cells of that side;
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
  /**
   * F12: in a drop of images and file cards, the cards share the images' cells, scaled down to at
   * most this much (their footer and page strip stay readable); the image cells grow to match.
   */
  cardMinScale: 0.7,
  /**
   * Screen px kept free under the dropped block after the camera move: tldraw's toolbar (about 100)
   * plus the selection bar (54) that sits under the selection (canvas-ux Overlay.tsx).
   */
  barClearancePx: 160,
  /** Screen px above the block the selection bar needs when it flips over the selection. */
  barAbovePx: 114,
} as const

/** F2-01: the longest side (page units) of a dropped image when nothing on the board sets one. */
export const DEFAULT_IMAGE_SIDE = 400
/** F2-01: bounds for a longest side taken from the images already there. */
export const IMAGE_SIDE_RANGE = { min: 120, max: 1600 } as const

/**
 * F2-01: the longest side new images get: the median longest side of `existing` (the images already
 * in the frame, or on the page, where they land), else DEFAULT_IMAGE_SIDE. Page units, so a second
 * upload at another zoom matches the first.
 */
export function imageSideFor(existing: readonly Size[]): number {
  const sides = existing
    .map((s) => Math.max(s.w, s.h))
    .filter(finitePositive)
    .sort((a, b) => a - b)
  if (!sides.length) return DEFAULT_IMAGE_SIDE
  const mid = Math.floor(sides.length / 2)
  const hi = sides[mid] as number
  const median = sides.length % 2 ? hi : ((sides[mid - 1] as number) + hi) / 2
  return clamp(Math.round(median), IMAGE_SIDE_RANGE.min, IMAGE_SIDE_RANGE.max)
}

/** The gap between grid cells of `side` page units (F2-01: page units too). */
const pageGap = (side: number) => Math.max(20, Math.round(side * 0.05))
const isSide = (side: number | undefined): side is number => side !== undefined && finitePositive(side)

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
 * The side of the square cells for a grid of `n` images: the grid tries to fill 85 % of the viewport,
 * each cell between 20 % and 40 % of the viewport's shorter side (page units).
 */
export function imageCellSide(n: number, view: View, side?: number): number {
  if (isSide(side)) return side
  const zoom = saneZoom(view.zoom)
  const vp = view.viewport
  const short = Math.min(vp.w, vp.h)
  const gap = DROP_LAYOUT.gapPx / zoom
  const cols = Math.ceil(Math.sqrt(Math.max(1, n)))
  const rows = Math.ceil(Math.max(1, n) / cols)
  const fill = DROP_LAYOUT.gridFill
  const fit = Math.min((vp.w * fill - (cols - 1) * gap) / cols, (vp.h * fill - (rows - 1) * gap) / rows)
  return clamp(fit, short * DROP_LAYOUT.minCellFraction, short * DROP_LAYOUT.singleFraction)
}

/** A file card scaled to fit a square cell of side `side`: never enlarged, never below cardMinScale. */
export function cardInCell(card: Size, side: number): Size {
  const s = saneSize(card)
  const k = clamp(side / Math.max(s.w, s.h), DROP_LAYOUT.cardMinScale, 1)
  return { w: s.w * k, h: s.h * k }
}

/**
 * F12: a drop of images and file cards as one grid at one scale. The cells are the images' cells,
 * grown when needed so the largest card fits at cardMinScale; every image is contain-fitted in its
 * cell and every card scaled to it, each centred. The images fill the rows in drop order, and the
 * cards start on the row after them, in the same columns (so nothing reads as a second, bigger grid).
 */
export function layoutMixedGrid(
  images: readonly Size[],
  cards: readonly Size[],
  view: View,
  side?: number,
): { block: Block; images: Rect[]; cards: Rect[]; imagesBounds: Rect | null } {
  // Page-space sizes (F2-01) cap the upscale in page units, the same at every zoom.
  const zoom = isSide(side) ? 1 : saneZoom(view.zoom)
  const largestCard = Math.max(0, ...cards.map((c) => Math.max(saneSize(c).w, saneSize(c).h)))
  let cell = Math.max(imageCellSide(images.length, view, side), largestCard * DROP_LAYOUT.cardMinScale)
  // Cards are never scaled up (cardInCell), so a cell larger than the largest card would leave the cards
  // smaller than the images: in a mixed drop the images take the cards' size instead (F12: one scale).
  if (largestCard > 0) cell = Math.min(cell, largestCard)
  const gap = isSide(side) ? pageGap(cell) : DROP_LAYOUT.gapPx / zoom
  const cols = Math.max(1, Math.ceil(Math.sqrt(images.length)), Math.ceil(Math.sqrt(cards.length)))
  const at = (index: number, size: Size): Rect => {
    const col = index % cols
    const row = Math.floor(index / cols)
    return {
      x: col * (cell + gap) + (cell - size.w) / 2,
      y: row * (cell + gap) + (cell - size.h) / 2,
      w: size.w,
      h: size.h,
    }
  }
  const imageRects = images.map((size, i) => at(i, fitSquare(size, cell, zoom)))
  const firstCard = Math.ceil(images.length / cols) * cols
  const cardRects = cards.map((size, j) => at(firstCard + j, cardInCell(size, cell)))
  const block = normalize([...imageRects, ...cardRects])
  const split = imageRects.length
  return {
    block,
    images: block.items.slice(0, split),
    cards: block.items.slice(split),
    imagesBounds: unionRects(block.items.slice(0, split)),
  }
}

/**
 * Image shapes for `sizes` (native pixel sizes, aspect ratio kept): one image at about 40 % of the
 * viewport's shorter side; several in ceil(sqrt(n)) columns of equal square cells, each image
 * centred in its cell, with even gaps. Cells shrink (down to 20 % of the shorter side) to keep the
 * grid inside the viewport; past that the grid overflows and the caller zooms out.
 */
export function layoutImageGrid(sizes: readonly Size[], view: View, side?: number): Block {
  const n = sizes.length
  if (!n) return { w: 0, h: 0, items: [] }
  const zoom = isSide(side) ? 1 : saneZoom(view.zoom)
  const cols = Math.ceil(Math.sqrt(n))
  const cell = imageCellSide(n, view, side)
  const gap = isSide(side) ? pageGap(cell) : DROP_LAYOUT.gapPx / zoom
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

/** tldraw's image crop: the part of the image shown, as fractions (0–1) of the whole image. */
export interface SlotCrop {
  topLeft: Point
  bottomRight: Point
}

/**
 * F2-02: an image dropped on a template slot fills it: the image takes the slot's rect and is
 * centre-cropped to the slot's shape (null crop when the shapes already match), so the slot's
 * placeholder text never peeks out beside a portrait photo. The whole image stays recoverable
 * through tldraw's Crop.
 */
export function coverSlot(size: Size, slot: Rect): { rect: Rect; crop: SlotCrop | null } {
  const s = saneSize(size)
  const rect = { x: slot.x, y: slot.y, w: slot.w, h: slot.h }
  if (!finitePositive(slot.w) || !finitePositive(slot.h)) return { rect: fitInSlot(size, slot), crop: null }
  const image = s.w / s.h
  const target = slot.w / slot.h
  if (Math.abs(image / target - 1) < 0.005) return { rect, crop: null }
  if (image > target) {
    const cut = (1 - target / image) / 2
    return { rect, crop: { topLeft: { x: cut, y: 0 }, bottomRight: { x: 1 - cut, y: 1 } } }
  }
  const cut = (1 - image / target) / 2
  return { rect, crop: { topLeft: { x: 0, y: cut }, bottomRight: { x: 1, y: 1 - cut } } }
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
 * Template image slots in rows (top to bottom), each row left to right. Slots whose centres are
 * within half a slot's height of a row's first slot share its row.
 */
export function slotRows<T extends { id: string; bounds: Rect }>(slots: readonly T[]): T[][] {
  const cy = (s: T) => s.bounds.y + s.bounds.h / 2
  const byY = [...slots].sort((a, b) => cy(a) - cy(b) || a.bounds.x - b.bounds.x)
  const rows: T[][] = []
  for (const s of byY) {
    const row = rows[rows.length - 1]
    const first = row?.[0]
    if (row && first && Math.abs(cy(s) - cy(first)) <= Math.min(s.bounds.h, first.bounds.h) / 2) row.push(s)
    else rows.push([s])
  }
  for (const row of rows) row.sort((a, b) => a.bounds.x - b.bounds.x || (a.id < b.id ? -1 : 1))
  return rows
}

/**
 * F6: the order several dropped images fill a frame's empty slots: reading order, starting at the
 * slot under the pointer (`startId`) and wrapping around to the first ones.
 */
export function slotFillOrder<T extends { id: string; bounds: Rect }>(
  slots: readonly T[],
  startId: string | null = null,
): T[] {
  const order = slotRows(slots).flat()
  const i = startId ? order.findIndex((s) => s.id === startId) : -1
  return i > 0 ? [...order.slice(i), ...order.slice(0, i)] : order
}

/**
 * Images in a grid of equal cells of `cell`'s size (the template slots' size: F6, the images that
 * did not find a free slot stay at the same scale as the ones that did), `cols` per row, each image
 * contain-fitted and centred in its cell.
 */
export function layoutCellGrid(sizes: readonly Size[], cell: Size, cols: number, gap: number): Block {
  if (!sizes.length) return { w: 0, h: 0, items: [] }
  const c = saneSize(cell)
  const n = Math.max(1, Math.floor(cols))
  const items = sizes.map((size, i) => {
    const r = fitInSlot(size, { x: 0, y: 0, w: c.w, h: c.h })
    const col = i % n
    const row = Math.floor(i / n)
    return { ...r, x: col * (c.w + gap) + r.x, y: row * (c.h + gap) + r.y }
  })
  return normalize(items)
}

/**
 * Top-left for a block that goes right under a frame (centred on it), or the nearest spot to that
 * clear of `obstacles` (the page's other content, the frame itself included).
 */
export function placeUnder(size: Size, frame: Rect, obstacles: readonly Rect[], clearance: number): Point {
  const center = { x: frame.x + frame.w / 2, y: frame.y + frame.h + clearance + size.h / 2 }
  return findEmptySpot(size, center, obstacles, { gap: clearance })
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
  /**
   * F2-01: the images' longest side in page units (imageSideFor). Without it, sizes follow the
   * viewport (the old screen-relative rule).
   */
  imageSide?: number
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

/** The drop's rects relative to the block's top-left, and the point that goes on the drop point. */
interface DropBlock {
  w: number
  h: number
  images: Rect[]
  cards: Rect[]
  anchor: Point
}

function dropBlock(input: DropPlanInput): DropBlock | null {
  const zoom = saneZoom(input.view.zoom)
  if (input.images.length && input.cards.length) {
    // F12: images and cards at one scale, in one grid; the images' part is centred on the drop point.
    const mixed = layoutMixedGrid(input.images, input.cards, input.view, input.imageSide)
    const ib = mixed.imagesBounds as Rect
    return {
      w: mixed.block.w,
      h: mixed.block.h,
      images: mixed.images,
      cards: mixed.cards,
      anchor: { x: ib.x + ib.w / 2, y: ib.y + ib.h / 2 },
    }
  }
  const grid = layoutImageGrid(input.images, input.view, input.imageSide)
  const maxRowWidth = Math.max(grid.w, input.view.viewport.w * DROP_LAYOUT.cardRowFraction)
  const cards = layoutCardRows(input.cards, { maxRowWidth, gap: input.cardGap })
  if (!grid.items.length && !cards.items.length) return null
  const gap = isSide(input.imageSide) ? pageGap(input.imageSide) : DROP_LAYOUT.gapPx / zoom
  const sectionGap = grid.items.length && cards.items.length ? Math.max(2 * gap, 2 * input.cardGap) : 0
  const w = Math.max(grid.w, cards.w)
  const h = grid.h + sectionGap + cards.h
  const gridX = (w - grid.w) / 2
  const cardsX = (w - cards.w) / 2
  const cardsY = grid.h + sectionGap
  return {
    w,
    h,
    images: grid.items.map((r) => ({ ...r, x: r.x + gridX })),
    cards: cards.items.map((r) => ({ ...r, x: r.x + cardsX, y: r.y + cardsY })),
    // The image grid is centred on the drop point; cards alone are centred.
    anchor: { x: w / 2, y: grid.items.length ? grid.h / 2 : h / 2 },
  }
}

/**
 * The whole drop, placed as one block: the image grid and the file cards under it. Images alone keep
 * the screen-relative grid; cards alone keep their size, in rows; both together share one grid of
 * equal cells (F12), the cards scaled to the images' cells.
 */
export function planDrop(input: DropPlanInput): DropPlan {
  const zoom = saneZoom(input.view.zoom)
  const block = dropBlock(input)
  if (!block) return { containerId: null, images: [], cards: [], bounds: null }
  const { w, h } = block
  const center = {
    x: input.center.x - block.anchor.x + w / 2,
    y: input.center.y - block.anchor.y + h / 2,
  }
  const { containerId, topLeft } = placeBlock(
    { w, h },
    center,
    input.containers,
    DROP_LAYOUT.clearancePx / zoom,
  )
  const move = (r: Rect): Rect => ({ ...r, x: r.x + topLeft.x, y: r.y + topLeft.y })
  const images = block.images.map(move)
  const cardRects = block.cards.map(move)
  return { containerId, images, cards: cardRects, bounds: unionRects([...images, ...cardRects]) }
}

/**
 * `target` grown downward so that, once zoomToBounds (inset `2 × pad` screen px) fits it into a
 * `screenH` px tall view, barClearancePx stay free under the content whose bottom is `d` page units
 * below the target's top. Height-limited fit, zoom z = (H − 2·pad) / (h + e): the content's bottom is
 * at pad + d·z ≤ H − R  ⇒  e ≥ d·(H − 2·pad) / (H − pad − R) − h. A width- or zoom-limited fit only
 * leaves more room (the target is centred).
 */
function withBarRoom(target: Rect, d: number, screenH: number, pad: number): Rect {
  const room = screenH - pad - DROP_LAYOUT.barClearancePx
  if (!(room > 0) || !(d > 0)) return target
  const extra = (d * (screenH - 2 * pad)) / room - target.h
  return extra > 0 ? { ...target, h: target.h + extra } : target
}

/**
 * The page rect to bring into view after a drop, or null when everything already is. Zooms out only
 * as far as needed: to the old viewport plus the new content when that costs at most 1.5x the zoom
 * change of the content alone (so the user sees where the files went), else to the content alone.
 *
 * F12: the dropped block ends up selected, and the selection bar sits under it (or over it when there
 * is no room below). "In view" therefore means the bar fits too, and the target keeps a band free
 * under the content for it and tldraw's toolbar (`zoom`: the camera's zoom when the files arrived).
 */
export function cameraTargetAfterDrop(viewport: Rect, content: Rect | null, zoom = 1): Rect | null {
  if (!content) return null
  const z = saneZoom(zoom)
  const vpBottom = viewport.y + viewport.h
  const contentBottom = content.y + content.h
  const barFits =
    contentBottom <= vpBottom - DROP_LAYOUT.barClearancePx / z ||
    (content.y >= viewport.y + DROP_LAYOUT.barAbovePx / z && contentBottom <= vpBottom - 100 / z)
  if (rectContains(viewport, content) && barFits) return null
  const union = unionRects([viewport, content])
  const zoomOut = (r: Rect) => Math.max(r.w / viewport.w, r.h / viewport.h)
  const target = union && zoomOut(union) <= Math.max(zoomOut(content), 1) * 1.5 ? union : content
  // tldraw's zoomToBounds inset: min(zoomToFitPadding 128, 28 % of the width), half on each side.
  const pad = Math.min(128, viewport.w * z * 0.28) / 2
  return withBarRoom(target, contentBottom - target.y, viewport.h * z, pad)
}
