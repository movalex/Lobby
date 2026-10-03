/**
 * W5-32: edge markers for the collaborators who are off screen. The geometry only (pure, Node-tested): which
 * people get a marker, where it sits on the canvas's edge and which way it points. The overlay
 * (chrome.tsx `EdgeMarkers`) draws it; nothing here reads the canvas or writes anything.
 *
 * A person gets a marker when the place they work is outside this view: their pointer when they have one on
 * the board, else the middle of their view when that view does not overlap this one (a person whose pointer
 * is off the canvas but whose view shows the same area is "here"). The marker sits on the line from the middle
 * of the canvas to that place, pushed in from the edge by `chipRadius + margin` so the whole chip is on the
 * canvas, with the arrow end of it facing the person. At most `max` markers (the nearest people win). A chip
 * never sits under one of the board's own controls (`avoid`: the board menu, the style panel, the navigation
 * panel, the floating selection bar, the phone sheet's button and its open sheet: `floatingCovers` reads the
 * last two off the page) and chips that would land on one another are spread apart along the whole edge,
 * corners included (`place`).
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
  /**
   * the side of the canvas the person is on (the ray's: what the chip's label says). The chip itself may sit on the
   * next edge round a corner when a control or another chip was in its place.
   */
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
  /** what the board's own controls cover (the board menu in the top left corner, the style panel, the navigation panel) */
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
  return place(out, box, r, opts.avoid ?? [])
}

