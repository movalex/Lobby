import { describe, expect, it } from 'vitest'
import {
  exceedsCanvasLimits,
  imagePixelSize,
  MAX_PDF_SIDE_PT,
  MIN_PDF_LONG_SIDE_PT,
  PDF_RASTER,
  PT_PER_PX,
  pdfPageSize,
  pdfRasterScale,
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
