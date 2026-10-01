/**
 * tldraw 5.4.2's geo shapes as the converter builds them on Excalidraw (docs/EXCALIDRAW-MIGRATION.md §5.1
 * "geo other kinds", §5.2; decision D4 of docs/research/excalidraw/REVIEW-W5-EARLY.md §9: the extra geo
 * shapes are built as polygons, not dropped). 2B.
 *
 * Every one of tldraw's 20 kinds has a build (GEO_SHAPES):
 *  - native (rectangle, ellipse, diamond): Excalidraw's own type; `oval` is drawn as an ellipse
 *    (`geo-approximated`: tldraw's is a stadium; the native type keeps Excalidraw's own arrow binding);
 *  - native with marks (check-box, x-box): the native rectangle, which holds the label and the arrow
 *    bindings, plus tldraw's check mark or cross as open `line`s grouped with it (`geo-polygon`; they were
 *    plain rectangles before, the mark dropped);
 *  - polygon (the other 14): a closed `line` (`polygon: true`) for the outline, grouped with a transparent
 *    rectangle that holds the label and the bindings (`geo-polygon`); the outline is tldraw's own geometry
 *    (getGeoShapePath.ts, @tldraw/editor getPolygonVertices), vertex for vertex for the straight-edged
 *    kinds; heart and cloud are tldraw's curves sampled (also `geo-approximated`), the cloud's bumps from
 *    tldraw's seeded wiggle (the shape id is the seed), so a converted cloud has tldraw's own bumps.
 *
 * Pure and deterministic; points are in the shape's local box (0..w, 0..h), before flips and the
 * transform (convert.ts applies both). No engine code.
 */
import { rng } from '@tldraw/utils'

/** tldraw 5.4.2 `GeoShapeGeoStyle` values. */
export const TL_GEO_KINDS = [
  'arrow-down',
  'arrow-left',
  'arrow-right',
  'arrow-up',
  'check-box',
  'cloud',
  'diamond',
  'ellipse',
  'heart',
  'hexagon',
  'octagon',
  'oval',
  'pentagon',
  'rectangle',
  'rhombus-2',
  'rhombus',
  'star',
  'trapezoid',
  'triangle',
  'x-box',
] as const
export type TlGeoKind = (typeof TL_GEO_KINDS)[number]

export type GeoBuild =
  | {
      readonly build: 'native'
      readonly type: 'rectangle' | 'ellipse' | 'diamond'
      /** the native type differs from tldraw's outline (oval) */
      readonly approximated: boolean
    }
  | { readonly build: 'native-marks'; readonly type: 'rectangle' }
  | {
      readonly build: 'polygon'
      /** tldraw's outline is a curve, sampled into the polygon (heart, cloud) */
      readonly curve: boolean
    }

const polygon = (curve = false): GeoBuild => ({ build: 'polygon', curve })

/** How each tldraw geo kind is built (the converter mapping of D4). */
export const GEO_SHAPES: Readonly<Record<TlGeoKind, GeoBuild>> = Object.freeze({
  rectangle: { build: 'native', type: 'rectangle', approximated: false },
  ellipse: { build: 'native', type: 'ellipse', approximated: false },
  diamond: { build: 'native', type: 'diamond', approximated: false },
  oval: { build: 'native', type: 'ellipse', approximated: true },
  'check-box': { build: 'native-marks', type: 'rectangle' },
  'x-box': { build: 'native-marks', type: 'rectangle' },
  triangle: polygon(),
  pentagon: polygon(),
  hexagon: polygon(),
  octagon: polygon(),
  star: polygon(),
  rhombus: polygon(),
  'rhombus-2': polygon(),
  trapezoid: polygon(),
  'arrow-left': polygon(),
  'arrow-right': polygon(),
  'arrow-up': polygon(),
  'arrow-down': polygon(),
  heart: polygon(true),
  cloud: polygon(true),
})

/** The build of a kind; an unknown kind (not tldraw 5.4.2's) is a rectangle, approximated. */
export function geoBuildOf(kind: string): GeoBuild {
  return (
    (GEO_SHAPES as Record<string, GeoBuild | undefined>)[kind] ?? {
      build: 'native',
      type: 'rectangle',
      approximated: true,
    }
  )
}