/** A stretch of the chip box's edge loop (see `place`), start to end. */
interface Span {
  readonly from: number
  readonly to: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Where the chips end up. The edge of the chips' box is one loop (clockwise from its top left corner: the top,
 * the right, the bottom, the left) and a chip is a place on it. Two things move a chip along that loop:
 *  - a stretch of it under one of `avoid` is closed, so a chip that would sit there moves to the nearest open
 *    place, whichever way that is (a control in a corner closes both of its edges; the style panel at the top
 *    right closes the top edge's end and the right edge down to its foot, so the chip goes to the foot);
 *  - chips closer than a chip's width along the open stretches are pushed apart, in order, so two people in the
 *    same corner's direction (one chip on the left edge, one on the top) do not land on one another either.
 * Around a corner the chips are `gap` apart along the loop, which is at least gap / sqrt(2) in a straight
 * line: their faces never touch.
 */
function place(
  markers: EdgeMarker[],
  box: { left: number; right: number; top: number; bottom: number },
  r: number,
  avoid: readonly AvoidRect[],
): EdgeMarker[] {
  const bw = box.right - box.left
  const bh = box.bottom - box.top
  const total = 2 * (bw + bh)
  if (!(total > 0) || markers.length === 0) return markers
  const gap = 2 * r + 4
  const start = { top: 0, right: bw, bottom: bw + bh, left: 2 * bw + bh }
  const arcOf = (mk: EdgeMarker): number => {
    switch (mk.side) {
      case 'top':
        return start.top + clamp(mk.x - box.left, 0, bw)
      case 'right':
        return start.right + clamp(mk.y - box.top, 0, bh)
      case 'bottom':
        return start.bottom + clamp(box.right - mk.x, 0, bw)
      case 'left':
        return start.left + clamp(box.bottom - mk.y, 0, bh)
    }
  }
  const pointAt = (s: number): { x: number; y: number } => {
    const t = ((s % total) + total) % total
    if (t <= start.right) return { x: box.left + t, y: box.top }
    if (t <= start.bottom) return { x: box.right, y: box.top + (t - start.right) }
    if (t <= start.left) return { x: box.right - (t - start.bottom), y: box.bottom }
    return { x: box.left, y: box.bottom - (t - start.left) }
  }

  // the closed stretches: where a chip (a circle of radius r) would touch a control
  const closed: Span[] = []
  const close = (from: number, to: number) => {
    if (to > from) closed.push({ from, to })
  }
  for (const a of avoid) {
    const x0 = a.x - r
    const x1 = a.x + a.w + r
    const y0 = a.y - r
    const y1 = a.y + a.h + r
    if (y0 < box.top && box.top < y1)
      close(start.top + clamp(x0 - box.left, 0, bw), start.top + clamp(x1 - box.left, 0, bw))
    if (x0 < box.right && box.right < x1)
      close(start.right + clamp(y0 - box.top, 0, bh), start.right + clamp(y1 - box.top, 0, bh))
    if (y0 < box.bottom && box.bottom < y1)
      close(start.bottom + clamp(box.right - x1, 0, bw), start.bottom + clamp(box.right - x0, 0, bw))
    if (x0 < box.left && box.left < x1)
      close(start.left + clamp(box.bottom - y1, 0, bh), start.left + clamp(box.bottom - y0, 0, bh))
  }
  closed.sort((a, b) => a.from - b.from)
  // the open stretches: what the closed ones leave (touching closed stretches are one)
  let open: Span[] = []
  let at = 0
  for (const c of closed) {
    if (c.from > at) open.push({ from: at, to: c.from })
    at = Math.max(at, c.to)
  }
  if (at < total) open.push({ from: at, to: total })
  // everything covered: the controls win nothing, the chips keep to the loop as it is
  if (open.length === 0) open = [{ from: 0, to: total }]

  // the open stretches laid end to end are a circle of `loop` length (what the chips are spread on)
  let loop = 0
  const laid = open.map((o) => {
    const l = { ...o, offset: loop }
    loop += o.to - o.from
    return l
  })
  /**
   * The nearest open place to `s` on the loop (the way round the seam at the top left counts), as a place on the
   * circle and the open stretch it is in (two stretches meet on the circle where a closed one was cut out, and
   * the end of one is not the start of the next on the loop).
   */
  const snap = (s: number): { c: number; seg: number } => {
    let best = Number.POSITIVE_INFINITY
    let found = { c: 0, seg: 0 }
    laid.forEach((o, seg) => {
      for (const shift of [0, total, -total]) {
        const want = s + shift
        const got = clamp(want, o.from, o.to)
        const d = Math.abs(got - want)
        if (d < best - 1e-9) {
          best = d
          found = { c: o.offset + (got - o.from), seg }
        }
      }
    })
    return found
  }
  /** A place on the circle back to a place on the loop; `seg` is the stretch the chip started in, kept while it is still in it. */
  const unsnap = (c: number, seg: number): number => {
    const own = laid[seg]
    if (own && c >= own.offset - 1e-9 && c <= own.offset + (own.to - own.from) + 1e-9)
      return own.from + clamp(c - own.offset, 0, own.to - own.from)
    for (const o of laid)
      if (c <= o.offset + (o.to - o.from) + 1e-9) return o.from + Math.max(0, c - o.offset)
    const last = laid[laid.length - 1]
    return last ? last.to : 0
  }

  const items = markers
    .map((mk) => ({ mk, ...snap(arcOf(mk)) }))
    .sort((a, b) => a.c - b.c || (a.mk.sid < b.mk.sid ? -1 : a.mk.sid > b.mk.sid ? 1 : 0))
  const n = items.length
  // cut the circle where it is emptiest, so a cluster is spread along a line and never has to wrap
  let cut = 0
  let widest = -1
  for (let i = 0; i < n; i++) {
    const next = items[(i + 1) % n] as { c: number }
    const g = (next.c - (items[i] as { c: number }).c + loop) % loop || (n === 1 ? loop : 0)
    if (g > widest) {
      widest = g
      cut = (i + 1) % n
    }
  }
  const order = [...items.slice(cut), ...items.slice(0, cut)]
  const base = (order[0] as { c: number }).c
  const u = order.map((it) => (it.c - base + loop) % loop)
  // forward: nobody closer than `gap` to the one before
  for (let i = 1; i < n; i++) u[i] = Math.max(u[i] as number, (u[i - 1] as number) + gap)
  // backward: what ran on towards the first chip again is pulled back, pushing the ones before it
  if ((u[n - 1] as number) > loop - gap) {
    u[n - 1] = loop - gap
    for (let i = n - 2; i >= 0; i--) u[i] = Math.min(u[i] as number, (u[i + 1] as number) - gap)
  }
  // (more chips than the loop has room for: the first ones pile up at its start)
  for (let i = 0; i < n; i++) u[i] = Math.max(0, u[i] as number)

  const moved = new Map<string, { x: number; y: number }>()
  order.forEach(({ mk, seg }, i) => {
    const at = base + (u[i] as number)
    const p = pointAt(unsnap(at > loop ? at - loop : at, seg))
    if (Math.abs(p.x - mk.x) > 1e-6 || Math.abs(p.y - mk.y) > 1e-6) moved.set(mk.sid, p)
  })
  return markers.map((mk) => {
    const p = moved.get(mk.sid)
    return p ? { ...mk, x: p.x, y: p.y } : mk
  })
}

/**
 * One element of a host slot that floats over the canvas, as chrome.tsx measures it (client px) for
 * `floatingCovers`. Kept a plain shape so the walk below runs in Node tests.
 */
export interface CoverNode {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** `display: none` or `visibility: hidden`: nothing of it, or inside it, is on screen */
  readonly hidden: boolean
  /** `position: absolute` or `fixed`: a box put where it is wanted over the canvas, whatever it sits in */
  readonly floating: boolean
  readonly children: readonly CoverNode[]
}

/** The least a floating box measures, each way, to cover chips (a visually hidden live region does not). */
export const MIN_COVER_PX = 8

/**
 * What the layer slots of the board page cover (the floating selection bar, the phone sheet's button and its
 * open sheet, which a slot's own box does not say: they are full-size or zero-height strips with a box put
 * somewhere inside), as rectangles for `edgeMarkers`' `avoid`, relative to `origin` (the overlay's corner in
 * client px). Every visible floating box of at least `MIN_COVER_PX` counts, wherever it sits in the tree
 * (a popover inside the bar counts too); a container that is not itself a box on the canvas is looked
 * through. Pure.
 */
export function floatingCovers(nodes: readonly CoverNode[], origin: ScreenPoint): AvoidRect[] {
  const out: AvoidRect[] = []
  const walk = (list: readonly CoverNode[]) => {
    for (const n of list) {
      if (n.hidden) continue
      if (n.floating && Number.isFinite(n.x + n.y + n.w + n.h) && n.w >= MIN_COVER_PX && n.h >= MIN_COVER_PX)
        out.push({ x: n.x - origin.x, y: n.y - origin.y, w: n.w, h: n.h })
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}
