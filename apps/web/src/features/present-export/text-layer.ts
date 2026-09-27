// Pure: which text a PDF page's hidden text layer gets for a shape, and roughly where tldraw draws it
// (font size from the size style, alignment, padding). Positions only need to be close: the layer makes
// pages searchable and copyable, the visible text is the rendered image.
import type { TLShape } from 'tldraw'
import { extractSearchableText } from './board-ops.ts'

export type TextAlign = 'start' | 'middle' | 'end'

export interface TextBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PlacedText {
  text: string
  x: number
  y: number
  w: number
  h: number
  fontSizePx: number
  align: TextAlign
  verticalAlign: TextAlign
  /** Padding between the shape's edge and its text, board px. */
  inset: number
}

// tldraw 5.4.2 size styles in px (FONT_SIZES / LABEL_FONT_SIZES / ARROW_LABEL_FONT_SIZES × 16; internal constants).
const TEXT_PX: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }
const LABEL_PX: Record<string, number> = { s: 18, m: 22, l: 26, xl: 32 }
const ARROW_LABEL_PX: Record<string, number> = { s: 18, m: 20, l: 24, xl: 28 }
const DEFAULT_PX = 16

const SKIP = new Set(['frame', 'group', 'draw', 'highlight', 'line', 'image', 'video'])

function props(shape: TLShape): Record<string, unknown> {
  const p = shape.props as unknown
  return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {}
}

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback

function alignOf(v: unknown, fallback: TextAlign): TextAlign {
  if (typeof v !== 'string') return fallback
  if (v.startsWith('start')) return 'start'
  if (v.startsWith('end')) return 'end'
  if (v.startsWith('middle')) return 'middle'
  return fallback
}

/**
 * The hidden-text item for one shape, relative to `origin` (the page's top-left in page space), or null
 * when the shape has no text worth indexing. Frames are skipped (their titles are not drawn on pages).
 */
export function placedTextFor(
  shape: TLShape,
  bounds: TextBox,
  origin: { x: number; y: number },
): PlacedText | null {
  if (SKIP.has(shape.type)) return null
  const text = extractSearchableText(shape).trim()
  if (!text) return null
  const p = props(shape)
  const size = typeof p.size === 'string' ? p.size : 'm'
  const scale = num(p.scale, 1)
  const base = { x: bounds.x - origin.x, y: bounds.y - origin.y, w: bounds.w, h: bounds.h, text }
  switch (shape.type) {
    case 'text':
      return {
        ...base,
        fontSizePx: (TEXT_PX[size] ?? DEFAULT_PX) * scale,
        align: alignOf(p.textAlign, 'start'),
        verticalAlign: 'start',
        inset: 0,
      }
    case 'note':
      return {
        ...base,
        fontSizePx: (LABEL_PX[size] ?? DEFAULT_PX) * scale * num(p.fontSizeAdjustment, 1),
        align: alignOf(p.align, 'middle'),
        verticalAlign: alignOf(p.verticalAlign, 'middle'),
        inset: 16 * scale,
      }
    case 'geo':
      return {
        ...base,
        fontSizePx: (LABEL_PX[size] ?? DEFAULT_PX) * scale,
        align: alignOf(p.align, 'middle'),
        verticalAlign: alignOf(p.verticalAlign, 'middle'),
        inset: 16 * scale,
      }
    case 'arrow':
      return {
        ...base,
        fontSizePx: (ARROW_LABEL_PX[size] ?? DEFAULT_PX) * scale,
        align: 'middle',
        verticalAlign: 'middle',
        inset: 0,
      }
    default:
      // File cards, bookmarks, embeds and custom shapes: their name/title at the top-left.
      return { ...base, fontSizePx: 14, align: 'start', verticalAlign: 'start', inset: 12 }
  }
}
