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
import { type GeoOutlineOptions, geoOutline } from '@draftroom/canvas-schema/engine'

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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * CR-2B-2: the polygon kinds' outlines are canvas-schema's (engine/geo-outlines.ts), shared with the web's
 * polygon tools; re-exported here for the converter's callers.
 */
export { type GeoOutlineOptions, geoOutline }

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