/** The lossy codes of a kind's build (§5.2). */
export function geoLossyCodes(kind: string): ('geo-polygon' | 'geo-approximated')[] {
  const b = geoBuildOf(kind)
  if (b.build === 'native') return b.approximated ? ['geo-approximated'] : []
  if (b.build === 'native-marks') return ['geo-polygon']
  return b.curve ? ['geo-polygon', 'geo-approximated'] : ['geo-polygon']
}

type P = [number, number]

/** What the cloud and the x-box read from the shape (tldraw takes them from the shape's props). */
export interface GeoOutlineOptions {
  /** the tldraw shape id: the cloud's random seed */
  readonly seed?: string
  /** `props.size` (s, m, l, xl) */
  readonly size?: string
  /** `props.scale` */
  readonly scale?: number
  /** `props.dash` */
  readonly dash?: string
  /** the stroke width as tldraw draws it (STROKE_SIZES[size] × scale) */
  readonly strokeWidth?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const HALF_PI = Math.PI / 2
const PI2 = Math.PI * 2

/** @tldraw/editor getPolygonVertices: a regular polygon scaled to fill the box. */
function polygonVertices(width: number, height: number, sides: number): P[] {
  const cx = width / 2
  const cy = height / 2
  const pts: P[] = []
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i < sides; i++) {
    const t = -HALF_PI + i * (PI2 / sides)
    const x = cx + cx * Math.cos(t)
    const y = cy + cy * Math.sin(t)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    pts.push([x, y])
  }
  const w = maxX - minX
  const h = maxY - minY
  if (width - w !== 0 || height - h !== 0)
    for (const p of pts) {
      p[0] = ((p[0] - minX) / w) * width
      p[1] = ((p[1] - minY) / h) * height
    }
  return pts
}

/** getGeoShapePath.ts getStarPath (5 points, ratio 1). */
function starVertices(w: number, h: number): P[] {
  const sides = 5
  const step = PI2 / sides / 2
  const rightMostIndex = Math.floor(sides / 4) * 2
  const leftMostIndex = sides * 2 - rightMostIndex
  const bottomMostIndex = Math.floor(sides / 2) * 2
  const maxX = (Math.cos(-HALF_PI + rightMostIndex * step) * w) / 2
  const minX = (Math.cos(-HALF_PI + leftMostIndex * step) * w) / 2
  const minY = (Math.sin(-HALF_PI) * h) / 2
  const maxY = (Math.sin(-HALF_PI + bottomMostIndex * step) * h) / 2
  const diffX = w - Math.abs(maxX - minX)
  const diffY = h - Math.abs(maxY - minY)
  const offsetX = w / 2 + minX - (w / 2 - maxX)
  const offsetY = h / 2 + minY - (h / 2 - maxY)
  const cx = (w - offsetX) / 2
  const cy = (h - offsetY) / 2
  const ox = (w + diffX) / 2
  const oy = (h + diffY) / 2
  const ix = ox / 2
  const iy = oy / 2
  return Array.from({ length: sides * 2 }, (_, i) => {
    const theta = -HALF_PI + i * step
    return [cx + (i % 2 ? ix : ox) * Math.cos(theta), cy + (i % 2 ? iy : oy) * Math.sin(theta)] as P
  })
}

/** A cubic Bézier from `a` sampled at `n` steps (the end point included, the start left out). */
function cubic(a: P, cp1: P, cp2: P, b: P, n: number): P[] {
  const out: P[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([
      u * u * u * a[0] + 3 * u * u * t * cp1[0] + 3 * u * t * t * cp2[0] + t * t * t * b[0],
      u * u * u * a[1] + 3 * u * u * t * cp1[1] + 3 * u * t * t * cp2[1] + t * t * t * b[1],
    ])
  }
  return out
}

/** Steps per curve segment when sampling (heart: 4 Béziers, cloud: one arc per bump). */
const HEART_STEPS = 8
const CLOUD_ARC_STEPS = 6

