/**
 * W5-32: edge markers for the collaborators who are off screen. The geometry only (pure, Node-tested): which
 * people get a marker, where it sits on the canvas's edge and which way it points. The overlay
 * (chrome.tsx `EdgeMarkers`) draws it; nothing here reads the canvas or writes anything.
 *
 * A person gets a marker when the place they work is outside this view: their pointer when they have one on
 * the board, else the middle of their view when that view does not overlap this one (a person whose pointer
 * is off the canvas but whose view shows the same area is "here"). The marker sits on the line from the middle
 * of the canvas to that place, pushed in from the edge by `chipRadius + margin` so the whole chip is on the
 * canvas, with the arrow end of it facing the person. At most `max` markers (the nearest people win), and
 * chips that would land on one another along an edge are spread apart.
 */
import type { Bounds, ScenePoint, ScreenPoint } from '../api/lobby-canvas.ts'

/** Most markers drawn at once (a 40-person board would be a wall of chips otherwise). */
export const MAX_EDGE_MARKERS = 10
/** Half the width of a chip, arrow included, in screen px. */
export const EDGE_CHIP_RADIUS = 20
/** Free space between a chip and the canvas's edge, per side, in screen px. */
export const EDGE_MARGINS = {
  left: 10,
  right: 10,
  top: 10,
  // the toolbar (a 48 px row, 12 px up, centred) is above the overlay in z-order and takes clicks
  bottom: 72,
} as const

export interface EdgeMarkerPeer {
  readonly sid: string
  /** where their pointer is on the board (scene), or null */
  readonly point: ScenePoint | null
  /** their visible scene rectangle, or null */
  readonly view: Bounds | null
}

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom'

export interface EdgeMarker {
  readonly sid: string
  /** the chip's centre in overlay px */
  readonly x: number
  readonly y: number
  /** the direction of the person from the middle of the canvas, radians (0 points right, π/2 down) */
  readonly angle: number
  /** the side of the canvas the chip sits on */
  readonly side: EdgeSide
  /** the scene point to go to (their pointer, else the middle of their view) */
  readonly target: ScenePoint
}

/** A rectangle of the canvas that other controls cover (overlay px): a chip never sits under it. */
export interface AvoidRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface EdgeMarkerOptions {
  /** what the board's own controls cover (the board menu in the top left corner) */
  readonly avoid?: readonly AvoidRect[]
  readonly max?: number
  readonly chipRadius?: number
  readonly margins?: {
    readonly left: number
    readonly right: number
    readonly top: number
    readonly bottom: number
  }
}

const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * The markers for `peers` on a canvas of `size` px. `toOverlay` maps a scene point to overlay px (the canvas's
 * `sceneToOverlay`), `viewport` is the visible scene rectangle (the camera). Empty when the canvas has no
 * size yet.
 */
