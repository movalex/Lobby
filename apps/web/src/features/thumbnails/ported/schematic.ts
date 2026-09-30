// The simplified thumbnail on the Excalidraw page (the port of ../schematic.ts): each element's own
// geometry and colours drawn straight onto a 2D canvas (frames, notes, shapes, strokes and arrows, grey
// bars where there is text, image tiles), a few milliseconds for hundreds of elements, synchronously when
// the board is closing (F11). Paint order is the board's; a frame's children are clipped to it; light
// mode like the board canvas. Elements hold literal colours on the new canvas, so there is no theme
// lookup: what is stored is what is drawn.
import type { CanvasElement } from '../../../canvas/api/index.ts'
import type { ThumbnailFrame } from '../plan.ts'

const BACKGROUND = '#ffffff'
const FRAME_STROKE = '#bbb'
const INK = '#1b2330'
const TILE = '#e7e9ee'
const TILE_LINE = '#c9cdd6'
/** A file card's footer (name, size) under its cover, in scene units (styles.css .dr-fc__footer). */
const CARD_FOOTER = 56

type El = CanvasElement & {
  readonly strokeColor?: string
  readonly backgroundColor?: string
  readonly strokeWidth?: number
  readonly opacity?: number
  readonly points?: readonly (readonly [number, number])[]
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
  readonly originalText?: string
  readonly isDeleted?: boolean
}

const colour = (c: unknown, fallback: string) =>
  typeof c === 'string' && c && c !== 'transparent' ? c : fallback
const filled = (c: unknown) => typeof c === 'string' && c !== '' && c !== 'transparent'

/** Grey bars standing in for lines of text inside (x, y, w, h). */
function textBars(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string) {
  const lines = Math.max(1, Math.min(3, Math.floor(h / 40)))
  const bar = Math.max(4, Math.min(14, h / (lines * 3)))
  const gap = bar * 1.2
  const total = lines * bar + (lines - 1) * gap
  ctx.save()
  ctx.globalAlpha *= 0.35
  ctx.fillStyle = ink
  let top = y + (h - total) / 2
  for (let i = 0; i < lines; i++) {
    const len = w * (i === lines - 1 && lines > 1 ? 0.55 : 0.8)
    ctx.fillRect(x + (w - len) / 2, top, len, bar)
    top += bar + gap
  }
  ctx.restore()
}

/** Draws `img` letterboxed (object-fit: contain) inside (x, y, w, h). */
function drawContained(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number },
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = img.naturalWidth || w
  const ih = img.naturalHeight || h
  const k = Math.min(w / iw, h / ih)
  ctx.drawImage(img, x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k)
}

/**
 * The drawing itself, synchronous. `elements`: the live, visible elements of the area in paint order
 * (labels included: they are drawn as their container's bars). Image elements without a loaded preview
 * in `images` are grey tiles.
 */