/** getGeoShapePath.ts heart (four cubic Béziers), sampled. */
function heartVertices(w: number, h: number): P[] {
  const cx = w / 2
  const o = w / 4
  const k = h / 4
  const start: P = [cx, h]
  const s1 = cubic(start, [o * 1.5, k * 3], [0, k * 2.5], [0, k * 1.2], HEART_STEPS)
  const s2 = cubic([0, k * 1.2], [0, -k * 0.32], [o * 1.85, -k * 0.32], [cx, k * 0.9], HEART_STEPS)
  const s3 = cubic([cx, k * 0.9], [o * 2.15, -k * 0.32], [w, -k * 0.32], [w, k * 1.2], HEART_STEPS)
  const s4 = cubic([w, k * 1.2], [w, k * 2.5], [o * 2.5, k * 3], start, HEART_STEPS)
  // the last sample is the start again: the caller closes the polygon
  return [start, ...s1, ...s2, ...s3, ...s4.slice(0, -1)]
}

const CLOUD_SIZES: Readonly<Record<string, number>> = { s: 50, m: 70, l: 100, xl: 130 }
const BUMP_PROTRUSION = 0.2

const ovalPerimeter = (h: number, w: number) =>
  h > w ? (Math.PI * (w / 2) + (h - w)) * 2 : (Math.PI * (h / 2) + (w - h)) * 2

/** getGeoShapePath.ts getPillPoints. */
function pillPoints(width: number, height: number, numPoints: number): P[] {
  const radius = Math.min(width, height) / 2
  const longSide = Math.max(width, height) - radius * 2
  const circumference = Math.PI * (radius * 2) + 2 * longSide
  const spacing = circumference / numPoints
  type Section = { type: 'straight'; start: P; delta: P } | { type: 'arc'; center: P; startAngle: number }
  const sections: Section[] =
    width > height
      ? [
          { type: 'straight', start: [radius, 0], delta: [1, 0] },
          { type: 'arc', center: [width - radius, radius], startAngle: -Math.PI / 2 },
          { type: 'straight', start: [width - radius, height], delta: [-1, 0] },
          { type: 'arc', center: [radius, radius], startAngle: Math.PI / 2 },
        ]
      : [
          { type: 'straight', start: [width, radius], delta: [0, 1] },
          { type: 'arc', center: [radius, height - radius], startAngle: 0 },
          { type: 'straight', start: [0, height - radius], delta: [0, -1] },
          { type: 'arc', center: [radius, radius], startAngle: Math.PI },
        ]
  let offset = 0
  const out: P[] = []
  for (let i = 0; i < numPoints; i++) {
    const s = sections[0] as Section
    if (s.type === 'straight') out.push([s.start[0] + s.delta[0] * offset, s.start[1] + s.delta[1] * offset])
    else {
      const a = s.startAngle + offset / radius
      out.push([s.center[0] + Math.cos(a) * radius, s.center[1] + Math.sin(a) * radius])
    }
    offset += spacing
    let len = s.type === 'straight' ? longSide : Math.PI * radius
    while (offset > len) {
      offset -= len
      sections.push(sections.shift() as Section)
      len = (sections[0] as Section).type === 'straight' ? longSide : Math.PI * radius
    }
  }
  return out
}

