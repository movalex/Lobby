// Pure slide logic for present mode and PDF export (no editor, no DOM): which frames are slides, where a
// presentation starts, how the current slide survives live edits, and which frames become PDF pages.
import type { TLShapeId } from 'tldraw'
import type { FrameEntry } from './board-ops.ts'

export interface SlideBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Slide {
  id: TLShapeId
  /** The frame's name as typed ('' when unnamed); use `slideTitle` for display. */
  name: string
  bounds: SlideBox
}

/** Anything with a `meta` bag (a tldraw shape record). */
export interface MetaCarrier {
  meta?: unknown
}

/** `meta.presentationSkip === true` (written by the frame outline's skip toggle). Anything else presents. */
export function isSkipped(shape: MetaCarrier | undefined): boolean {
  const meta = shape?.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false
  return (meta as Record<string, unknown>).presentationSkip === true
}

/**
 * Slides = the page's top-level frames in presentation order (board-ops `presentationOrder`), minus
 * frames marked "skip in presentation". Frames with an empty area are left out (nothing to fit to).
 */
export function buildSlides(
  order: readonly FrameEntry[],
  shapeOf: (id: TLShapeId) => MetaCarrier | undefined,
): Slide[] {
  const slides: Slide[] = []
  for (const entry of order) {
    if (isSkipped(shapeOf(entry.id))) continue
    if (!(entry.bounds.w > 0 && entry.bounds.h > 0)) continue
    slides.push({ id: entry.id, name: entry.name, bounds: { ...entry.bounds } })
  }
  return slides
}

export function slideTitle(name: string, index: number): string {
  const trimmed = name.trim()
  return trimmed || `Frame ${index + 1}`
}

/**
 * Where a presentation opens: the slide that is selected (or that contains the first selected shape
 * that belongs to a slide), else the first slide. A selected frame that is skipped starts at the next
 * slide after it in presentation order (or the last one before it when it is the tail).
 *
 * `ancestorsOf(id)` lists the shape's ancestors nearest first (tldraw `getShapeAncestors`, reversed).
 * Returns -1 when there are no slides.
 */
export function findStartIndex(
  slides: readonly Slide[],
  order: readonly FrameEntry[],
  selectedIds: readonly TLShapeId[],
  ancestorsOf: (id: TLShapeId) => readonly TLShapeId[],
): number {
  if (slides.length === 0) return -1
  const slideIndex = new Map(slides.map((s, i) => [s.id as string, i]))
  const orderIndex = new Map(order.map((e, i) => [e.id as string, i]))
  for (const id of selectedIds) {
    for (const candidate of [id, ...ancestorsOf(id)]) {
      const direct = slideIndex.get(candidate)
      if (direct !== undefined) return direct
      const position = orderIndex.get(candidate)
      if (position === undefined) continue
      // A skipped top-level frame: the next slide after it, else the closest one before it.
      for (let i = position + 1; i < order.length; i++) {
        const next = slideIndex.get(order[i]?.id as string)
        if (next !== undefined) return next
      }
      for (let i = position - 1; i >= 0; i--) {
        const prev = slideIndex.get(order[i]?.id as string)
        if (prev !== undefined) return prev
      }
    }
  }
  return 0
}

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
  zoom: number
}

/**
 * Where a slide sits on screen once the camera has fitted it (tldraw `zoomToBounds` with inset 0: the
 * zoom that fits both sides, clamped to the camera's zoom range, centred). The presentation's surround
 * keeps this window fixed while the camera flies between slides.
 */
export function fittedSlideRect(
  bounds: SlideBox,
  viewport: { w: number; h: number },
  zoomRange: { min: number; max: number },
): ScreenRect {
  const w = Math.max(bounds.w, 1e-6)
  const h = Math.max(bounds.h, 1e-6)
  const fit = Math.min(viewport.w / w, viewport.h / h)
  const zoom = Math.max(zoomRange.min, Math.min(zoomRange.max, fit))
  const sw = w * zoom
  const sh = h * zoom
  return { x: (viewport.w - sw) / 2, y: (viewport.h - sh) / 2, w: sw, h: sh, zoom }
}

/** Moves by `delta` without wrapping (presentations stop at the first and last slide). */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1
  const next = (index < 0 ? 0 : index) + delta
  return Math.max(0, Math.min(count - 1, next))
}

/**
 * The index to show after the slide list changed under a running presentation (a collaborator added,
 * reordered, skipped or deleted frames): the same frame if it is still a slide, otherwise the slide that
 * now sits where it was (clamped), or -1 when no slides are left.
 */
export function reconcileIndex(
  previousIndex: number,
  currentId: TLShapeId | null,
  next: readonly Slide[],
): number {
  if (next.length === 0) return -1
  if (currentId) {
    const same = next.findIndex((s) => s.id === currentId)
    if (same >= 0) return same
  }
  return Math.max(0, Math.min(next.length - 1, previousIndex))
}

export interface PdfFramePick {
  frames: FrameEntry[]
  /** 'selection' when the user's selection contains frames; 'all' otherwise. */
  source: 'selection' | 'all'
  /** Top-level frames left out because they are marked "skip in presentation" (source 'all' only). */
  skippedCount: number
}

/**
 * Frames that become PDF pages. Selected frames (any depth) win, ordered by presentation order and then
 * outline order for nested ones; an explicit selection includes skipped frames. Without a frame selection
 * it is every top-level frame in presentation order, minus skipped ones unless `includeSkipped`.
 */
export function pickPdfFrames(
  order: readonly FrameEntry[],
  outline: readonly FrameEntry[],
  selectedIds: readonly TLShapeId[],
  shapeOf: (id: TLShapeId) => MetaCarrier | undefined,
  opts: { includeSkipped: boolean },
): PdfFramePick {
  const selected = new Set<string>(selectedIds)
  if (selected.size > 0) {
    const picked: FrameEntry[] = []
    const seen = new Set<string>()
    for (const entry of [...order, ...outline]) {
      if (!selected.has(entry.id) || seen.has(entry.id)) continue
      seen.add(entry.id)
      picked.push(entry)
    }
    if (picked.length > 0) return { frames: picked, source: 'selection', skippedCount: 0 }
  }
  const frames: FrameEntry[] = []
  let skippedCount = 0
  for (const entry of order) {
    if (isSkipped(shapeOf(entry.id))) {
      skippedCount++
      if (!opts.includeSkipped) continue
    }
    frames.push(entry)
  }
  return { frames, source: 'all', skippedCount }
}
