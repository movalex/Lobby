// Size estimates for laying out templates without a DOM (and for the layout tests).
// Constants mirror tldraw 5.4.2 (tldraw/src/lib/shapes/shared/default-shape-constants.ts,
// NoteShapeUtil display values, TLTheme fontSize 16 / lineHeight 1.35). Text is measured
// by the editor at render time, so heights here are deliberately conservative estimates.

import type { TLDefaultSizeStyle, TLShape } from '@tldraw/tlschema'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** tldraw note shapes are 200 x 200 (times `scale`), plus `growY`. */
export const NOTE_SIZE = 200
/** Padding around note and geo labels (LABEL_PADDING). */
export const LABEL_PADDING = 16
const BASE_FONT_SIZE = 16
export const LINE_HEIGHT = 1.35
/** Average glyph advance in ems. IBM Plex Sans averages ~0.5em; 0.6 over-estimates on purpose. */
const AVG_CHAR_EM = 0.6

/** Text shape font sizes (FONT_SIZES x theme font size). */
export const TEXT_FONT_PX: Record<TLDefaultSizeStyle, number> = {
  s: BASE_FONT_SIZE * 1.125,
  m: BASE_FONT_SIZE * 1.5,
  l: BASE_FONT_SIZE * 2.25,
  xl: BASE_FONT_SIZE * 2.75,
}

/** Note and geo label font sizes (LABEL_FONT_SIZES x theme font size). */
export const LABEL_FONT_PX: Record<TLDefaultSizeStyle, number> = {
  s: BASE_FONT_SIZE * 1.125,
  m: BASE_FONT_SIZE * 1.375,
  l: BASE_FONT_SIZE * 1.625,
  xl: BASE_FONT_SIZE * 2,
}

/** Greedy word-wrap estimate of how many lines `text` needs at `fontPx` within `maxWidth`. */
export function estimateLineCount(text: string, fontPx: number, maxWidth: number): number {
  const charsPerLine = Math.max(1, Math.floor(maxWidth / (fontPx * AVG_CHAR_EM)))
  let lines = 0
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0)
    if (words.length === 0) {
      lines += 1
      continue
    }
    let current = 0
    lines += 1
    for (const word of words) {
      // Long words break (overflow-wrap), taking whole extra lines.
      if (word.length > charsPerLine) {
        if (current > 0) lines += 1
        const extra = Math.ceil(word.length / charsPerLine)
        lines += extra - 1
        current = word.length % charsPerLine || charsPerLine
        continue
      }
      const needed = current === 0 ? word.length : current + 1 + word.length
      if (needed > charsPerLine) {
        lines += 1
        current = word.length
      } else {
        current = needed
      }
    }
  }
  return lines
}

export function estimateTextHeight(text: string, fontPx: number, maxWidth: number): number {
  return estimateLineCount(text, fontPx, maxWidth) * fontPx * LINE_HEIGHT
}

/** Plain text of a TipTap/ProseMirror rich-text doc (paragraphs joined by \n). Never throws. */
export function plainTextOfRichText(richText: unknown): string {
  const paragraphs: string[] = []
  const collect = (node: unknown, depth: number): string => {
    if (depth > 32 || node === null || typeof node !== 'object') return ''
    const n = node as { text?: unknown; content?: unknown }
    if (typeof n.text === 'string') return n.text
    if (!Array.isArray(n.content)) return ''
    return n.content.map((child) => collect(child, depth + 1)).join('')
  }
  if (richText === null || typeof richText !== 'object') return ''
  const content = (richText as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  for (const block of content) paragraphs.push(collect(block, 1))
  return paragraphs.join('\n')
}

/**
 * Estimated local bounds of a shape in its parent's coordinate space (rotation 0).
 * Text heights are estimates; arrows use their stored start/end points.
 */
export function estimateShapeRect(shape: TLShape): Rect {
  switch (shape.type) {
    case 'frame':
      return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h }
    case 'geo':
      return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h + shape.props.growY }
    case 'note': {
      const s = shape.props.scale
      return { x: shape.x, y: shape.y, w: NOTE_SIZE * s, h: (NOTE_SIZE + shape.props.growY) * s }
    }
    case 'text': {
      const s = shape.props.scale
      const text = plainTextOfRichText(shape.props.richText)
      const h = estimateTextHeight(text, TEXT_FONT_PX[shape.props.size], shape.props.w)
      return { x: shape.x, y: shape.y, w: shape.props.w * s, h: h * s }
    }
    case 'arrow': {
      const { start, end } = shape.props
      const x0 = Math.min(start.x, end.x)
      const y0 = Math.min(start.y, end.y)
      return {
        x: shape.x + x0,
        y: shape.y + y0,
        w: Math.abs(end.x - start.x),
        h: Math.abs(end.y - start.y),
      }
    }
    default: {
      const props = shape.props as { w?: unknown; h?: unknown }
      const w = typeof props.w === 'number' ? props.w : 0
      const h = typeof props.h === 'number' ? props.h : 0
      return { x: shape.x, y: shape.y, w, h }
    }
  }
}

export function unionRects(rects: Iterable<Rect>): Rect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let any = false
  for (const r of rects) {
    any = true
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return any ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null
}
