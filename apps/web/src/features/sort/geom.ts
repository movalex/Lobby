// What the sort feature needs to know about where things are, read from the elements' own fields (never
// `canvas.bounds`, which the port answers with a scan of the board per call, CR 3b-7: these run over every
// element near the notes). Pure over CanvasElement.
import { type CanvasElement, geometry } from '../../canvas/api/index.ts'
import type { Rect } from './layout.ts'

/** Room kept above a frame for its name label (a frame's name sits just over its top edge). */
export const FRAME_LABEL_BAND = 40

export const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted
export const isNote = (el: CanvasElement | undefined): el is CanvasElement => !!el && el.type === 'stickynote'
export const isFrame = (el: CanvasElement | undefined): el is CanvasElement => !!el && el.type === 'frame'
export const isBoundLabel = (el: CanvasElement) => el.type === 'text' && !!el.containerId

/**
 * The axis-aligned scene box of an element: its rectangle (rotation included), or a linear element's points.
 * The engine rotates an element about the centre of its unrotated box, so the corners are exact.
 */
export function boxOf(el: CanvasElement): Rect {
  const points = (el as { points?: readonly (readonly [number, number])[] }).points
  if (Array.isArray(points) && points.length) {
    const xs = points.map((p) => p[0])
    const ys = points.map((p) => p[1])
    const x0 = Math.min(...xs)
    const y0 = Math.min(...ys)
    return { x: el.x + x0, y: el.y + y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
  }
  if (!el.angle) return { x: el.x, y: el.y, w: el.width, h: el.height }
  const b = geometry.fromPoints(
    geometry.corners({ x: el.x, y: el.y, width: el.width, height: el.height }, el.angle),
  )
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: el.x, y: el.y, w: el.width, h: el.height }
}

export const translateRect = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy })

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The room a frame's name needs over its top edge is no place for anything else. */
export function withNameBand(frameBox: Rect): Rect {
  return { ...frameBox, y: frameBox.y - FRAME_LABEL_BAND, h: frameBox.h + FRAME_LABEL_BAND }
}

/** Greedy word wrap of `text` to `maxWidth` (a word longer than a line is cut where it no longer fits). */
export function wrapLines(
  measure: (line: string) => number,
  text: string,
  maxWidth: number | null,
): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (maxWidth === null || measure(next) <= maxWidth) {
        line = next
        continue
      }
      if (line) out.push(line)
      let rest = word
      while (maxWidth !== null && rest.length > 1 && measure(rest) > maxWidth) {
        let n = rest.length - 1
        while (n > 1 && measure(rest.slice(0, n)) > maxWidth) n--
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

export interface TextBlock {
  /** the words as the element stores them (wrapped) */
  readonly text: string
  readonly width: number
  readonly height: number
}

/** Lobby's sans (Nunito), the font of a heading. */
export const LABEL_FONT_FAMILY = 6
/** A column heading's size (tldraw's `m`, as the theme labels). */
export const LABEL_FONT_SIZE = 24
/** A column heading's line gap: added to its measured height. */
export const LABEL_PAD = 4

export type Measure = (
  text: string,
  style: { fontFamily: number; fontSize: number },
) => {
  width: number
  height: number
}

/** `text` wrapped to `maxWidth` and measured with the canvas's text metrics. */
export function layoutLabel(measure: Measure, text: string, maxWidth: number | null): TextBlock {
  const style = { fontFamily: LABEL_FONT_FAMILY, fontSize: LABEL_FONT_SIZE }
  const lines = wrapLines((l) => measure(l, style).width, text, maxWidth)
  const wrapped = lines.join('\n')
  const m = measure(wrapped || ' ', style)
  return { text: wrapped, width: Math.ceil(m.width), height: Math.ceil(m.height) }
}
