// Which part of the board a thumbnail shows, and at what scale (docs/WAVE3-CONTRACTS.md "thumbnails"):
// the owner's start view when one is set (canvas-ux board-start-view.ts; a frame start view follows its
// frame), otherwise the first frame in presentation order, otherwise everything on the page. Views and
// frames are cropped to the card's 16:10; content is widened to it (F11: never a thin strip). Nothing
// is drawn above 100%, so one small note stays note-sized instead of filling the card. Pure:
// unit-tested in Node.

import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@draftroom/contracts'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const THUMBNAIL_ASPECT = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT
/**
 * tldraw's own export (text included) is used up to this many shapes in the area. Its cost grows with
 * the shapes drawn, on the main thread: every one is rendered into a hidden React tree and its styles
 * inlined (measured in Chromium: ~180 ms for 60 sticky notes, ~1 s for 300). Above it, schematic.ts
 * draws a simplified picture in a few milliseconds.
 */
export const DETAILED_MAX_SHAPES = 30
/** Past this, no thumbnail is made at all and the card keeps what it had. */
export const MAX_THUMBNAIL_SHAPES = 10_000

/** Which renderer a thumbnail of `shapeCount` shapes uses (null: none). */
export function rendererFor(shapeCount: number): 'detailed' | 'schematic' | null {
  if (shapeCount <= 0 || shapeCount > MAX_THUMBNAIL_SHAPES) return null
  return shapeCount <= DETAILED_MAX_SHAPES ? 'detailed' : 'schematic'
}

/** Margin around page content, in page units: 4% of its larger side, at least 24. */
export const contentMargin = (r: Rect) => Math.max(24, 0.04 * Math.max(r.w, r.h))

export const expand = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
})

