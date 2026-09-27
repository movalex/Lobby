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

/**
 * Like findEmptySpot, but the box must also lie inside `within` (a frame's inner area): the free spot
 * inside it nearest `center` (clamped into it first), or null when there is none. Candidates are a
 * finer grid than findEmptySpot's, covering the whole of `within`.
 */
export function findEmptySpotWithin(
  size: { w: number; h: number },
  center: Point,
  obstacles: readonly Rect[],
  within: Rect,
  opts: EmptySpotOptions = {},
): Point | null {
  const gap = opts.gap ?? 40
  const w = Math.max(1, size.w)
  const h = Math.max(1, size.h)
  if (w > within.w || h > within.h) return null
  const clampX = (x: number) => Math.min(Math.max(x, within.x), within.x + within.w - w)
  const clampY = (y: number) => Math.min(Math.max(y, within.y), within.y + within.h - h)
  const base = { x: clampX(center.x - w / 2), y: clampY(center.y - h / 2) }
  const valid = obstacles.filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite))
  const free = (p: Point) => {
    const box = { x: p.x, y: p.y, w, h }
    for (const r of valid) if (rectsOverlap(box, r, gap)) return false
    return true
  }
  if (free(base)) return base
  const step = opts.step ?? Math.max(20, Math.min(w, h) / 8)
  const rings = opts.maxRings ?? Math.min(120, Math.ceil(Math.max(within.w, within.h) / step))
  const seen = new Set<string>()
  const candidates: { p: Point; d: number; tie: number }[] = []
  for (let i = -rings; i <= rings; i++) {
    for (let j = -rings; j <= rings; j++) {
      const p = { x: clampX(base.x + i * step), y: clampY(base.y + j * step) }
      const key = `${p.x},${p.y}`
      if (seen.has(key)) continue
      seen.add(key)
      const dx = p.x - base.x
      const dy = p.y - base.y
      // Same tie-break as findEmptySpot: prefer to the right, then below.
      candidates.push({ p, d: dx * dx + dy * dy, tie: -Math.sign(dx) * 2 - Math.sign(dy) })
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.tie - b.tie)
  for (const c of candidates) if (free(c.p)) return c.p
  return null
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

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * PRI-10: the camera (tldraw: screen = (page + camera) * z, relative to the editor) that shows a whole
 * frame AND its heading, which tldraw draws above the frame at a constant screen height, inside the
 * part of the viewport the UI does not cover (`insets`: the menu and page bar, the bottom toolbar, an
 * open dock panel), `pad` clear of it, never zoomed in past `maxZoom` (100%).
 */
export function frameCamera(
  bounds: Rect,
  viewport: { w: number; h: number },
  insets: Insets,
  opts: { heading?: number; pad?: number; minZoom?: number; maxZoom?: number } = {},
): { x: number; y: number; z: number } | null {
  const heading = opts.heading ?? 32
  const pad = opts.pad ?? 24
  const minZoom = opts.minZoom ?? 0.05
  const maxZoom = opts.maxZoom ?? 1
  if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0)
    return null
  const freeW = viewport.w - insets.left - insets.right - pad * 2
  const freeH = viewport.h - insets.top - insets.bottom - pad * 2 - heading
  if (freeW < 40 || freeH < 40) return null
  const z = Math.max(minZoom, Math.min(maxZoom, freeW / bounds.w, freeH / bounds.h))
  // Centre of the free area; the heading sits above the frame, so the frame's centre is half a heading lower.
  const sx = insets.left + pad + freeW / 2
  const sy = insets.top + pad + heading + freeH / 2
  return { x: sx / z - (bounds.x + bounds.w / 2), y: sy / z - (bounds.y + bounds.h / 2), z }
}
