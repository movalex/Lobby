// What a gallery thumbnail shows of a template's preview. Apart from template-catalog.ts, which pulls in the template
// planner: the dashboard's first bundle draws thumbnails (the Start row) without loading the catalog's code.
import type { PreviewRect, TemplatePreview } from './template-catalog.ts'

/**
 * What a thumbnail shows of a preview: all of it, except for a strip wider than 3:1 (the Lobby tour: six frames in a
 * row), which showed as a thin line of tiny frames (P-032). That one shows its first frame, filling the thumbnail, as a
 * wide board's own thumbnail does.
 */
export function thumbWindow(preview: Pick<TemplatePreview, 'bounds' | 'frames'>): PreviewRect {
  const { bounds, frames } = preview
  if (bounds.w <= bounds.h * 3 || frames.length === 0) return bounds
  const first = frames.reduce((a, f) => (f.x < a.x ? f : a))
  return { x: first.x, y: first.y, w: first.w, h: first.h }
}

/** Whether `r` is at least partly inside `win`. */
export const touches = (r: PreviewRect, win: PreviewRect): boolean =>
  r.x < win.x + win.w && r.x + r.w > win.x && r.y < win.y + win.h && r.y + r.h > win.y