/** The smallest 16:10 box, at least THUMBNAIL_WIDTH × THUMBNAIL_HEIGHT page units, centred on `r`. */
export function cardBox(r: Rect): Rect {
  let w = Math.max(r.w, r.h * THUMBNAIL_ASPECT, THUMBNAIL_WIDTH)
  let h = w / THUMBNAIL_ASPECT
  if (h < r.h) {
    h = r.h
    w = h * THUMBNAIL_ASPECT
  }
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/**
 * How an area becomes the card's 16:10 box (F11):
 * - `contain`: all of it, widened to 16:10 (content without frames), except that a very wide or very
 *   tall area is cropped from its start (left, or top) so that it fills at least half of the card
 *   instead of becoming a thin strip;
 * - `cover`: the card is filled with it, the overflow cropped evenly (a start view);
 * - `cover-top`: the same, but a much taller area keeps its top, where a frame's heading is;
 * - `frame` (R11): a frame. Taller than the card: `cover-top`. Wider: never centre-cropped (an
 *   even side crop cut the Retrospective's 2560 × 420 Check-in frame to a middle slice with half
 *   notes and a sentence starting mid-word): the whole frame, at the card's top, when it fills at
 *   least half of the card's height; a very wide one from its left end (where its heading and
 *   sentences start) at half the card's height.
 */
export type Fit = 'contain' | 'cover' | 'cover-top' | 'frame'

/** Content at least this share of the card's height (or width) in `contain`. */
const MIN_FILL = 0.5

/** Grows a 16:10 box around its centre to at least THUMBNAIL_WIDTH × THUMBNAIL_HEIGHT page units. */
function atLeastCard(b: Rect): Rect {
  if (b.w >= THUMBNAIL_WIDTH) return b
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  return {
    x: cx - THUMBNAIL_WIDTH / 2,
    y: cy - THUMBNAIL_HEIGHT / 2,
    w: THUMBNAIL_WIDTH,
    h: THUMBNAIL_HEIGHT,
  }
}

export function fitBox(r: Rect, fit: Fit): Rect {
  const a = r.w / r.h
  if (fit === 'frame') {
    if (a <= THUMBNAIL_ASPECT) return fitBox(r, 'cover-top')
    // Wide: as tall as the frame (very wide: twice as tall), from the frame's top-left corner.
    const h = a > THUMBNAIL_ASPECT / MIN_FILL ? r.h / MIN_FILL : r.w / THUMBNAIL_ASPECT
    return atLeastCard({ x: r.x, y: r.y, w: h * THUMBNAIL_ASPECT, h })
  }
  if (fit === 'contain') {
    // Wider than the card by more than 1 / MIN_FILL: as tall as twice the content, from its left end.
    if (a > THUMBNAIL_ASPECT / MIN_FILL) {
      const h = r.h / MIN_FILL
      return atLeastCard({ x: r.x, y: r.y + r.h / 2 - h / 2, w: h * THUMBNAIL_ASPECT, h })
    }
    // Taller than the card by more than that: twice the content's width, from its top.
    if (a < THUMBNAIL_ASPECT * MIN_FILL) {
      const w = r.w / MIN_FILL
      return atLeastCard({ x: r.x + r.w / 2 - w / 2, y: r.y, w, h: w / THUMBNAIL_ASPECT })
    }
    return cardBox(r)
  }
  if (a >= THUMBNAIL_ASPECT) {
    // Wider than the card: full height, the sides cropped evenly.
    const w = r.h * THUMBNAIL_ASPECT
    return atLeastCard({ x: r.x + r.w / 2 - w / 2, y: r.y, w, h: r.h })
  }
  // Taller: full width, cropped evenly; `cover-top` crops only the bottom once that is more than a
  // sliver (a portrait frame keeps its heading; a 16:10 frame with its margin stays centred).
  const h = r.w / THUMBNAIL_ASPECT
  const fromTop = fit === 'cover-top' && r.h - h > 0.1 * r.h
  const y = fromTop ? r.y : r.y + r.h / 2 - h / 2
  return atLeastCard({ x: r.x, y, w: r.w, h })
}

export interface ThumbnailFrame {
  box: Rect
  /** Page units → image pixels (≤ 1). */
  scale: number
  width: number
  height: number
}

/** The card box for `area` and the scale that draws it at THUMBNAIL_WIDTH × THUMBNAIL_HEIGHT at most. */
export function thumbnailFrame(area: Rect, fit: Fit = 'contain'): ThumbnailFrame | null {
  if (![area.x, area.y, area.w, area.h].every(Number.isFinite) || area.w <= 0 || area.h <= 0) return null
  const box = fitBox(area, fit)
  const scale = Math.min(1, THUMBNAIL_WIDTH / box.w)
  return {
    box,
    scale,
    width: Math.max(1, Math.min(THUMBNAIL_WIDTH, Math.floor(box.w * scale))),
    height: Math.max(1, Math.min(THUMBNAIL_HEIGHT, Math.floor(box.h * scale))),
  }
}

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** What the thumbnail should show, decided from plain data (see render.ts for the editor side). */
export type ThumbnailArea =
  | { kind: 'start-view'; pageId: string; area: Rect; fit: Fit }
  | { kind: 'frame'; pageId: string; area: Rect; fit: Fit }
  | { kind: 'content'; pageId: string; area: Rect; fit: Fit }
  | { kind: 'empty' }

export interface PageContent {
  pageId: string
  /** Union of the page's visible shapes' page bounds; null when the page has none. */
  bounds: Rect | null
  /** The page's first visible top-level frame in presentation order (Present's slide 1), if any. */
  firstFrame?: Rect | null
}

/**
 * The start view wins when its page exists (a frame start view uses the frame's bounds plus a margin,
 * the way "Go to start view" shows it); otherwise the first page, in page order, that has content: a
 * first-time visitor lands on the first page, and a board whose first page is empty is better shown
 * by the content it has than by nothing. On that page, a board with frames shows its first frame
 * (the first slide, what the board is "about"); only a board without frames shows all its content.
 * Views fill the card (cropped to 16:10), so a wide row of frames never becomes a strip; a wide frame
 * is never centre-cropped (R11: `frame` fit shows it whole, or a very wide one from its left end).
 */
export function chooseArea(opts: {
  startView: { pageId: string; area: Rect } | null
  startFrame: Rect | null
  pages: readonly PageContent[]
}): ThumbnailArea {
  const { startView, startFrame, pages } = opts
  if (startView && pages.some((p) => p.pageId === startView.pageId)) {
    if (startFrame)
      return {
        kind: 'start-view',
        pageId: startView.pageId,
        area: expand(startFrame, contentMargin(startFrame)),
        fit: 'frame',
      }
    return { kind: 'start-view', pageId: startView.pageId, area: startView.area, fit: 'cover' }
  }
  for (const p of pages) {
    if (!p.bounds) continue
    if (p.firstFrame)
      return {
        kind: 'frame',
        pageId: p.pageId,
        area: expand(p.firstFrame, contentMargin(p.firstFrame)),
        fit: 'frame',
      }
    return {
      kind: 'content',
      pageId: p.pageId,
      area: expand(p.bounds, contentMargin(p.bounds)),
      fit: 'contain',
    }
  }
  return { kind: 'empty' }
}