export function edgeMarkers(
  peers: readonly EdgeMarkerPeer[],
  viewport: Bounds,
  size: { readonly w: number; readonly h: number },
  toOverlay: (p: ScenePoint) => ScreenPoint,
  opts: EdgeMarkerOptions = {},
): EdgeMarker[] {
  const { w, h } = size
  if (!(w > 0) || !(h > 0)) return []
  const max = opts.max ?? MAX_EDGE_MARKERS
  const r = opts.chipRadius ?? EDGE_CHIP_RADIUS
  const m = opts.margins ?? EDGE_MARGINS
  // where a chip's centre may be; a canvas too small for that gets its middle
  const wide = w - m.left - m.right - 2 * r >= 0
  const tall = h - m.top - m.bottom - 2 * r >= 0
  const box = {
    left: wide ? m.left + r : w / 2,
    right: wide ? w - m.right - r : w / 2,
    top: tall ? m.top + r : h / 2,
    bottom: tall ? h - m.bottom - r : h / 2,
  }
  const cx = (box.left + box.right) / 2
  const cy = (box.top + box.bottom) / 2

  const found: { sid: string; target: ScenePoint; at: ScreenPoint; dist: number }[] = []
  for (const p of peers) {
    let target: ScenePoint | null = null
    if (p.point) {
      const at = toOverlay(p.point)
      if (at.x < 0 || at.x > w || at.y < 0 || at.y > h) target = p.point
    } else if (p.view && !overlaps(p.view, viewport)) {
      target = { x: p.view.x + p.view.width / 2, y: p.view.y + p.view.height / 2 }
    }
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) continue
    const at = toOverlay(target)
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue
    found.push({ sid: p.sid, target, at, dist: Math.hypot(at.x - w / 2, at.y - h / 2) })
  }
  found.sort((a, b) => a.dist - b.dist || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))

  const out: EdgeMarker[] = found.slice(0, max).map((f) => {
    const dx = f.at.x - cx
    const dy = f.at.y - cy
    // how far along the direction the chip box's edge is, per axis; the nearer one is where the ray leaves it
    const tx = dx === 0 ? Number.POSITIVE_INFINITY : (dx > 0 ? box.right - cx : box.left - cx) / dx
    const ty = dy === 0 ? Number.POSITIVE_INFINITY : (dy > 0 ? box.bottom - cy : box.top - cy) / dy
    const t = Math.min(tx, ty)
    const side: EdgeSide = tx <= ty ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top'
    return {
      sid: f.sid,
      x: cx + dx * t,
      y: cy + dy * t,
      angle: Math.atan2(dy, dx),
      side,
      target: f.target,
    }
  })
  return spread(out, box, r, opts.avoid ?? [])
}

/**
 * Chips on one side that would overlap are spread along it (in order, clamped to the side's length), and a chip
 * that would sit under one of `avoid` moves on along its side, past it.
 */
function spread(
  markers: EdgeMarker[],
  box: { left: number; right: number; top: number; bottom: number },
  r: number,
  avoid: readonly AvoidRect[],
): EdgeMarker[] {
  const gap = 2 * r + 4
  const moved = new Map<string, { x: number; y: number }>()
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const onSide = markers.filter((mk) => mk.side === side)
    if (onSide.length === 0) continue
    const horizontal = side === 'top' || side === 'bottom'
    const lo = horizontal ? box.left : box.top
    const hi = horizontal ? box.right : box.bottom
    // where each chip would sit along the side; one under a control moves on, past it
    const placed = onSide.map((mk) => {
      let p = horizontal ? mk.x : mk.y
      // the side's fixed coordinate is the chip's other one
      const fixed = horizontal ? mk.y : mk.x
      for (const a of avoid) {
        const hits = horizontal
          ? p - r < a.x + a.w && p + r > a.x && fixed - r < a.y + a.h && fixed + r > a.y
          : p - r < a.y + a.h && p + r > a.y && fixed - r < a.x + a.w && fixed + r > a.x
        if (hits) p = horizontal ? a.x + a.w + r : a.y + a.h + r
      }
      return { mk, p }
    })
    placed.sort((a, b) => a.p - b.p || (a.mk.sid < b.mk.sid ? -1 : 1))
    const pos = placed.map((x) => x.p)
    // forward: nobody closer than `gap` to the one before
    for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i] as number, (pos[i - 1] as number) + gap)
    // backward: what ran past the end is pulled back, pushing the ones before it
    const last = pos.length - 1
    if ((pos[last] as number) > hi) {
      pos[last] = hi
      for (let i = last - 1; i >= 0; i--) pos[i] = Math.min(pos[i] as number, (pos[i + 1] as number) - gap)
    }
    // (more chips than fit: the first ones pile up at the start of the side)
    for (let i = 0; i < pos.length; i++) pos[i] = Math.max(lo, pos[i] as number)
    placed.forEach(({ mk }, i) => {
      moved.set(mk.sid, horizontal ? { x: pos[i] as number, y: mk.y } : { x: mk.x, y: pos[i] as number })
    })
  }
  return markers.map((mk) => {
    const at = moved.get(mk.sid)
    return at ? { ...mk, x: at.x, y: at.y } : mk
  })
}
