// K1-8 (wave K): which elements painted above a file card cut a hole in its face (./CardLayer.tsx), in
// linear time. The old scan compared every card with every element painted after it (`holesAboveScan`,
// kept here as the reference the test compares with): 421 ms of a 5,000-element open at CPU 4x, again
// each time an image finished loading. `Occluders` puts the opaque elements in a grid of CELL-sized
// scene cells once per pass, with their paint index (the note-author labels' approach,
// features/workshops/ported/note-authors.ts), so a card asks only the cells it covers.
//
// The answer is the old scan's, hole for hole and in the same order (by paint index): an element that
// spans more than BIG_CELLS cells (a background image), and any box the grid cannot place (a negative or
// non-finite size), is checked against every card as before; a card box the grid cannot place, or one
// that spans more cells than there are occluders, is answered by the scan over the occluders.
import { type CanvasElement, geometry } from '../../canvas/api/index.ts'

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Whether an element painted above a card hides that part of it, so it cuts a hole in the card's face:
 * notes, images (and other cards) and shapes with a solid fill. Frames never do (their children are
 * drawn over them); strokes, texts and unfilled shapes over a card stay under its face.
 */
export function opaque(el: CanvasElement): boolean {
  if (el.type === 'stickynote' || el.type === 'image') return true
  if (el.type !== 'rectangle' && el.type !== 'ellipse' && el.type !== 'diamond') return false
  const e = el as { backgroundColor?: string; fillStyle?: string; opacity?: number }
  return e.backgroundColor !== 'transparent' && e.fillStyle === 'solid' && (e.opacity ?? 100) >= 100
}

export const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** An element's axis-aligned box from its own fields (rotation included; cheap: no engine call). */
export function aabbOf(el: CanvasElement): Box {
  const r = { x: el.x, y: el.y, width: el.width, height: el.height }
  if (!el.angle) return { x: r.x, y: r.y, w: r.width, h: r.height }
  const pts = geometry.corners(r, el.angle)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The part of `box` that `r` covers, in box-local units (null: none). */
function holeOf(r: Box, box: Box): Box | null {
  const x1 = Math.max(0, r.x - box.x)
  const y1 = Math.max(0, r.y - box.y)
  const x2 = Math.min(box.w, r.x + r.w - box.x)
  const y2 = Math.min(box.h, r.y + r.h - box.y)
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null
}

/**
 * The reference: the holes cut in `box` (the card at paint index `index`) by the opaque, visible elements
 * painted after it, in paint order. Linear per card, so quadratic per pass; `Occluders` answers the same.
 */
export function holesAboveScan(
  items: readonly CanvasElement[],
  index: number,
  box: Box,
  isHidden: (id: string) => boolean,
): Box[] {
  const out: Box[] = []
  for (let i = index + 1; i < items.length; i++) {
    const el = items[i] as CanvasElement
    if (!opaque(el)) continue
    const r = aabbOf(el)
    if (!overlap(r, box) || isHidden(el.id)) continue
    const hole = holeOf(r, box)
    if (hole) out.push(hole)
  }
  return out
}

/** Scene units per grid cell (a note is 200). */
export const CELL = 512
/** An occluder over more cells than this (a background image) is checked against every card instead. */
export const BIG_CELLS = 64

interface Occluder {
  readonly index: number
  readonly box: Box
  /** the last query that collected it (no Set per query) */
  seen: number
}

const placeable = (b: Box) =>
  Number.isFinite(b.x) &&
  Number.isFinite(b.y) &&
  Number.isFinite(b.w) &&
  Number.isFinite(b.h) &&
  b.w >= 0 &&
  b.h >= 0

/** The grid cells a placeable box spans: [x0, x1, y0, y1]. */
function span(b: Box): [number, number, number, number] {
  return [
    Math.floor(b.x / CELL),
    Math.floor((b.x + b.w) / CELL),
    Math.floor(b.y / CELL),
    Math.floor((b.y + b.h) / CELL),
  ]
}

/** The opaque, visible elements of one pass by grid cell, with their paint index. */
export class Occluders {
  private readonly cells = new Map<string, Occluder[]>()
  /** checked for every card: big ones, and boxes the grid cannot place */
  private readonly loose: Occluder[] = []
  private readonly all: Occluder[] = []
  private query = 0

  constructor(items: readonly CanvasElement[], isHidden: (id: string) => boolean) {
    items.forEach((el, index) => {
      // an element that cannot be seen (a collapsed branch) hides nothing
      if (!opaque(el) || isHidden(el.id)) return
      const o: Occluder = { index, box: aabbOf(el), seen: 0 }
      this.all.push(o)
      if (!placeable(o.box)) {
        this.loose.push(o)
        return
      }
      const [x0, x1, y0, y1] = span(o.box)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG_CELLS) {
        this.loose.push(o)
        return
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const key = `${x}:${y}`
          const list = this.cells.get(key)
          if (list) list.push(o)
          else this.cells.set(key, [o])
        }
    })
  }

  /** How many opaque, visible elements the pass has. */
  get size(): number {
    return this.all.length
  }

  /** The holes cut in `box` (the card at paint index `index`): `holesAboveScan`'s answer. */
  holesAbove(index: number, box: Box): Box[] {
    const q = ++this.query
    const found: Occluder[] = []
    const take = (o: Occluder) => {
      if (o.seen === q || o.index <= index) return
      o.seen = q
      if (overlap(o.box, box)) found.push(o)
    }
    let scan = !placeable(box)
    if (!scan) {
      const [x0, x1, y0, y1] = span(box)
      // a card over more cells than there are occluders: the scan over them is the cheaper one
      scan = (x1 - x0 + 1) * (y1 - y0 + 1) > Math.max(BIG_CELLS, this.all.length)
      if (!scan) {
        for (const o of this.loose) take(o)
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const list = this.cells.get(`${x}:${y}`)
            if (list) for (const o of list) take(o)
          }
      }
    }
    if (scan) for (const o of this.all) take(o)
    if (found.length > 1) found.sort((a, b) => a.index - b.index)
    const out: Box[] = []
    for (const o of found) {
      const hole = holeOf(o.box, box)
      if (hole) out.push(hole)
    }
    return out
  }
}