export function drawSchematic(
  elements: readonly CanvasElement[],
  frame: ThumbnailFrame,
  images: ReadonlyMap<
    string,
    CanvasImageSource & { naturalWidth?: number; naturalHeight?: number }
  > = new Map(),
): HTMLCanvasElement | null {
  const { box, scale, width, height } = frame
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, width, height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  /** At least one card pixel wide, whatever the zoom. */
  const minLine = 1 / scale
  const byId = new Map(elements.map((e) => [e.id, e as El]))
  const labelText = (el: El) => {
    const ref = (el.boundElements ?? []).find((b) => b.type === 'text')
    const label = ref ? byId.get(ref.id) : undefined
    return label?.originalText?.trim() ? label : null
  }

  const place = (el: El) => {
    ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale)
    if (el.angle) {
      const cx = el.x + el.width / 2
      const cy = el.y + el.height / 2
      ctx.translate(cx, cy)
      ctx.rotate(el.angle)
      ctx.translate(-cx, -cy)
    }
  }

  const clipToFrame = (el: El) => {
    const f = el.frameId ? byId.get(el.frameId) : undefined
    if (f?.type !== 'frame') return
    ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale)
    ctx.beginPath()
    ctx.rect(f.x, f.y, f.width, f.height)
    ctx.clip()
  }

  const draw = (el: El) => {
    // Labels are their container's bars; bound text never draws alone.
    if (el.type === 'text' && el.containerId) return
    const stroke = colour(el.strokeColor, INK)
    const lineWidth = Math.max(typeof el.strokeWidth === 'number' ? el.strokeWidth : 1, minLine)
    const { x, y, width: w, height: h } = el
    ctx.save()
    ctx.globalAlpha = typeof el.opacity === 'number' ? Math.max(0, Math.min(1, el.opacity / 100)) : 1
    clipToFrame(el)
    place(el)
    switch (el.type) {
      case 'frame':
        ctx.strokeStyle = FRAME_STROKE
        ctx.lineWidth = Math.max(1, minLine)
        ctx.strokeRect(x, y, w, h)
        break
      case 'stickynote': {
        ctx.fillStyle = colour(el.backgroundColor, '#f8e48f')
        ctx.fillRect(x, y, w, h)
        const label = labelText(el)
        if (label) textBars(ctx, x + w * 0.1, y, w * 0.8, h, colour(label.strokeColor, INK))
        break
      }
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        ctx.beginPath()
        if (el.type === 'rectangle') ctx.rect(x, y, w, h)
        else if (el.type === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
        else {
          ctx.moveTo(x + w / 2, y)
          ctx.lineTo(x + w, y + h / 2)
          ctx.lineTo(x + w / 2, y + h)
          ctx.lineTo(x, y + h / 2)
          ctx.closePath()
        }
        if (filled(el.backgroundColor)) {
          ctx.fillStyle = el.backgroundColor as string
          ctx.fill()
        }
        ctx.strokeStyle = stroke
        ctx.lineWidth = lineWidth
        ctx.stroke()
        const label = labelText(el)
        if (label) textBars(ctx, x + w * 0.15, y, w * 0.7, h, colour(label.strokeColor, INK))
        break
      }
      case 'text':
        textBars(ctx, x, y, w, h, stroke)
        break
      case 'arrow':
      case 'line':
      case 'freedraw': {
        const pts = el.points ?? []
        if (pts.length < 2) break
        const highlight = (el.customData?.lobby as { kind?: unknown } | undefined)?.kind === 'highlight'
        if (highlight) ctx.globalAlpha *= 0.5
        ctx.strokeStyle = stroke
        ctx.lineWidth = highlight ? lineWidth * 6 : el.type === 'freedraw' ? lineWidth * 1.5 : lineWidth
        ctx.beginPath()
        ctx.moveTo(x + (pts[0]?.[0] ?? 0), y + (pts[0]?.[1] ?? 0))
        for (let i = 1; i < pts.length; i++) ctx.lineTo(x + (pts[i]?.[0] ?? 0), y + (pts[i]?.[1] ?? 0))
        ctx.stroke()
        break
      }
      case 'image': {
        const kind = (el.customData?.lobby?.file as { kind?: unknown } | undefined)?.kind
        const img = images.get(el.id)
        if (kind && kind !== 'image') {
          // F1: a file card's cover (PDF first page, video poster) above its footer, as on the board.
          ctx.lineWidth = Math.max(1, minLine)
          ctx.fillStyle = BACKGROUND
          ctx.fillRect(x, y, w, h)
          const top = Math.max(0, h - CARD_FOOTER)
          ctx.fillStyle = TILE
          ctx.fillRect(x, y, w, top)
          if (img && top > 0) drawContained(ctx, img, x, y, w, top)
          ctx.strokeStyle = TILE_LINE
          ctx.strokeRect(x, y, w, h)
        } else if (img) ctx.drawImage(img, x, y, w, h)
        else {
          ctx.fillStyle = TILE
          ctx.fillRect(x, y, w, h)
        }
        break
      }
      default:
        ctx.fillStyle = TILE
        ctx.strokeStyle = TILE_LINE
        ctx.lineWidth = Math.max(1, minLine)
        ctx.fillRect(x, y, w, h)
        ctx.strokeRect(x, y, w, h)
    }
    ctx.restore()
  }

  for (const el of elements) {
    try {
      draw(el as El)
    } catch {
      // one odd element (say, from a newer client) is left out instead of costing the whole thumbnail
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return canvas
}
