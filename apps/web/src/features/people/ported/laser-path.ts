// OWNER: W6 (wave L, L6-1). The shape of another session's laser on screen, pure (Node-tested): its samples
// (scene points stamped when this tab got them, `canvas.presence.lasers()`) become a tapered SVG path in
// overlay pixels, smoothed with a Catmull-Rom spline, widest at the newest sample and thinning to nothing as a
// sample gets older, so the trail fades over LASER_FADE_MS. Under reduced motion only the dot where the laser
// points is drawn.

/** How long a sample stays on the trail (ms); matches the canvas's LASER_TRAIL_MS. */
export const LASER_FADE_MS = 1_000
/** The trail's width at its newest sample, overlay px. */
export const LASER_WIDTH_PX = 6
/** The dot's radius at the newest sample, overlay px. */
export const LASER_DOT_PX = 4
/** Points the spline adds between two samples. */
const SUBDIVISIONS = 4

export interface ShapePoint {
  readonly x: number
  readonly y: number
}

export interface TimedPoint extends ShapePoint {
  /** when the sample came (ms, the same clock as `now`) */
  readonly at: number
}

export interface LaserShape {
  /** the tapered outline (`d` of one filled path), or null when there is no line yet (one sample) */
  readonly d: string | null
  /** the newest sample, overlay px */
  readonly head: ShapePoint
  /** the samples it was drawn from */
  readonly samples: number
}

interface Wide extends ShapePoint {
  readonly w: number
}

/** A uniform Catmull-Rom spline through `pts` (ends doubled), `n` steps per span; widths interpolated. */
export function catmullRom(pts: readonly Wide[], n = SUBDIVISIONS): Wide[] {
  if (pts.length < 3) return [...pts]
  const out: Wide[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)] as Wide
    const p1 = pts[i] as Wide
    const p2 = pts[i + 1] as Wide
    const p3 = pts[Math.min(pts.length - 1, i + 2)] as Wide
    for (let s = 0; s < n; s++) {
      const t = s / n
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), w: p1.w + (p2.w - p1.w) * t })
    }
  }
  out.push(pts[pts.length - 1] as Wide)
  return out
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString()

/** The filled outline of a line of varying width: one side forward, the other back. */
export function taperedOutline(line: readonly Wide[]): string | null {
  if (line.length < 2) return null
  const left: string[] = []
  const right: string[] = []
  for (let i = 0; i < line.length; i++) {
    const p = line[i] as Wide
    const a = line[Math.max(0, i - 1)] as Wide
    const b = line[Math.min(line.length - 1, i + 1)] as Wide
    let dx = b.x - a.x
    let dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) {
      dx = 1
      dy = 0
    } else {
      dx /= len
      dy /= len
    }
    const h = p.w / 2
    left.push(`${fmt(p.x - dy * h)} ${fmt(p.y + dx * h)}`)
    right.push(`${fmt(p.x + dy * h)} ${fmt(p.y - dx * h)}`)
  }
  return `M${left.join(' L')} L${right.reverse().join(' L')} Z`
}

/**
 * The laser as drawn at `now`: the samples younger than LASER_FADE_MS (`keepNewest`: the newest one stays,
 * a pressed laser's dot), mapped to overlay px with `toOverlay`, the trail's width growing from the oldest
 * sample to the newest and shrinking with age. Null when nothing is left to draw.
 */
export function laserShape(
  samples: readonly TimedPoint[],
  now: number,
  toOverlay: (p: ShapePoint) => ShapePoint,
  opts: { keepNewest?: boolean; widthPx?: number } = {},
): LaserShape | null {
  const width = opts.widthPx ?? LASER_WIDTH_PX
  const live = samples.filter(
    (s, i) => now - s.at <= LASER_FADE_MS || (opts.keepNewest && i === samples.length - 1),
  )
  if (!live.length) return null
  const pts: Wide[] = live.map((s, i) => {
    const p = toOverlay(s)
    const age = Math.min(1, Math.max(0, (now - s.at) / LASER_FADE_MS))
    // the tail is thin, and every sample thins as it ages
    const along = live.length > 1 ? i / (live.length - 1) : 1
    return { x: p.x, y: p.y, w: width * (0.25 + 0.75 * along) * (1 - age) }
  })
  const head = pts[pts.length - 1] as Wide
  return {
    d: pts.length > 1 ? taperedOutline(catmullRom(pts)) : null,
    head: { x: head.x, y: head.y },
    samples: live.length,
  }
}
