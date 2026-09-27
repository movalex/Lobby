import { describe, expect, it } from 'vitest'
import {
  exceedsCanvasLimits,
  FIXED_PAGE_PT,
  headerBandHeight,
  imagePixelSize,
  MAX_PDF_SIDE_PT,
  MIN_PDF_LONG_SIDE_PT,
  PDF_RASTER,
  PT_PER_PX,
  pdfPageSize,
  pdfRasterScale,
  planPdfPage,
} from './pdf-layout.ts'

describe('pdfPageSize', () => {
  it('maps board px to points at 0.75 pt/px (96 px = 1 inch)', () => {
    expect(pdfPageSize(1920, 1080)).toEqual({ width: 1440, height: 810, ptPerPx: PT_PER_PX })
    expect(pdfPageSize(96, 192)).toEqual({ width: 72, height: 144, ptPerPx: PT_PER_PX })
  })

  it('shrinks huge frames to the 200 inch PDF limit, keeping the aspect ratio', () => {
    const p = pdfPageSize(40_000, 10_000)
    expect(p.width).toBeCloseTo(MAX_PDF_SIDE_PT)
    expect(p.height).toBeCloseTo(3600)
    expect(p.ptPerPx).toBeCloseTo(MAX_PDF_SIDE_PT / 40_000)
  })

  it('grows tiny frames so the long side is at least 2 inches', () => {
    const p = pdfPageSize(40, 20)
    expect(p.width).toBeCloseTo(MIN_PDF_LONG_SIDE_PT)
    expect(p.height).toBeCloseTo(72)
  })

  it('never goes below the 3 pt PDF minimum and tolerates bad input', () => {
    expect(pdfPageSize(20_000, 1).height).toBe(3)
    expect(pdfPageSize(Number.NaN, -5)).toEqual(pdfPageSize(1, 1))
  })
})

describe('pdfRasterScale', () => {
  it('renders ordinary frames at 3x (sharp at 200% zoom in a viewer)', () => {
    expect(pdfRasterScale(1920, 1080)).toBe(3)
  })

  it('stays at or above 2x while under the pixel budget', () => {
    const s = pdfRasterScale(4000, 3000)
    expect(s).toBeGreaterThanOrEqual(PDF_RASTER.min)
    expect(s).toBeLessThan(3)
  })

  it('drops below 2x only when even 2x would exceed the pixel budget', () => {
    const s = pdfRasterScale(8000, 8000)
    expect(s).toBeLessThan(2)
    expect(8000 * s * 8000 * s).toBeLessThanOrEqual(PDF_RASTER.maxPixels)
  })

  it('gives tiny (scaled-up) pages more pixels per board px', () => {
    // A 40 px frame becomes a 144 pt page: 3.6x the default 0.75 pt/px, so 3 * 4.8 px per board px.
    expect(pdfRasterScale(40, 20)).toBeCloseTo(3 * (MIN_PDF_LONG_SIDE_PT / 40 / PT_PER_PX), 2)
  })

  it('respects custom budgets', () => {
    expect(pdfRasterScale(1000, 1000, { preferred: 4, min: 1, maxPixels: 4_000_000 })).toBe(2)
  })
})

describe('exceedsCanvasLimits', () => {
  it('flags images wider, taller or larger in area than browsers reliably draw', () => {
    expect(exceedsCanvasLimits(7680, 4320)).toBe(false) // 8K
    expect(exceedsCanvasLimits(16_385, 100)).toBe(true)
    expect(exceedsCanvasLimits(100, 20_000)).toBe(true)
    expect(exceedsCanvasLimits(12_000, 12_000)).toBe(true) // 144 MP
  })
})

describe('imagePixelSize', () => {
  it('scales and rounds', () => {
    expect(imagePixelSize(1920.4, 1080, 2)).toEqual({ width: 3841, height: 2160 })
    expect(imagePixelSize(100, 50, 4)).toEqual({ width: 400, height: 200 })
  })
})

describe('planPdfPage', () => {
  const inside = (
    outer: { width: number; height: number },
    r: { x: number; y: number; width: number; height: number },
  ) =>
    r.x >= -1e-6 &&
    r.y >= -1e-6 &&
    r.x + r.width <= outer.width + 1e-6 &&
    r.y + r.height <= outer.height + 1e-6

  it("'fit' keeps the frame's own page size and adds the title band on top", () => {
    const plan = planPdfPage(1920, 1080, 'fit')
    const band = headerBandHeight(1440)
    expect(plan.width).toBe(1440)
    expect(plan.height).toBe(810 + band)
    expect(plan.header).toMatchObject({ x: 0, y: 0, width: 1440, height: band })
    expect(plan.image).toEqual({ x: 0, y: band, width: 1440, height: 810 })
    expect(plan.ptPerPx).toBe(PT_PER_PX)
    expect(plan.header.fontSize).toBeGreaterThan(10)
    // Huge frames still respect the PDF size limit with the band included.
    const tall = planPdfPage(1000, 40_000, 'fit')
    expect(tall.height).toBeLessThanOrEqual(MAX_PDF_SIDE_PT + 1e-6)
  })

  it('16:9 and A4 give every page the same landscape size, whatever the frame', () => {
    for (const format of ['16:9', 'a4'] as const) {
      const sizes = [
        [1920, 1080],
        [800, 1200],
        [300, 3000],
        [5000, 400],
        [40, 20],
      ].map(([w, h]) => planPdfPage(w as number, h as number, format))
      for (const plan of sizes) {
        expect(plan.width).toBe(FIXED_PAGE_PT[format].width)
        expect(plan.height).toBe(FIXED_PAGE_PT[format].height)
        expect(plan.width).toBeGreaterThan(plan.height)
      }
    }
    expect(FIXED_PAGE_PT['16:9'].width / FIXED_PAGE_PT['16:9'].height).toBeCloseTo(16 / 9)
  })

  it('fits the frame below the band with margins, centred, keeping its aspect ratio', () => {
    for (const [w, h] of [
      [1920, 1080],
      [800, 1200],
      [5000, 400],
    ] as const) {
      const plan = planPdfPage(w, h, '16:9')
      const margin = Math.round(plan.width * 0.03)
      expect(plan.image.width / plan.image.height).toBeCloseTo(w / h, 6)
      expect(plan.image.y).toBeGreaterThanOrEqual(plan.header.height + margin - 1e-6)
      expect(plan.image.x).toBeGreaterThanOrEqual(margin - 1e-6)
      expect(inside({ width: plan.width - margin, height: plan.height - margin }, plan.image)).toBe(true)
      // Centred horizontally, and one side touches the margins (as large as fits).
      expect(plan.image.x).toBeCloseTo(plan.width - plan.image.x - plan.image.width, 6)
      const touches =
        Math.abs(plan.image.width - (plan.width - 2 * margin)) < 1e-6 ||
        Math.abs(plan.image.height - (plan.height - plan.header.height - 2 * margin)) < 1e-6
      expect(touches).toBe(true)
      expect(plan.ptPerPx).toBeCloseTo(plan.image.width / w, 9)
    }
  })

  it('the raster scale follows the size the frame is printed at', () => {
    // A small frame blown up onto a 16:9 page gets more pixels than on its own page.
    const small = planPdfPage(200, 120, '16:9')
    expect(pdfRasterScale(200, 120, PDF_RASTER, small.ptPerPx)).toBeGreaterThan(pdfRasterScale(200, 120))
    // Without a print scale it is unchanged.
    expect(pdfRasterScale(1920, 1080, PDF_RASTER, undefined)).toBe(3)
  })
})
