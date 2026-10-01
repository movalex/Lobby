// OWNER: 3g. W5-14 (with 3e and 2C): a file card's face as a BITMAP, for exports and thumbnails. On the
// canvas the face is a DOM overlay (./CardLayer.tsx) over the engine's image element, so a PNG export only
// saw the element's bitmap: a PDF's bare cover, a video's bare poster, a grey tile for an attachment, with
// no name, size, page count or play button (plan §2.10.4's "client-drawn card": icon, name, size).
//
// `drawCardFace` draws today's card with the 2D canvas API: the cover (letterboxed) or the kind badge,
// the pages or duration chip, a play button for a video, the failure message, and the footer with the
// type badge, the name and the size and status, at the element's size and in the export's theme. Pure
// apart from the context it is given (unit-tested with a recording context). `cardFaceBlob` renders it
// to a PNG blob; the export's files map (canvas/export/scene.ts `exportFiles`, 2C; 3e's exporter) can
// hand that blob to the engine for the card's fileId instead of the bare cover (CR-W5-3G-5). Nothing
// here is stored or synced.
import type { AssetKind } from '../../assets/contract.ts'
import { extensionLabel, formatBytes, formatDuration, pluralize } from '../../lib/format.ts'
import { type CardView, cornerRadiusOf } from './model.ts'

/** The parts of a 2D context the face uses (CanvasRenderingContext2D and OffscreenCanvas's). */
export interface FaceContext {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  roundRect(x: number, y: number, w: number, h: number, r: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number): void
  fill(): void
  stroke(): void
  clip(): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): { width: number }
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void
}

export interface FaceTheme {
  readonly surface: string
  readonly inset: string
  readonly line: string
  readonly ink: string
  readonly ink2: string
  readonly danger: string
  readonly warn: string
}

/** Lobby's theme tokens (styles.css), light and dark: the face matches the export's theme. */
export const FACE_THEMES: Readonly<Record<'light' | 'dark', FaceTheme>> = {
  light: {
    surface: '#ffffff',
    inset: '#faf9f5',
    line: '#dcd8cc',
    ink: '#1b2330',
    ink2: '#4a5566',
    danger: '#a3211a',
    warn: '#7a4a00',
  },
  dark: {
    surface: '#1d2027',
    inset: '#171a20',
    line: '#323743',
    ink: '#ebe8e1',
    ink2: '#a9b1be',
    danger: '#ff9d92',
    warn: '#f2c46d',
  },
}

/** The footer badge colours (styles.css .dr-fc__icon--*): white text on each is at least 4.9:1. */
const BADGE: Readonly<Record<AssetKind, string>> = {
  pdf: '#b3261e',
  video: '#5b3cc4',
  image: '#0f766e',
  other: '#1f3a5f',
}
const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif'
const FOOTER_H = 56

export interface FaceInput {
  readonly view: CardView
  /** the element's size (scene units) and its corner radius (`roundness`) */
  readonly width: number
  readonly height: number
  readonly roundness?: { readonly type?: number; readonly value?: number } | null
  /** the decoded cover or poster, when there is one */
  readonly cover?: {
    readonly image: CanvasImageSource
    readonly width: number
    readonly height: number
  } | null
  readonly theme?: 'light' | 'dark'
}

/** What the status line says (CardLayer.tsx's statusText). */
export function statusLine(view: CardView): string {
  if (view.missing) return 'Unavailable'
  switch (view.status) {
    case 'loading':
      return 'Loading'
    case 'queued':
      return 'Queued'
    case 'processing':
      return 'Processing'
    case 'failed':
      return 'Preview failed'
    default:
      if (view.kind === 'pdf' && view.pageCount != null) return pluralize(view.pageCount, 'page')
      if (view.kind === 'video' && view.durationMs != null) return formatDuration(view.durationMs)
      return view.kind === 'other' ? 'Attachment' : 'Ready'
  }
}

/** `text` cut with an ellipsis to fit `max` px in the context's current font. */
export function fitText(ctx: Pick<FaceContext, 'measureText'>, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '…'
}

function chip(ctx: FaceContext, text: string, right: number, bottom: number) {
  ctx.font = `600 11.5px ${FONT}`
  const w = ctx.measureText(text).width + 14
  ctx.fillStyle = 'rgba(20, 24, 32, 0.78)'
  ctx.beginPath()
  ctx.roundRect(right - w, bottom - 22, w, 22, 6)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, right - w / 2, bottom - 11)
}

