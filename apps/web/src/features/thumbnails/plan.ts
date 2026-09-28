// Which part of the board a thumbnail shows, and at what scale (docs/WAVE3-CONTRACTS.md "thumbnails"):
// the owner's start view when one is set (canvas-ux board-start-view.ts; a frame start view follows its
// frame), otherwise everything on the page. The area is widened to the card's 16:10 and never drawn
// above 100%, so one small note stays note-sized instead of filling the card. Pure: unit-tested in Node.

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

export interface ThumbnailFrame {
  box: Rect
  /** Page units → image pixels (≤ 1). */
  scale: number
  width: number
  height: number
}

/** The card box for `area` and the scale that draws it at THUMBNAIL_WIDTH × THUMBNAIL_HEIGHT at most. */
export function thumbnailFrame(area: Rect): ThumbnailFrame | null {
  if (![area.x, area.y, area.w, area.h].every(Number.isFinite) || area.w <= 0 || area.h <= 0) return null
  const box = cardBox(area)
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
  | { kind: 'start-view'; pageId: string; area: Rect }
  | { kind: 'content'; pageId: string; area: Rect }
  | { kind: 'empty' }

export interface PageContent {
  pageId: string
  /** Union of the page's visible shapes' page bounds; null when the page has none. */
  bounds: Rect | null
}

/**
 * The start view wins when its page exists (a frame start view uses the frame's bounds plus a margin,
 * the way "Go to start view" shows it); otherwise the first page, in page order, that has content: a
 * first-time visitor lands on the first page, and a board whose first page is empty is better shown
 * by the content it has than by nothing.
 */
export function chooseArea(opts: {
  startView: { pageId: string; area: Rect } | null
  startFrame: Rect | null
  pages: readonly PageContent[]
}): ThumbnailArea {
  const { startView, startFrame, pages } = opts
  if (startView && pages.some((p) => p.pageId === startView.pageId)) {
    const area = startFrame ? expand(startFrame, contentMargin(startFrame)) : startView.area
    return { kind: 'start-view', pageId: startView.pageId, area }
  }
  for (const p of pages) {
    if (p.bounds)
      return { kind: 'content', pageId: p.pageId, area: expand(p.bounds, contentMargin(p.bounds)) }
  }
  return { kind: 'empty' }
}
