// What the Export dialog starts on (F14, round-2 demo walk). It used to open on "Whole board" at the
// remembered 2×, which on the six-frame Lobby tour meant a 20,800 px PNG and a yellow "larger than
// browsers can reliably draw" warning before anyone had chosen anything. F14 then opened on what the person was
// looking at (the frame that fills the view), which gave "Frame: 1 · Welcome" and a file for one frame when someone
// asked to export the board (P-026, wave P). Now it opens on the selection when there is one, else the whole board,
// at their remembered size stepped down (for this opening only) until the image fits the browser's canvas limits.
// Pure; ExportDialog.tsx reads the editor.

import { exceedsCanvasLimits, imagePixelSize } from './pdf-layout.ts'

export interface RectLike {
  x: number
  y: number
  w: number
  h: number
}

/** What the image export opens on (P-026): the selection, a single selected frame as that frame, else the board. */
export function openingArea(s: { selected: number; selectedFrame: boolean }): 'selection' | 'frame' | 'board' {
  if (s.selected === 0) return 'board'
  return s.selected === 1 && s.selectedFrame ? 'frame' : 'selection'
}

/** The frame counts as "the one in view" when it covers at least this share of the viewport… */
export const FRAME_VIEW_SHARE = 0.25
/** …and this share of whichever is smaller, the frame or the viewport, is on screen. */
export const FRAME_VISIBLE_SHARE = 0.6

function overlapArea(a: RectLike, b: RectLike): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

const area = (r: RectLike) => Math.max(0, r.w) * Math.max(0, r.h)

/**
 * The frame the viewport is showing, if one clearly is: zoomed to a frame, or zoomed into part of a
 * frame. Several frames in view at once (the whole tour, or panning between two) is no frame. Of the
 * frames that qualify, the one that matches the view best (intersection over union) wins, so a nested
 * frame that fills the view beats its much larger parent.
 */
export function frameInView(
  viewport: RectLike,
  frames: readonly { id: string; bounds: RectLike }[],
): string | null {
  const vpArea = area(viewport)
  if (!(vpArea > 0)) return null
  let best: { id: string; match: number } | null = null
  for (const f of frames) {
    const size = area(f.bounds)
    if (!(size > 0)) continue
    const shown = overlapArea(viewport, f.bounds)
    if (shown < FRAME_VIEW_SHARE * vpArea) continue
    if (shown < FRAME_VISIBLE_SHARE * Math.min(size, vpArea)) continue
    const match = shown / (size + vpArea - shown)
    if (!best || match > best.match) best = { id: f.id, match }
  }
  return best?.id ?? null
}

/**
 * The size to open with: the remembered one, or the largest smaller one whose PNG stays within the
 * browser's canvas limits (so the dialog never opens on the "larger than browsers can draw" warning
 * the person did not ask for). If even the smallest is too large, the smallest (and the warning).
 */
export function openingScale<S extends number>(
  preferred: S,
  scales: readonly S[],
  size: { w: number; h: number } | null,
): S {
  if (!size) return preferred
  const fits = (s: S) => {
    const px = imagePixelSize(size.w, size.h, s)
    return !exceedsCanvasLimits(px.width, px.height)
  }
  if (fits(preferred)) return preferred
  const smaller = [...scales].filter((s) => s < preferred).sort((a, b) => b - a)
  return smaller.find(fits) ?? smaller[smaller.length - 1] ?? preferred
}
