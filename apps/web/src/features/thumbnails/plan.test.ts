import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  cardBox,
  chooseArea,
  contentMargin,
  DETAILED_MAX_SHAPES,
  expand,
  fitBox,
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

  it('cover fills the card with the area, cropping what does not fit (F11): centred, or from the top', () => {
    // A 16:10 frame plus its margin is a little taller than 16:10: the margin is cropped, top and bottom.
    const area = expand({ x: 0, y: 0, w: 1600, h: 1000 }, 64)
    const c = fitBox(area, 'cover')
    expect(aspect(c)).toBeCloseTo(1.6)
    expect(c.w).toBeCloseTo(area.w)
    expect(c.y).toBeGreaterThan(area.y)
    expect(c.y + c.h).toBeLessThan(area.y + area.h)
    expect(c.y + c.h / 2).toBeCloseTo(area.y + area.h / 2)
    // cover-top crops such a sliver evenly as well…
    expect(fitBox(area, 'cover-top')).toEqual(c)
    // …but a portrait frame keeps its top (its heading) and loses its bottom.
    const tall = fitBox({ x: 0, y: 0, w: 800, h: 2000 }, 'cover-top')
    expect(tall).toEqual({ x: 0, y: 0, w: 800, h: 500 })
    // A wide one loses its sides, not its height.
    const wide = fitBox({ x: 0, y: 0, w: 3000, h: 500 }, 'cover')
    expect(wide).toMatchObject({ y: 0, h: 500, w: 800 })
    expect(wide.x).toBeCloseTo(1100)
    // Never smaller than the card in page units (a tiny frame is drawn at 100%, not blown up).
    expect(fitBox({ x: 0, y: 0, w: 160, h: 100 }, 'cover')).toEqual({
      x: 80 - THUMBNAIL_WIDTH / 2,
      y: 50 - THUMBNAIL_HEIGHT / 2,
      w: THUMBNAIL_WIDTH,
      h: THUMBNAIL_HEIGHT,
    })
  })

  it('contain shows all of the content, but a very wide or tall board is not shrunk to a thin strip (F11)', () => {
    expect(fitBox({ x: 0, y: 0, w: 1000, h: 600 }, 'contain')).toEqual(
      cardBox({ x: 0, y: 0, w: 1000, h: 600 }),
    )
    // The six-frame tour row without frames to go by (10,400 × 1,000): at most half the card is empty.
    const strip = { x: 0, y: 0, w: 10_400, h: 1000 }
    const box = fitBox(strip, 'contain')
    expect(aspect(box)).toBeCloseTo(1.6)
    expect(strip.h / box.h).toBeGreaterThanOrEqual(0.5 - 1e-9)
    // It starts where reading starts: the left end, vertically centred.
    expect(box.x).toBe(0)
    expect(box.y + box.h / 2).toBeCloseTo(500)
    const column = fitBox({ x: 0, y: 0, w: 400, h: 8000 }, 'contain')
    expect(column.y).toBe(0)
    expect(400 / column.w).toBeGreaterThanOrEqual(0.5 - 1e-9)
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

  it("the owner's start view wins, cropped to the card (not widened around it)", () => {
    const startView = { pageId: 'page:3', area: { x: 10, y: 20, w: 300, h: 200 } }
    expect(chooseArea({ startView, startFrame: null, pages })).toEqual({
      kind: 'start-view',
      pageId: 'page:3',
      area: startView.area,
      fit: 'cover',
    })
  })

  it('a frame start view follows the frame, with a margin, keeping its top', () => {
    const startView = { pageId: 'page:2', area: { x: 0, y: 0, w: 1, h: 1 } }
    const frame = { x: 100, y: 100, w: 800, h: 450 }
    expect(chooseArea({ startView, startFrame: frame, pages })).toEqual({
      kind: 'start-view',
      pageId: 'page:2',
      area: expand(frame, 32),
      fit: 'cover-top',
    })
  })

  it('without a start view (or when its page is gone): the first page that has content', () => {
    // page:2 is the first with content; its margin is 4% of 1000.
    const content = {
      kind: 'content',
      pageId: 'page:2',
      area: { x: -40, y: -40, w: 1080, h: 680 },
      fit: 'contain',
    }
    expect(chooseArea({ startView: null, startFrame: null, pages })).toEqual(content)
    const gone = { pageId: 'page:deleted', area: { x: 0, y: 0, w: 10, h: 10 } }
    expect(chooseArea({ startView: gone, startFrame: null, pages })).toEqual(content)
  })

  it('a board with frames and no start view shows its first frame (presentation order), cropped to 16:10 (F11)', () => {
    // The Lobby tour: six 1600 × 1000 frames in a 10,400 wide row. The card shows slide 1, not a strip.
    const first = { x: 0, y: 0, w: 1600, h: 1000 }
    const tour = [{ pageId: 'page:1', bounds: { x: 0, y: 0, w: 10_400, h: 1000 }, firstFrame: first }]
    const choice = chooseArea({ startView: null, startFrame: null, pages: tour })
    expect(choice).toEqual({ kind: 'frame', pageId: 'page:1', area: expand(first, 64), fit: 'cover-top' })
    if (choice.kind !== 'frame') throw new Error('unreachable')
    const frame = thumbnailFrame(choice.area, choice.fit)
    expect([frame?.width, frame?.height]).toEqual([THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT])
    // The whole frame's width is on the card, nothing of the next frame (160 to the right) is.
    expect(frame?.box.x).toBeLessThanOrEqual(0)
    expect((frame?.box.x ?? 0) + (frame?.box.w ?? 0)).toBeLessThan(1600 + 160)
    // An owner's start view still wins over the first frame.
    const startView = { pageId: 'page:1', area: { x: 3520, y: 0, w: 1600, h: 1000 } }
    expect(chooseArea({ startView, startFrame: null, pages: tour })).toMatchObject({ kind: 'start-view' })
  })

  it('an empty board shows nothing (the card keeps its placeholder)', () => {
    expect(
      chooseArea({ startView: null, startFrame: null, pages: [{ pageId: 'page:1', bounds: null }] }),
    ).toEqual({ kind: 'empty' })
    expect(chooseArea({ startView: null, startFrame: null, pages: [] })).toEqual({ kind: 'empty' })
  })
})