/** @tldraw/editor centerOfCircleFromThreePoints (null when collinear). */
function circleCenter(a: P, b: P, c: P): P | null {
  const u = -2 * (a[0] * (b[1] - c[1]) - a[1] * (b[0] - c[0]) + b[0] * c[1] - c[0] * b[1])
  const x =
    ((a[0] * a[0] + a[1] * a[1]) * (c[1] - b[1]) +
      (b[0] * b[0] + b[1] * b[1]) * (a[1] - c[1]) +
      (c[0] * c[0] + c[1] * c[1]) * (b[1] - a[1])) /
    u
  const y =
    ((a[0] * a[0] + a[1] * a[1]) * (b[0] - c[0]) +
      (b[0] * b[0] + b[1] * b[1]) * (c[0] - a[0]) +
      (c[0] * c[0] + c[1] * c[1]) * (a[0] - b[0])) /
    u
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * tldraw's PathBuilder.circularArcTo from `a` to `b` (SVG arc semantics: radius r, the small arc, sweep 1),
 * sampled on the circle at `n` steps (end included, start not). tldraw draws it as cubics within 0.03 px.
 */
function circularArc(a: P, b: P, radius: number, n: number): P[] {
  if (a[0] === b[0] && a[1] === b[1]) return []
  if (radius === 0) return [b]
  let r = Math.abs(radius)
  const x1p = (a[0] - b[0]) / 2
  const y1p = (a[1] - b[1]) / 2
  const lambda = (x1p * x1p) / (r * r) + (y1p * y1p) / (r * r)
  if (lambda > 1) r *= Math.sqrt(lambda)
  // largeArcFlag false, sweepFlag true: sign = 1
  const term = r * r * r * r - r * r * y1p * y1p - r * r * x1p * x1p
  const numerator = r * r * y1p * y1p + r * r * x1p * x1p
  const coef = Math.sqrt(Math.max(0, term / numerator))
  const cxp = coef * y1p
  const cyp = coef * -x1p
  const cx = cxp + (a[0] + b[0]) / 2
  const cy = cyp + (a[1] + b[1]) / 2
  const start = Math.atan2((y1p - cyp) / r, (x1p - cxp) / r)
  let end = Math.atan2((-y1p - cyp) / r, (-x1p - cxp) / r)
  if (end < start) end += PI2
  const out: P[] = []
  for (let i = 1; i <= n; i++) {
    const t = start + ((end - start) * i) / n
    out.push(i === n ? [b[0], b[1]] : [cx + r * Math.cos(t), cy + r * Math.sin(t)])
  }
  return out
}

/** getGeoShapePath.ts getCloudPath (tldraw's seeded wiggle; each bump's arc sampled). */
function cloudVertices(width: number, height: number, o: GeoOutlineOptions): P[] {
  const random = rng(o.seed ?? '')
  const scale = o.scale ?? 1
  const perimeter = ovalPerimeter(width, height)
  const numBumps = Math.max(
    Math.ceil(perimeter / (CLOUD_SIZES[o.size ?? 'm'] ?? 70)),
    6,
    Math.ceil(perimeter / Math.min(width, height)),
  )
  const targetBumpProtrusion = (perimeter / numBumps) * BUMP_PROTRUSION
  const innerWidth = Math.max(width - targetBumpProtrusion * 2, 1)
  const innerHeight = Math.max(height - targetBumpProtrusion * 2, 1)
  const innerPerimeter = ovalPerimeter(innerWidth, innerHeight)
  const between = innerPerimeter / numBumps
  const paddingX = (width - innerWidth) / 2
  const paddingY = (height - innerHeight) / 2
  const bumps = pillPoints(innerWidth, innerHeight, numBumps).map(
    ([x, y]) => [x + paddingX, y + paddingY] as P,
  )
  const maxWiggleX = width < 20 ? 0 : targetBumpProtrusion * 0.3
  const maxWiggleY = height < 20 ? 0 : targetBumpProtrusion * 0.3
  const wiggled = bumps.map((p) => [p[0], p[1]] as P)
  for (let i = 0; i < Math.floor(numBumps / 2); i++) {
    const a = wiggled[i] as P
    wiggled[i] = [a[0] + random() * maxWiggleX * scale, a[1] + random() * maxWiggleY * scale]
    const j = numBumps - i - 1
    const b = wiggled[j] as P
    wiggled[j] = [b[0] + random() * maxWiggleX * scale, b[1] + random() * maxWiggleY * scale]
  }
  const out: P[] = [wiggled[0] as P]
  for (let i = 0; i < wiggled.length; i++) {
    const j = i === wiggled.length - 1 ? 0 : i + 1
    const lw = wiggled[i] as P
    const rw = wiggled[j] as P
    const lp = bumps[i] as P
    const rp = bumps[j] as P
    const original = dist(lp, rp)
    const curvatureOffset = between - original
    const relativeSize = dist(lw, rw) / original
    const finalDistance = (Math.max(paddingX, paddingY) + curvatureOffset) * relativeSize
    // Vec.Sub(right, left).uni().per() = (dy, -dx) / |d|
    const dx = rp[0] - lp[0]
    const dy = rp[1] - lp[1]
    const len = Math.hypot(dx, dy) || 1
    const apex: P = [
      clamp((lp[0] + rp[0]) / 2 + (dy / len) * finalDistance, 0, width),
      clamp((lp[1] + rp[1]) / 2 + (-dx / len) * finalDistance, 0, height),
    ]
    const center = circleCenter(lw, rw, apex)
    const radius = dist(center ?? [(lw[0] + rw[0]) / 2, (lw[1] + rw[1]) / 2], lw)
    out.push(...circularArc(lw, rw, radius, CLOUD_ARC_STEPS))
  }
  // the last arc ends on the first point: the caller closes the polygon
  return out.slice(0, -1)
}

/**
 * The closed outline of a polygon kind (GEO_SHAPES `polygon`), in the shape's box, first point repeated at
 * the end. Any other kind: its bounding rectangle.
 */
export function geoOutline(kind: string, w: number, h: number, o: GeoOutlineOptions = {}): P[] {
  let pts: P[]
  const off = Math.min(w * 0.38, h * 0.38)
  switch (kind) {
    case 'triangle':
      pts = [
        [w / 2, 0],
        [w, h],
        [0, h],
      ]
      break
    case 'pentagon':
      pts = polygonVertices(w, h, 5)
      break
    case 'hexagon':
      pts = polygonVertices(w, h, 6)
      break
    case 'octagon':
      pts = polygonVertices(w, h, 8)
      break
    case 'star':
      pts = starVertices(w, h)
      break
    case 'rhombus':
      pts = [
        [off, 0],
        [w, 0],
        [w - off, h],
        [0, h],
      ]
      break
    case 'rhombus-2':
      pts = [
        [0, 0],
        [w - off, 0],
        [w, h],
        [off, h],
      ]
      break
    case 'trapezoid':
      pts = [
        [off, 0],
        [w - off, 0],
        [w, h],
        [0, h],
      ]
      break
    case 'arrow-left': {
      const ox = Math.min(w, h) * 0.38
      const oy = h * 0.16
      pts = [
        [ox, 0],
        [ox, oy],
        [w, oy],
        [w, h - oy],
        [ox, h - oy],
        [ox, h],
        [0, h / 2],
      ]
      break
    }
    case 'arrow-right': {
      const ox = Math.min(w, h) * 0.38
      const oy = h * 0.16
      pts = [
        [0, oy],
        [w - ox, oy],
        [w - ox, 0],
        [w, h / 2],
        [w - ox, h],
        [w - ox, h - oy],
        [0, h - oy],
      ]
      break
    }
    case 'arrow-up': {
      const ox = w * 0.16
      const oy = Math.min(w, h) * 0.38
      pts = [
        [w / 2, 0],
        [w, oy],
        [w - ox, oy],
        [w - ox, h],
        [ox, h],
        [ox, oy],
        [0, oy],
      ]
      break
    }
    case 'arrow-down': {
      const ox = w * 0.16
      const oy = Math.min(w, h) * 0.38
      pts = [
        [ox, 0],
        [w - ox, 0],
        [w - ox, h - oy],
        [w, h - oy],
        [w / 2, h],
        [0, h - oy],
        [ox, h - oy],
      ]
      break
    }
    case 'heart':
      pts = heartVertices(w, h)
      break
    case 'cloud':
      pts = cloudVertices(w, h, o)
      break
    default:
      pts = [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ]
  }
  const first = pts[0] as P
  return [...pts, [first[0], first[1]]]
}

/**
 * The marks of a `native-marks` kind, as open polylines in the shape's box: check-box's check, x-box's
 * two diagonals (inset by 0.62 × the stroke width for the `draw` dash, as tldraw draws them). Empty for
 * every other kind.
 */
export function geoMarks(kind: string, w: number, h: number, o: GeoOutlineOptions = {}): P[][] {
  if (kind === 'check-box') {
    const size = Math.min(w, h) * 0.82
    const ox = (w - size) / 2
    const oy = (h - size) / 2
    return [
      [
        [clamp(ox + size * 0.25, 0, w), clamp(oy + size * 0.52, 0, h)],
        [clamp(ox + size * 0.45, 0, w), clamp(oy + size * 0.82, 0, h)],
        [clamp(ox + size * 0.82, 0, w), clamp(oy + size * 0.22, 0, h)],
      ],
    ]
  }
  if (kind === 'x-box') {
    if (o.dash === 'none') return []
    const i = (o.dash === 'draw' ? 0.62 : 0) * (o.strokeWidth ?? 0)
    return [
      [
        [clamp(i, 0, w), clamp(i, 0, h)],
        [clamp(w - i, 0, w), clamp(h - i, 0, h)],
      ],
      [
        [clamp(w - i, 0, w), clamp(i, 0, h)],
        [clamp(i, 0, w), clamp(h - i, 0, h)],
      ],
    ]
  }
  return []
}
