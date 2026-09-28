// The simplified thumbnail for boards with more than a few dozen shapes (browser only). tldraw's
// export inlines every text shape's styles on the main thread (measured: ~3 ms per sticky note,
// one ~1 s task for 300 notes, ~3 s for 1,000), which would stall the canvas. At card size (a board
// of that size is drawn at a small fraction of 100%) text is unreadable anyway, so this draws each
// shape's own geometry and colours straight onto a 2D canvas instead: frames, notes, shapes, strokes
// and arrows in their theme colours, image previews, and grey bars where there is text. It costs a
// few milliseconds for hundreds of shapes. Paint order follows the board's (frames clip their
// children), light mode like the board canvas.

import {
  type Editor,
  type Geometry2d,
  Group2d,
  getColorValue,
  type TLImageAsset,
  type TLShape,
  type TLShapeId,
  type TLThemeColors,
} from 'tldraw'
import type { ThumbnailFrame } from './plan.ts'

/** tldraw 5.4.2's stroke widths (STROKE_SIZES) per size style, in page units at scale 1. */
const STROKE: Record<string, number> = { s: 1, m: 1.75, l: 2.5, xl: 5 }
/** Image previews drawn at most (the rest are grey tiles); each is one small derivative request. */
const MAX_IMAGES = 60
const IMAGE_TIMEOUT_MS = 3000
const TILE = '#e7e9ee'
const TILE_LINE = '#c9cdd6'

type Props = Record<string, unknown>
const propsOf = (s: TLShape) => s.props as Props
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Whether a TipTap document holds any text. */
function hasText(doc: unknown, depth = 0): boolean {
  if (!doc || typeof doc !== 'object' || depth > 20) return false
  const n = doc as { text?: unknown; content?: unknown }
  if (typeof n.text === 'string' && n.text.trim()) return true
  return Array.isArray(n.content) && n.content.some((c) => hasText(c, depth + 1))
}

/** The outline(s) that draw the shape, without labels and internal helpers. */
function outlines(g: Geometry2d): Geometry2d[] {
  if (g instanceof Group2d) return g.children.flatMap(outlines)
  return g.isLabel || g.isInternal || g.ignore ? [] : [g]
}

function tracePath(ctx: CanvasRenderingContext2D, g: Geometry2d): boolean {
  const v = g.vertices
  if (v.length < 2) return false
  ctx.beginPath()
  ctx.moveTo(v[0]?.x ?? 0, v[0]?.y ?? 0)
  for (let i = 1; i < v.length; i++) ctx.lineTo(v[i]?.x ?? 0, v[i]?.y ?? 0)
  if (g.isClosed) ctx.closePath()
  return true
}

/** Grey bars standing in for lines of text inside (x, y, w, h). */
function textBars(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string) {
  const lines = Math.max(1, Math.min(3, Math.floor(h / 40)))
  const bar = Math.max(4, Math.min(14, h / (lines * 3)))
  const gap = bar * 1.2
  const total = lines * bar + (lines - 1) * gap
  ctx.save()
  ctx.globalAlpha *= 0.35
  ctx.fillStyle = colour
  let top = y + (h - total) / 2
  for (let i = 0; i < lines; i++) {
    const len = w * (i === lines - 1 && lines > 1 ? 0.55 : 0.8)
    ctx.fillRect(x + (w - len) / 2, top, len, bar)
    top += bar + gap
  }
  ctx.restore()
}

function fillFor(colors: TLThemeColors, color: string, fill: string): string | null {
  switch (fill) {
    case 'none':
      return null
    case 'semi':
      return colors.solid
    case 'solid':
      return getColorValue(colors, color, 'semi')
    case 'pattern':
      return getColorValue(colors, color, 'pattern')
    case 'lined-fill':
      return getColorValue(colors, color, 'linedFill')
    default:
      return getColorValue(colors, color, 'fill')
  }
}

/** Loads the screen-sized previews of the image shapes in `ids` (bounded in count and time). */
async function loadImages(editor: Editor, ids: TLShapeId[], scale: number) {
  const out = new Map<TLShapeId, HTMLImageElement>()
  const wanted = ids
    .map((id) => editor.getShape(id))
    .filter((s): s is TLShape => s?.type === 'image')
    .slice(0, MAX_IMAGES)
  await Promise.all(
    wanted.map(async (shape) => {
      const assetId = propsOf(shape).assetId
      if (typeof assetId !== 'string') return
      const asset = editor.getAsset(assetId as TLImageAsset['id'])
      const w = num(propsOf(shape).w, 0)
      const assetW = asset?.type === 'image' ? asset.props.w : 0
      try {
        const url = await editor.resolveAssetUrl(assetId as TLImageAsset['id'], {
          screenScale: assetW > 0 ? scale * (w / assetW) : scale,
          shouldResolveToOriginal: false,
          dpr: 1,
        })
        if (!url) return
        const img = new Image()
        img.decoding = 'async'
        img.src = url
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), IMAGE_TIMEOUT_MS),
        )
        await Promise.race([img.decode(), timeout])
        out.set(shape.id, img)
      } catch {
        // a grey tile instead
      }
    }),
  )
  return out
}

