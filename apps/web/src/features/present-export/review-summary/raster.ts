// OWNER: WS4 (wave S, the review summary PDF). The image fallback of a summary page: when the vector path cannot
// draw a page (no font engine, an environment without OffscreenCanvas for a glyph picture…), the page is drawn on a
// canvas and added as an image page with the same invisible text layer the report pages have (present-export's
// pdf-build addPage), so the text still searches. Browser only (DOM canvas); `pageTexts` is pure.
import type { PdfTextItem } from '../pdf-build.ts'
import type { MeasureText, Op, SummaryPage } from './layout.ts'

/** Pixels per page px a fallback page is drawn at. */
export const RASTER_SCALE = 2

const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif'
export const fontOf = (size: number, bold: boolean) => `${bold ? 'bold ' : ''}${size}px ${FONT}`

/** The page's text as the hidden layer of an image page: every line as laid out, never wrapped again. */
export function pageTexts(page: SummaryPage, measure: MeasureText): PdfTextItem[] {
  const out: PdfTextItem[] = []
  for (const op of page.ops) {
    if (op.t !== 'text' || !op.text.trim()) continue
    const h = op.size * 1.38
    out.push({
      text: op.text,
      x: op.x,
      y: op.y - (h - op.size) / 2 - op.size * 0.8,
      w: Math.max(1, measure(op.text, op.size, op.bold)),
      h,
      fontSizePx: op.size,
      align: 'start',
      verticalAlign: 'start',
      inset: 0,
      lines: true,
      lineHeight: h / op.size,
    })
  }
  return out
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** The page drawn as a PNG (white paper, each operation in paint order). */
export async function pageToPng(page: SummaryPage): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(page.width * RASTER_SCALE)
  canvas.height = Math.round(page.height * RASTER_SCALE)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('the browser cannot draw a page here')
  ctx.scale(RASTER_SCALE, RASTER_SCALE)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, page.width, page.height)
  ctx.textBaseline = 'alphabetic'
  const draw = async (op: Op) => {
    if (op.t === 'rect') {
      ctx.fillStyle = op.fill
      ctx.fillRect(op.x, op.y, op.w, op.h)
      if (op.stroke) {
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = 1
        ctx.strokeRect(op.x + 0.5, op.y + 0.5, op.w - 1, op.h - 1)
      }
    } else if (op.t === 'text') {
      ctx.font = fontOf(op.size, op.bold)
      ctx.fillStyle = op.fill
      ctx.fillText(op.text, op.x, op.y)
    } else {
      const img = await loadImage(op.dataUrl)
      if (img) ctx.drawImage(img, op.x, op.y, op.w, op.h)
    }
  }
  for (const op of page.ops) await draw(op)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas gave no image'))), 'image/png'),
  )
  return new Uint8Array(await blob.arrayBuffer())
}

/** Measures text in the page's font with a canvas (Helvetica's widths, the PDF's font, with a hair of safety). */
export function canvasMeasure(): MeasureText {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return (text, size, bold) => {
    if (!ctx) return text.length * size * (bold ? 0.6 : 0.56)
    ctx.font = fontOf(size, bold)
    return ctx.measureText(text).width * 1.02
  }
}
