import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  cardBox,
  chooseArea,
  contentMargin,
  DETAILED_MAX_SHAPES,
  expand,
  intersects,
  MAX_THUMBNAIL_SHAPES,
  rendererFor,
  thumbnailFrame,
} from './plan.ts'

describe('which renderer', () => {
  it("small areas get tldraw's exact export, larger ones the simplified drawing, huge ones none", () => {
    expect(rendererFor(0)).toBeNull()
    expect(rendererFor(1)).toBe('detailed')
    expect(rendererFor(DETAILED_MAX_SHAPES)).toBe('detailed')
    expect(rendererFor(DETAILED_MAX_SHAPES + 1)).toBe('schematic')
    expect(rendererFor(MAX_THUMBNAIL_SHAPES)).toBe('schematic')
    expect(rendererFor(MAX_THUMBNAIL_SHAPES + 1)).toBeNull()
  })
})

const aspect = (r: { w: number; h: number }) => r.w / r.h

describe('thumbnail area', () => {
  it('widens any area to the card 16:10 around its centre, never smaller than 480 × 300 page units', () => {
    const wide = cardBox({ x: 0, y: 0, w: 4000, h: 500 })
    expect(aspect(wide)).toBeCloseTo(1.6)
    expect(wide).toMatchObject({ x: 0, w: 4000, h: 2500 })
    expect(wide.y).toBeCloseTo(-1000)
    const tall = cardBox({ x: 0, y: 0, w: 300, h: 3000 })
    expect(aspect(tall)).toBeCloseTo(1.6)
    expect(tall).toMatchObject({ y: 0, h: 3000, w: 4800 })
    // One small note: drawn at its own size in the middle of the card, not blown up to fill it.
    const note = cardBox({ x: 100, y: 100, w: 200, h: 200 })
    expect(note).toEqual({ x: -40, y: 50, w: THUMBNAIL_WIDTH, h: THUMBNAIL_HEIGHT })
  })

  it('draws at 480 × 300 at most, never above 100%', () => {
    const big = thumbnailFrame({ x: -5000, y: -5000, w: 20_000, h: 9000 })
    expect(big?.width).toBeLessThanOrEqual(THUMBNAIL_WIDTH)
    expect(big?.height).toBeLessThanOrEqual(THUMBNAIL_HEIGHT)
    expect(big?.width).toBeGreaterThanOrEqual(THUMBNAIL_WIDTH - 1)
    expect(big?.scale).toBeCloseTo(THUMBNAIL_WIDTH / 20_000)
    const small = thumbnailFrame({ x: 0, y: 0, w: 10, h: 10 })
    expect(small?.scale).toBe(1)
    expect([small?.width, small?.height]).toEqual([THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT])
    expect(thumbnailFrame({ x: 0, y: 0, w: 0, h: 10 })).toBeNull()
    expect(thumbnailFrame({ x: Number.NaN, y: 0, w: 10, h: 10 })).toBeNull()
    expect(thumbnailFrame({ x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 })).toBeNull()
  })

  it('margins scale with the content', () => {
    expect(contentMargin({ x: 0, y: 0, w: 100, h: 50 })).toBe(24)
    expect(contentMargin({ x: 0, y: 0, w: 10_000, h: 50 })).toBe(400)
    expect(expand({ x: 0, y: 0, w: 10, h: 10 }, 5)).toEqual({ x: -5, y: -5, w: 20, h: 20 })
  })

  it('intersection is strict (touching edges do not count)', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    expect(intersects(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(intersects(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false)
    expect(intersects(a, { x: -20, y: -20, w: 5, h: 5 })).toBe(false)
  })
})

describe('what the thumbnail shows', () => {
  const pages = [
    { pageId: 'page:1', bounds: null },
    { pageId: 'page:2', bounds: { x: 0, y: 0, w: 1000, h: 600 } },
    { pageId: 'page:3', bounds: { x: 0, y: 0, w: 50, h: 50 } },
  ]

  it("the owner's start view wins, exactly as saved", () => {
    const startView = { pageId: 'page:3', area: { x: 10, y: 20, w: 300, h: 200 } }
    expect(chooseArea({ startView, startFrame: null, pages })).toEqual({
      kind: 'start-view',
      pageId: 'page:3',
      area: startView.area,
    })
  })

  it('a frame start view follows the frame, with a margin', () => {
    const startView = { pageId: 'page:2', area: { x: 0, y: 0, w: 1, h: 1 } }
    const frame = { x: 100, y: 100, w: 800, h: 450 }
    expect(chooseArea({ startView, startFrame: frame, pages })).toEqual({
      kind: 'start-view',
      pageId: 'page:2',
      area: expand(frame, 32),
    })
  })

  it('without a start view (or when its page is gone): the first page that has content', () => {
    // page:2 is the first with content; its margin is 4% of 1000.
    const content = { kind: 'content', pageId: 'page:2', area: { x: -40, y: -40, w: 1080, h: 680 } }
    expect(chooseArea({ startView: null, startFrame: null, pages })).toEqual(content)
    const gone = { pageId: 'page:deleted', area: { x: 0, y: 0, w: 10, h: 10 } }
    expect(chooseArea({ startView: gone, startFrame: null, pages })).toEqual(content)
  })

  it('an empty board shows nothing (the card keeps its placeholder)', () => {
    expect(
      chooseArea({ startView: null, startFrame: null, pages: [{ pageId: 'page:1', bounds: null }] }),
    ).toEqual({ kind: 'empty' })
    expect(chooseArea({ startView: null, startFrame: null, pages: [] })).toEqual({ kind: 'empty' })
  })
})
