// K7-4: where an AI result will land, drawn as a placeholder while the request runs (pure geometry; the
// overlay is ./Overlay.tsx). The wait is 2 to 3 seconds: a shimmer exactly where the result will appear makes
// it read as deliberate. Scene space, so it follows the camera; nothing here is ever written to the board.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One placeholder block: a sticky note, a topic pill, the centre of a map, or a whole region. */
export interface ShimmerTile extends Rect {
  shape: 'note' | 'pill' | 'hub' | 'region'
}

export interface ShimmerPlan {
  /** Everything the result will occupy (scene space). */
  rect: Rect
  tiles: ShimmerTile[]
}

/** Most placeholder blocks drawn at once. */
export const SHIMMER_MAX_TILES = 16
const GAP = 16

const clampCount = (n: number) => Math.max(1, Math.min(SHIMMER_MAX_TILES, Math.round(n) || 1))

/** The columns `applyNotes` lays `n` notes out in (./apply.ts): up to 4 in a row, 3 across from 5 notes. */
export function noteColumns(n: number): number {
  return n <= 4 ? n : n <= 9 ? 3 : 4
}

/** Sticky-note placeholders in the block `rect` (a heading band of `head` px above them). */
export function noteTiles(rect: Rect, count: number, head = 0): ShimmerPlan {
  const n = clampCount(count)
  const cols = Math.max(1, noteColumns(n))
  const rows = Math.ceil(n / cols)
  const top = rect.y + head
  const cw = (rect.w - GAP * (cols - 1)) / cols
  const ch = (rect.h - head - GAP * (rows - 1)) / rows
  const size = Math.max(24, Math.min(cw, ch))
  const tiles: ShimmerTile[] = Array.from({ length: n }, (_, i) => ({
    x: rect.x + (i % cols) * (size + GAP),
    y: top + Math.floor(i / cols) * (size + GAP),
    w: size,
    h: size,
    shape: 'note',
  }))
  return { rect, tiles }
}

/** A column of `count` topic pills at `rect` (the sub-topics of Expand with AI). */
export function pillTiles(rect: Rect, count: number): ShimmerPlan {
  const n = clampCount(count)
  const h = Math.max(20, (rect.h - GAP * (n - 1)) / n)
  return {
    rect,
    tiles: Array.from({ length: n }, (_, i) => ({
      x: rect.x,
      y: rect.y + i * (h + GAP),
      w: rect.w,
      h,
      shape: 'pill',
    })),
  }
}

/** A new mind map: a hub in the middle of `rect` and `count` pills on its two sides. */
export function mapTiles(rect: Rect, count: number): ShimmerPlan {
  const n = clampCount(count)
  const right = Math.ceil(n / 2)
  const left = n - right
  const hubW = Math.min(rect.w / 3, 220)
  const pillW = Math.max(60, (rect.w - hubW - 2 * 60) / 2)
  const hub: ShimmerTile = {
    x: rect.x + (rect.w - hubW) / 2,
    y: rect.y + rect.h / 2 - 32,
    w: hubW,
    h: 64,
    shape: 'hub',
  }
  const column = (count: number, x: number): ShimmerTile[] => {
    if (!count) return []
    const h = Math.max(20, Math.min(48, (rect.h - GAP * (count - 1)) / count))
    const total = count * h + GAP * (count - 1)
    return Array.from({ length: count }, (_, i) => ({
      x,
      y: rect.y + (rect.h - total) / 2 + i * (h + GAP),
      w: pillW,
      h,
      shape: 'pill' as const,
    }))
  }
  return {
    rect,
    tiles: [hub, ...column(right, rect.x + rect.w - pillW), ...column(left, rect.x)],
  }
}

/** One soft block over `rect` (notes that are about to be regrouped). */
export function regionTile(rect: Rect): ShimmerPlan {
  return { rect, tiles: [{ ...rect, shape: 'region' }] }
}

/** A box in overlay pixels from scene corners (`toOverlay` is `LobbyCanvas.sceneToOverlay`). */
export function toPixels(
  tile: Rect,
  toOverlay: (p: { x: number; y: number }) => { x: number; y: number },
): Rect {
  const a = toOverlay({ x: tile.x, y: tile.y })
  const b = toOverlay({ x: tile.x + tile.w, y: tile.y + tile.h })
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.round(Math.abs(b.x - a.x)),
    h: Math.round(Math.abs(b.y - a.y)),
  }
}

/** Whether a box has any part on a screen of `w` by `h` px. */
export const onScreen = (r: Rect, w: number, h: number) =>
  r.x < w && r.y < h && r.x + r.w > 0 && r.y + r.h > 0
