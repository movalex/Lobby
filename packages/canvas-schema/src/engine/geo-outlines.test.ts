// CR-2B-2: the converter's geo outlines moved into canvas-schema (engine/geo-outlines.ts) unchanged, with
// tldraw's seeded random ported (no tldraw package). The digests below were computed from the converter's
// `geoOutline` (packages/tldraw-import geo-shapes.ts, @tldraw/utils `rng`) before the move, for every tldraw
// geo kind at three sizes and three option sets (the cloud's seed, size and scale): a changed outline, or a
// port of the random that drifts, changes them.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { geoOutline, seededRandom } from './geo-outlines.ts'

const KINDS = [
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

/** sha256 (16 hex) of the converter's outlines before the move, per kind. */
const PINNED: Readonly<Record<(typeof KINDS)[number], string>> = {
  'arrow-down': '12f3db08671639d8',
  'arrow-left': 'd6d63576ea5d766b',
  'arrow-right': '57afbfe1e1ff93ab',
  'arrow-up': '5c52dc9545370a4a',
  'check-box': '53ba568e4f0540fb',
  cloud: '26e1de59a5b6f673',
  diamond: '53ba568e4f0540fb',
  ellipse: '53ba568e4f0540fb',
  heart: '448cd162354fa486',
  hexagon: '9b40d03a160e9751',
  octagon: '64b1ed598a05a31a',
  oval: '53ba568e4f0540fb',
  pentagon: '6d286ae6ce9ea359',
  rectangle: '53ba568e4f0540fb',
  'rhombus-2': '2cbdae7255264a73',
  rhombus: '63834a1be049697d',
  star: '8714eea5496bc9b5',
  trapezoid: '370c9ed63ee7a0fa',
  triangle: '53a33556dbf4cee3',
  'x-box': '53ba568e4f0540fb',
}

describe('geoOutline (CR-2B-2)', () => {
  it('is the converter’s outline of every kind, unchanged by the move (pinned digests)', () => {
    for (const kind of KINDS) {
      const runs = []
      for (const [w, h] of [
        [200, 120],
        [97.3, 311.9],
        [12, 8],
      ] as const)
        for (const o of [{}, { seed: 'shape:abc', size: 'l', scale: 1.5 }, { seed: 'g1x2', size: 's' }])
          runs.push(geoOutline(kind, w, h, o))
      const digest = createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 16)
      expect(digest, kind).toBe(PINNED[kind])
    }
  })

  it('every outline is closed and inside its box (the cloud: its sampled bumps within 1 px of it)', () => {
    for (const kind of KINDS) {
      const pts = geoOutline(kind, 300, 160, { seed: 'shape:x' })
      expect(pts[0], kind).toEqual(pts[pts.length - 1])
      const slack = kind === 'cloud' ? 1 : 1e-9
      for (const [x, y] of pts) {
        expect(x, kind).toBeGreaterThanOrEqual(-slack)
        expect(x, kind).toBeLessThanOrEqual(300 + slack)
        expect(y, kind).toBeGreaterThanOrEqual(-slack)
        expect(y, kind).toBeLessThanOrEqual(160 + slack)
      }
    }
  })

  it('seededRandom: the same seed gives the same numbers in [-1, 1), another seed others', () => {
    const a = seededRandom('shape:abc')
    const b = seededRandom('shape:abc')
    const c = seededRandom('shape:abd')
    const xs = Array.from({ length: 8 }, () => a())
    expect(Array.from({ length: 8 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 8 }, () => c())).not.toEqual(xs)
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(-1)
      expect(x).toBeLessThan(1)
    }
  })
})