export async function renderSchematic(
  editor: Editor,
  ids: TLShapeId[],
  frame: ThumbnailFrame,
): Promise<HTMLCanvasElement | null> {
  const all = [...editor.getShapeAndDescendantIds(ids)]
  const images = await loadImages(editor, all, frame.scale)
  return drawSchematic(editor, ids, frame, images)
}

/**
 * The drawing itself, synchronous: usable while the board is closing (F11), when nothing can be
 * awaited any more. Image shapes without a loaded preview in `images` are grey tiles.
 */
export function drawSchematic(
  editor: Editor,
  ids: TLShapeId[],
  frame: ThumbnailFrame,
  images: ReadonlyMap<TLShapeId, HTMLImageElement> = new Map(),
): HTMLCanvasElement | null {
  const { box, scale, width, height } = frame
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const colors = editor.getCurrentTheme().colors.light
  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, width, height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  /** At least one card pixel wide, whatever the zoom. */
  const minLine = 1 / scale

  const place = (id: TLShapeId) => {
    const m = editor.getShapePageTransform(id)
    ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale)
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
  }

  const drawShape = (id: TLShapeId) => {
    if (editor.isShapeHidden(id)) return
    const shape = editor.getShape(id)
    if (!shape) return
    const p = propsOf(shape)
    const color = str(p.color, 'black')
    const size = STROKE[str(p.size, 'm')] ?? 1.75
    const shapeScale = num(p.scale, 1)
    // Everything that can throw happens before the canvas state is saved: one odd shape (say, from a
    // newer client) is left out instead of costing the whole thumbnail or unbalancing save/restore.
    let geometry: Geometry2d
    try {
      geometry = editor.getShapeGeometry(shape)
    } catch {
      return
    }
    const b = geometry.bounds
    ctx.save()
    ctx.globalAlpha = num(shape.opacity, 1)
    place(id)
    const children = editor.getSortedChildIdsForParent(id)

    switch (shape.type) {
      case 'frame': {
        ctx.fillStyle = getColorValue(colors, color, 'frameFill')
        ctx.strokeStyle = getColorValue(colors, color, 'frameStroke')
        ctx.lineWidth = Math.max(1, minLine)
        ctx.fillRect(b.x, b.y, b.w, b.h)
        ctx.strokeRect(b.x, b.y, b.w, b.h)
        // Children are clipped to the frame, as on the board.
        ctx.beginPath()
        ctx.rect(b.x, b.y, b.w, b.h)
        ctx.clip()
        for (const c of children) drawShape(c)
        ctx.restore()
        return
      }
      case 'group':
        ctx.restore()
        for (const c of children) drawShape(c)
        return
      case 'note': {
        ctx.fillStyle = getColorValue(colors, color, 'noteFill')
        ctx.fillRect(b.x, b.y, b.w, b.h)
        if (hasText(p.richText))
          textBars(ctx, b.x + b.w * 0.1, b.y, b.w * 0.8, b.h, getColorValue(colors, color, 'noteText'))
        break
      }
      case 'geo': {
        const fill = fillFor(colors, color, str(p.fill, 'none'))
        ctx.lineWidth = Math.max(size * shapeScale, minLine)
        ctx.strokeStyle = getColorValue(colors, color, 'solid')
        for (const g of outlines(geometry)) {
          if (!tracePath(ctx, g)) continue
          if (fill && g.isClosed) {
            ctx.fillStyle = fill
            ctx.fill()
          }
          ctx.stroke()
        }
        if (hasText(p.richText)) textBars(ctx, b.x + b.w * 0.15, b.y, b.w * 0.7, b.h, colors.text)
        break
      }
      case 'text':
        textBars(ctx, b.x, b.y, b.w, b.h, getColorValue(colors, color, 'solid'))
        break
      case 'highlight':
        ctx.globalAlpha *= 0.5
        ctx.strokeStyle = getColorValue(colors, color, 'highlightSrgb')
        ctx.lineWidth = Math.max(size * shapeScale * 6, minLine)
        for (const g of outlines(geometry)) if (tracePath(ctx, g)) ctx.stroke()
        break
      case 'draw':
      case 'line':
      case 'arrow': {
        ctx.strokeStyle = getColorValue(colors, color, 'solid')
        ctx.lineWidth = Math.max(size * shapeScale * 1.5, minLine)
        const fill = shape.type === 'draw' ? fillFor(colors, color, str(p.fill, 'none')) : null
        for (const g of outlines(geometry)) {
          if (!tracePath(ctx, g)) continue
          if (fill && g.isClosed) {
            ctx.fillStyle = fill
            ctx.fill()
          }
          ctx.stroke()
        }
        break
      }
      case 'image': {
        const img = images.get(id)
        if (img) ctx.drawImage(img, b.x, b.y, b.w, b.h)
        else {
          ctx.fillStyle = TILE
          ctx.fillRect(b.x, b.y, b.w, b.h)
        }
        break
      }
      default: {
        // File cards, videos, embeds, bookmarks and anything else: a tile of its size.
        ctx.fillStyle = TILE
        ctx.strokeStyle = TILE_LINE
        ctx.lineWidth = Math.max(1, minLine)
        ctx.fillRect(b.x, b.y, b.w, b.h)
        ctx.strokeRect(b.x, b.y, b.w, b.h)
      }
    }
    ctx.restore()
    for (const c of children) drawShape(c)
  }

  for (const id of ids) drawShape(id)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return canvas
}
