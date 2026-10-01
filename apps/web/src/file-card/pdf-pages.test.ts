import { describe, expect, it } from 'vitest'
import { derivative, makeMeta } from '../assets/test-fixtures.ts'
import {
  documentPageCount,
  layoutPageRow,
  PAGE_GAP,
  pageAltText,
  pageAssetName,
  placedPageSize,
  previewPages,
  stepPage,
  toggleSelection,
  VIEWER_ZOOM_STEPS,
  validPage,
  viewerPageSize,
  zoomLabel,
  zoomStep,
} from './pdf-pages.ts'

/** A ready PDF the way the worker writes it: pages 1..rendered (1024 wide), plus a 512 thumb of page 1. */
function readyPdf(pageCount: number, rendered = Math.min(pageCount, 8)) {
  const pages = Array.from({ length: rendered }, (_, i) =>
    derivative({ role: 'page', page: i + 1, width: 1024, height: 1325, bytes: 40_000 + i }),
  )
  const thumb = derivative({ role: 'thumb', page: 1, width: 512, height: 663 })
  const meta = makeMeta({
    status: 'ready',
    name: 'Q3 brief.pdf',
    derivatives: [pages[1], thumb, ...pages.filter((_, i) => i !== 1)].filter((d) => d !== undefined),
    probe: { width: null, height: null, pageCount, durationMs: null, videoCodec: null, audioCodec: null },
  })
  return { meta, pages, thumb }
}

describe('previewPages', () => {
  it('lists the rendered pages in page order, each with its largest and smallest rendering', () => {
    const { meta, pages, thumb } = readyPdf(4)
    const list = previewPages(meta)
    expect(list.map((p) => p.page)).toEqual([1, 2, 3, 4])
    expect(list[0]).toEqual({ page: 1, full: pages[0], thumb })
    expect(list[2]).toEqual({ page: 3, full: pages[2], thumb: pages[2] })
  })

  it('is empty until the version is ready, for non-PDFs, and skips derivatives with unsafe ids', () => {
    const { meta } = readyPdf(3)
    expect(previewPages({ ...meta, status: 'processing' })).toEqual([])
    expect(previewPages({ ...meta, kind: 'image' })).toEqual([])
    expect(previewPages(null)).toEqual([])
    const tampered = {
      ...meta,
      derivatives: meta.derivatives.map((d) => (d.page === 2 ? { ...d, id: '../../etc' } : d)),
    }
    expect(previewPages(tampered).map((p) => p.page)).toEqual([1, 3])
  })

  it('counts the document, not just the previews (only the first 8 of 24 are rendered)', () => {
    const { meta } = readyPdf(24)
    expect(previewPages(meta)).toHaveLength(8)
    expect(documentPageCount(meta, { pageCount: null }, 8)).toBe(24)
    expect(documentPageCount(null, { pageCount: 12 }, 0)).toBe(12)
    expect(documentPageCount(null, { pageCount: null }, 3)).toBe(3)
  })
})

describe('page navigation', () => {
  const pages = [1, 2, 3, 4, 5, 6, 7, 8]
  it('steps through previewed pages and stops at the ends', () => {
    expect(stepPage(pages, 1, 1)).toBe(2)
    expect(stepPage(pages, 1, -1)).toBe(1)
    expect(stepPage(pages, 8, 1)).toBe(8)
    expect(stepPage(pages, 3, Number.MAX_SAFE_INTEGER)).toBe(8)
    expect(stepPage(pages, 3, -Number.MAX_SAFE_INTEGER)).toBe(1)
    expect(stepPage([], 1, 1)).toBe(1)
  })
  it('opens at the requested page, or the nearest one with a preview', () => {
    expect(validPage(pages, 5)).toBe(5)
    expect(validPage(pages, 20)).toBe(8)
    expect(validPage(pages, 0)).toBe(1)
    expect(validPage([], 4)).toBe(1)
  })
})

describe('toggleSelection', () => {
  const available = [1, 2, 3, 4, 5, 6]
  it('toggles single pages and keeps the selection sorted and unique', () => {
    let s = toggleSelection([], 3, available)
    s = toggleSelection(s, 1, available)
    expect(s).toEqual([1, 3])
    expect(toggleSelection(s, 3, available)).toEqual([1])
  })
  it('Shift selects (or clears) the whole range from the last click', () => {
    expect(toggleSelection([2], 5, available, { range: true, anchor: 2 })).toEqual([2, 3, 4, 5])
    expect(toggleSelection([1, 2, 3, 4, 5, 6], 2, available, { range: true, anchor: 5 })).toEqual([1, 6])
    // No anchor: an ordinary toggle.
    expect(toggleSelection([], 4, available, { range: true, anchor: null })).toEqual([4])
  })
  it('ignores pages without a preview', () => {
    expect(toggleSelection([2, 9], 7, available)).toEqual([2])
  })
})

describe('viewer zoom', () => {
  it('steps through fixed levels and labels them', () => {
    expect(zoomStep(1, 1)).toBe(1.5)
    expect(zoomStep(1.5, -1)).toBe(1)
    expect(zoomStep(1, -1)).toBe(1)
    expect(zoomStep(4, 1)).toBe(4)
    expect(zoomStep(2.2, -1)).toBe(2)
    expect(VIEWER_ZOOM_STEPS[0]).toBe(1)
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.5)).toBe('150%')
  })
  it('fits the whole page in the stage at zoom 1', () => {
    expect(viewerPageSize({ w: 1024, h: 1325 }, { w: 800, h: 600 }, 1)).toEqual({
      w: (1024 * 600) / 1325,
      h: 600,
    })
    expect(viewerPageSize({ w: 1024, h: 1325 }, { w: 800, h: 600 }, 2).h).toBe(1200)
    expect(viewerPageSize({ w: 0, h: 1 }, { w: 800, h: 600 }, 1)).toEqual({ w: 0, h: 0 })
  })
})

describe('placing pages', () => {
  it('lays pages out left to right, tops aligned, PAGE_GAP apart', () => {
    const row = layoutPageRow([placedPageSize({ width: 1024, height: 1325 }), { w: 400, h: 300 }])
    expect(row.items).toEqual([
      { x: 0, y: 0, w: 512, h: 662.5 },
      { x: 512 + PAGE_GAP, y: 0, w: 400, h: 300 },
    ])
    expect(row.w).toBe(512 + PAGE_GAP + 400)
    expect(row.h).toBe(662.5)
    expect(layoutPageRow([])).toEqual({ w: 0, h: 0, items: [] })
  })

  it('a placed page is half its rendering: sharp at 100 % on a 2x screen and at 200 % on a 1x one', () => {
    const d = { width: 1024, height: 1325 }
    const s = placedPageSize(d)
    for (const [zoom, dpr] of [
      [1, 2],
      [2, 1],
      [1, 1],
    ] as const) {
      expect(s.w * zoom * dpr).toBeLessThanOrEqual(d.width)
    }
  })

  it('names and describes the page', () => {
    expect(pageAssetName('Q3 brief.pdf', 2, 'image/webp')).toBe('Q3 brief — page 2.webp')
    expect(pageAssetName('.PDF', 1, 'image/png')).toBe('document — page 1.png')
    expect(pageAltText('Q3 brief.pdf', 4)).toBe('Page 4 of Q3 brief.pdf')
  })
})