/** Draws the card face at (0, 0), `width` × `height`, in the context's units. */
export function drawCardFace(ctx: FaceContext, input: FaceInput): void {
  const { view, width: w, height: h } = input
  const t = FACE_THEMES[input.theme ?? 'light']
  const r = cornerRadiusOf({ width: w, height: h, roundness: input.roundness ?? null })
  ctx.save()
  // the card, clipped to its corners
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, r)
  ctx.clip()
  ctx.fillStyle = t.surface
  ctx.fillRect(0, 0, w, h)

  const attachment = view.kind === 'other' && view.status !== 'failed'
  const footerTop = attachment ? 0 : Math.max(0, h - FOOTER_H)
  if (!attachment) {
    // the preview area
    ctx.fillStyle = t.inset
    ctx.fillRect(0, 0, w, footerTop)
    const cover = view.status === 'ready' && !view.missing ? input.cover : null
    if (cover && cover.width > 0 && cover.height > 0) {
      const k = Math.min(w / cover.width, footerTop / cover.height)
      const cw = cover.width * k
      const ch = cover.height * k
      ctx.drawImage(cover.image, (w - cw) / 2, (footerTop - ch) / 2, cw, ch)
    } else {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `600 13px ${FONT}`
      ctx.fillStyle = view.status === 'failed' ? t.danger : t.ink2
      const message =
        view.status === 'failed'
          ? (view.errorMessage ?? 'Preview failed.')
          : view.missing
            ? 'Preview unavailable'
            : extensionLabel(view.name, view.kind)
      ctx.fillText(fitText(ctx, message, w - 24), w / 2, footerTop / 2)
    }
    if (view.kind === 'pdf' && view.pageCount != null && cover)
      chip(ctx, pluralize(view.pageCount, 'page'), w - 8, footerTop - 8)
    if (view.kind === 'video' && cover) {
      if (view.durationMs != null) chip(ctx, formatDuration(view.durationMs), w - 8, footerTop - 8)
      // the play button
      const cx = w / 2
      const cy = footerTop / 2
      ctx.fillStyle = 'rgba(20, 24, 32, 0.72)'
      ctx.beginPath()
      ctx.arc(cx, cy, 26, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(cx - 7, cy - 11)
      ctx.lineTo(cx - 7, cy + 11)
      ctx.lineTo(cx + 11, cy)
      ctx.closePath()
      ctx.fill()
    }
    // the footer's top line
    ctx.fillStyle = t.line
    ctx.fillRect(0, footerTop, w, 1)
  }

  // the footer: type badge, name, size · status
  const fh = attachment ? h : Math.min(FOOTER_H, h)
  const midY = footerTop + fh / 2
  ctx.fillStyle = BADGE[view.kind]
  ctx.beginPath()
  ctx.roundRect(10, midY - 19, 34, 38, 4)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 9.5px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(extensionLabel(view.name, view.kind), 27, midY, 30)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `600 13.5px ${FONT}`
  ctx.fillStyle = t.ink
  const textX = 54
  const room = Math.max(0, w - textX - 10)
  ctx.fillText(fitText(ctx, view.name || 'File', room), textX, midY - 3)
  ctx.font = `12px ${FONT}`
  ctx.fillStyle = view.status === 'failed' ? t.danger : t.ink2
  ctx.fillText(fitText(ctx, `${formatBytes(view.sizeBytes)} · ${statusLine(view)}`, room), textX, midY + 14)
  ctx.restore()
  // the outline, over everything
  ctx.save()
  ctx.strokeStyle = t.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1), Math.max(0, r - 0.5))
  ctx.stroke()
  ctx.restore()
}

/** The face as a PNG, `scale` device pixels per scene unit (an export's scale). Browser only. */
export async function cardFaceBlob(input: FaceInput, scale = 2): Promise<Blob> {
  const w = Math.max(1, Math.round(input.width * scale))
  const h = Math.max(1, Math.round(input.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d') as unknown as
    | (FaceContext & { scale(x: number, y: number): void })
    | null
  if (!ctx) throw new Error('no 2d context')
  ctx.scale(scale, scale)
  drawCardFace(ctx, input)
  return canvas.convertToBlob({ type: 'image/png' })
}
