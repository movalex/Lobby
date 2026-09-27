// Pure placement logic (page coordinates): where a template or a pasted grid of notes lands.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return minX === Number.POSITIVE_INFINITY ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export interface EmptySpotOptions {
  /** Clearance kept from existing content (page units). Default 80. */
  gap?: number
  /** Search grid step. Default max(120, max(w, h) / 4). */
  step?: number
  /** Rings of candidates tried around the target. Default 14. */
  maxRings?: number
}

/**
 * Top-left for a `size` box, as close as possible to `center`, that keeps `gap` clear of every
 * obstacle. Tries the exact centre first, then a grid of candidates ordered by distance (ties prefer
 * right, then below). When nothing nearby is free (dense boards), it goes just right of all content,
 * which is empty by construction. Never returns a spot overlapping an obstacle.
 */
export function findEmptySpot(
  size: { w: number; h: number },
  center: Point,
  obstacles: readonly Rect[],
  opts: EmptySpotOptions = {},
): Point {
  const gap = opts.gap ?? 80
  const w = Math.max(1, size.w)
  const h = Math.max(1, size.h)
  const base = { x: center.x - w / 2, y: center.y - h / 2 }
  const valid = obstacles.filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite))
  const all = unionRects(valid)
  if (!all) return base

  const free = (p: Point) => {
    const box = { x: p.x, y: p.y, w, h }
    // Anything clear of the union of all content is trivially free.
    if (!rectsOverlap(box, all, gap)) return true
    for (const r of valid) if (rectsOverlap(box, r, gap)) return false
    return true
  }
  if (free(base)) return base

  const step = opts.step ?? Math.max(120, Math.max(w, h) / 4)
  const rings = opts.maxRings ?? 14
  const candidates: { p: Point; d: number; tie: number }[] = []
  for (let i = -rings; i <= rings; i++) {
    for (let j = -rings; j <= rings; j++) {
      if (i === 0 && j === 0) continue
      const dx = i * step
      const dy = j * step
      // Tie-break: prefer to the right (+x), then below (+y), matching reading direction.
      candidates.push({ p: { x: base.x + dx, y: base.y + dy }, d: dx * dx + dy * dy, tie: -i * 2 - j })
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.tie - b.tie)
  for (const c of candidates) if (free(c.p)) return c.p

  return { x: all.x + all.w + gap, y: Math.max(all.y, Math.min(base.y, all.y + all.h - h)) }
}

/** Offset that moves `bounds` so its centre sits on `center`. */
export function offsetToCenter(bounds: Rect, center: Point): Point {
  return { x: center.x - (bounds.x + bounds.w / 2), y: center.y - (bounds.y + bounds.h / 2) }
}

export interface FrameBox {
  id: string
  bounds: Rect
}

/** The smallest frame that fully contains `rect` (pasting into a frame), or null. */
export function containingFrame(rect: Rect, frames: readonly FrameBox[]): FrameBox | null {
  let best: FrameBox | null = null
  for (const f of frames) {
    if (!rectContains(f.bounds, rect)) continue
    if (!best || f.bounds.w * f.bounds.h < best.bounds.w * best.bounds.h) best = f
  }
  return best
}
