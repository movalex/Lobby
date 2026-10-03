// OWNER: 3e (present + export), with 3g's card model. W5-14: exports draw file cards in full.
//
// On the Excalidraw canvas a file card (a PDF, video, Office document or other file) is an `image` element
// whose canvas face is the worker's cover or poster, and the card's face (name, size, kind badge, pages,
// duration, play button, page strip, conversion note) is a DOM overlay (file-card/ported/CardLayer.tsx).
// Exports never include overlays, so a PNG, SVG, PDF page or copy drew a bare cover, and a card with no
// cover (a zip, an encrypted PDF) the engine's grey placeholder. The tldraw page drew every card in full.
//
// Here the export draws the face itself, as tldraw's export did: for each card in an export, one bitmap of
// the whole card (the DOM face's layout and copy, without its controls: no Download, no "View pages")
// is made at export time and handed to the engine as that card's file in the export-only files map
// (canvas/export/scene.ts `exportFiles`, through the resolver this module wraps). The engine draws it in
// the element's box, so paint order, frames, rotation and clipping stay the engine's. Nothing is stored
// or synced; the bitmaps' blob: URLs are revoked when the export is done.
//
// Live facts come from the media feature's meta store (the page's one `AssetMetaStore`, already loaded for
// the cards on screen), the stable ones from `customData.lobby.file`, as on the canvas.
import { derivativeUrl } from '@draftroom/dev-assets/shared'
import type { MetaSnapshot } from '../../../assets/meta-store.ts'
import { coverDerivative, stripPages } from '../../../file-card/card-model.ts'
import { CONVERSION_NOTE, cardOfficeFormat, isConvertedPreview } from '../../../file-card/office.ts'
import {
  type CardView,
  cardViewOf,
  type FileFacts,
  factsOf,
  pageOfFileId,
} from '../../../file-card/ported/model.ts'
import { extensionLabel, formatBytes, formatDuration, pluralize } from '../../../lib/format.ts'
import type { Derivative, FileKey } from '../../files/loader.ts'

// ---- the layout (pure: unit-tested) ----------------------------------------------------------------------

/** The face's colours: the light theme's tokens (exports are light), file-card's CSS. */
export const FACE = {
  surface: '#ffffff',
  previewBg: '#f3f1ea',
  line: '#dcd8cc',
  ink: '#1b2330',
  ink2: '#4a5566',
  accentInk: '#1f3a5f',
  warn: '#7a4a00',
  danger: '#a3211a',
  dangerBg: '#fcebe9',
  chipBg: 'rgba(20, 24, 32, 0.78)',
  playBg: 'rgba(20, 24, 32, 0.72)',
  onDark: '#ffffff',
} as const

/** The footer's kind badge colours (styles.css `.dr-fc__icon--*`, file-card.css Office overrides). */
const ICON_BG: Readonly<Record<string, string>> = {
  pdf: '#b3261e',
  video: '#5b3cc4',
  image: '#0f766e',
  other: '#1f3a5f',
  docx: '#2b579a',
  odt: '#2b579a',
  pptx: '#c43e1c',
  odp: '#c43e1c',
  xlsx: '#217346',
  ods: '#217346',
}

const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
export const faceFont = (weight: number, px: number) => `${weight} ${px}px ${FONT_STACK}`

/** The card's parts, file-card's CSS in card units (one unit = one scene px). */
export const FOOTER_H = 56
const STRIP_H = 58
const NOTE_H = 24
const STRIP_MAX = 4
const PAD = 10
const ICON_W = 34
const ICON_H = 38
const NAME_PX = 13.5
const NAME_LINE = NAME_PX * 1.15
const META_PX = 12
const RADIUS = 10

export type FaceOp =
  | {
      readonly op: 'rect'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly fill: string
      /** corner radii (top-left, top-right, bottom-right, bottom-left) */
      readonly radius?: readonly [number, number, number, number]
      readonly stroke?: string
    }
  | {
      readonly op: 'line'
      readonly x1: number
      readonly y1: number
      readonly x2: number
      readonly y2: number
      readonly color: string
    }
  | {
      readonly op: 'circle'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly fill: string
    }
  | {
      readonly op: 'text'
      readonly text: string
      readonly x: number
      /** the line's vertical middle */
      readonly y: number
      readonly font: string
      readonly color: string
      readonly align: 'left' | 'center' | 'right'
    }
  | {
      readonly op: 'image'
      /** `cover`, or `page:<i>` for the strip's i-th page */
      readonly slot: string
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      /** `contain` (the cover, letterboxed) or `cover-top` (strip pages: filled, top-aligned) */
      readonly fit: 'contain' | 'cover-top'
    }
  /** an icon: an SVG path in a 24 × 24 box drawn at `size` */
  | {
      readonly op: 'icon'
      readonly d: string
      readonly x: number
      readonly y: number
      readonly size: number
      readonly fill?: string
      readonly stroke?: string
      readonly lineWidth?: number
    }

export interface FaceLayout {
  readonly width: number
  readonly height: number
  readonly ops: readonly FaceOp[]
}

export interface FaceInput {
  readonly view: CardView
  /** the Office format's extension (docx, pptx…) when the pages are a converted preview's, or null */
  readonly office: string | null
  readonly converted: boolean
  /** a decoded cover will be drawn (the card is ready and its cover could be read) */
  readonly hasCover: boolean
  /** strip pages that will be drawn, and the count of the PDF's other pages beyond them */
  readonly strip: number
  readonly more: number
}

/** Measures `text` in `font` (canvas `measureText`; tests pass a fake). */
export type Measure = (text: string, font: string) => number

/** `text` cut with an ellipsis until it fits `max`. */
export function ellipsize(text: string, max: number, font: string, measure: Measure): string {
  if (measure(text, font) <= max) return text
  const chars = Array.from(text)
  while (chars.length > 1 && measure(`${chars.join('').trimEnd()}…`, font) > max) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/**
 * Up to `maxLines` lines of `text` in `max` width: words first, a word too long for a line split
 * anywhere (`overflow-wrap: anywhere`), the last line cut with an ellipsis when more is left
 * (`line-clamp`, F2-09: the name wraps onto a second line before it is cut).
 */
export function wrapClamp(
  text: string,
  max: number,
  font: string,
  measure: Measure,
  maxLines: number,
): string[] {
  const fits = (s: string) => measure(s, font) <= max
  const lines: string[] = []
  let line = ''
  const tokens = text.split(/(\s+)/).filter((t) => t !== '')
  const push = () => {
    lines.push(line.trimEnd())
    line = ''
  }
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (line) line += ' '
      continue
    }
    if (fits(line + token)) {
      line += token
      continue
    }
    if (line.trim() && fits(token)) {
      push()
      line = token
      continue
    }
    for (const ch of Array.from(token)) {
      if (line && !fits(line + ch)) push()
      line += ch
    }
  }
  if (line.trim() || lines.length === 0) push()
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1] ?? ''}…`, max, font, measure).replace(/……$/, '…')
  return kept
}

/** The status line's words (CardLayer's `statusText`). */
export function statusText(view: CardView): string {
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

const PLAY = 'M8 5.5v13l10.5-6.5z'
const INFO = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.1'

/**
 * The face of a card `width` × `height` (card units), as the DOM face lays it out (CardLayer.tsx and
 * file-card's CSS): the preview (cover letterboxed, or the state: the kind badge and what the preview
 * is waiting for, or the error), the pages or duration chip, the play button, the page strip, the
 * conversion note and the footer (kind badge, name on up to two lines, size · status).
 */
export function cardFaceLayout(
  input: FaceInput,
  width: number,
  height: number,
  measure: Measure,
): FaceLayout {
  const { view } = input
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const ops: FaceOp[] = []
  ops.push({ op: 'rect', x: 0, y: 0, w, h, fill: FACE.surface, radius: [RADIUS, RADIUS, RADIUS, RADIUS] })

  const hasPreview = view.kind !== 'other' || view.status === 'failed'
  const showStrip = view.kind === 'pdf' && input.strip > 0
  const footerH = hasPreview ? Math.min(FOOTER_H, h) : h
  let bottom = h - footerH
  const noteTop = input.converted && !view.missing ? bottom - NOTE_H : null
  if (noteTop !== null) bottom = noteTop
  const stripTop = showStrip ? bottom - STRIP_H : null
  if (stripTop !== null) bottom = stripTop
  const previewH = Math.max(0, bottom)

  if (hasPreview && previewH > 0) {
    ops.push({ op: 'rect', x: 0, y: 0, w, h: previewH, fill: FACE.previewBg, radius: [RADIUS, RADIUS, 0, 0] })
    const chip = (text: string) => {
      const font = faceFont(600, 11.5)
      const cw = measure(text, font) + 14
      const ch = 20
      const x = w - 8 - cw
      const y = previewH - 8 - ch
      ops.push({ op: 'rect', x, y, w: cw, h: ch, fill: FACE.chipBg, radius: [6, 6, 6, 6] })
      ops.push({ op: 'text', text, x: x + cw / 2, y: y + ch / 2, font, color: FACE.onDark, align: 'center' })
    }
    if (view.status === 'failed') {
      // the error: a "!" and the message (the hint about downloading is the canvas's, not a picture's)
      const msgFont = faceFont(600, 13)
      const msg = wrapClamp(view.errorMessage ?? 'Preview failed.', Math.max(1, w - 32), msgFont, measure, 3)
      const blockH = 30 + 10 + msg.length * 16
      let y = Math.max(16, (previewH - blockH) / 2)
      ops.push({ op: 'circle', cx: w / 2, cy: y + 15, r: 15, fill: FACE.dangerBg })
      ops.push({
        op: 'text',
        text: '!',
        x: w / 2,
        y: y + 15,
        font: faceFont(800, 15),
        color: FACE.danger,
        align: 'center',
      })
      y += 40
      for (const line of msg) {
        ops.push({
          op: 'text',
          text: line,
          x: w / 2,
          y: y + 8,
          font: msgFont,
          color: FACE.danger,
          align: 'center',
        })
        y += 16
      }
    } else if (view.status !== 'ready' || !input.hasCover) {
      const word = view.missing
        ? 'Preview unavailable'
        : view.status === 'queued'
          ? 'Queued for preview…'
          : view.status === 'processing'
            ? 'Generating preview…'
            : view.status === 'ready'
              ? 'Preview unavailable'
              : 'Loading preview…'
      const msgFont = faceFont(400, 13)
      const msg = wrapClamp(word, Math.max(1, w - 32), msgFont, measure, 2)
      const blockH = 64 + 10 + msg.length * 16
      let y = Math.max(16, (previewH - blockH) / 2)
      const bx = w / 2 - 27
      ops.push({
        op: 'rect',
        x: bx,
        y,
        w: 54,
        h: 64,
        fill: FACE.surface,
        stroke: FACE.line,
        radius: [6, 16, 6, 6],
      })
      ops.push({
        op: 'text',
        text: extensionLabel(view.name, view.kind),
        x: w / 2,
        y: y + 32,
        font: faceFont(700, 12),
        color: FACE.accentInk,
        align: 'center',
      })
      y += 74
      for (const line of msg) {
        ops.push({
          op: 'text',
          text: line,
          x: w / 2,
          y: y + 8,
          font: msgFont,
          color: FACE.ink2,
          align: 'center',
        })
        y += 16
      }
      if (view.kind === 'pdf' && view.pageCount != null) chip(pluralize(view.pageCount, 'page'))
      if (view.kind === 'video' && view.durationMs != null) chip(formatDuration(view.durationMs))
    } else {
      ops.push({ op: 'image', slot: 'cover', x: 0, y: 0, w, h: previewH, fit: 'contain' })
      if (view.kind === 'pdf' && view.pageCount != null) chip(pluralize(view.pageCount, 'page'))
      if (view.kind === 'video') {
        if (view.durationMs != null) chip(formatDuration(view.durationMs))
        const r = Math.min(26, previewH / 2, w / 2)
        ops.push({ op: 'circle', cx: w / 2, cy: previewH / 2, r, fill: FACE.playBg })
        const s = (22 * r) / 26
        ops.push({
          op: 'icon',
          d: PLAY,
          x: w / 2 - s / 2 + (1.5 * r) / 26,
          y: previewH / 2 - s / 2,
          size: s,
          fill: FACE.onDark,
        })
      }
    }
  }

  if (stripTop !== null) {
    ops.push({ op: 'line', x1: 0, y1: stripTop + 0.5, x2: w, y2: stripTop + 0.5, color: FACE.line })
    let x = 8
    for (let i = 0; i < input.strip && x + ICON_W <= w - 8; i++) {
      ops.push({ op: 'image', slot: `page:${i}`, x, y: stripTop + 7, w: ICON_W, h: 44, fit: 'cover-top' })
      ops.push({
        op: 'rect',
        x,
        y: stripTop + 7,
        w: ICON_W,
        h: 44,
        fill: 'transparent',
        stroke: FACE.line,
        radius: [3, 3, 3, 3],
      })
      x += ICON_W + 6
    }
    if (input.more > 0)
      ops.push({
        op: 'text',
        text: `+${input.more}`,
        x,
        y: stripTop + STRIP_H / 2,
        font: faceFont(600, 12),
        color: FACE.ink2,
        align: 'left',
      })
  }

  if (noteTop !== null) {
    ops.push({ op: 'line', x1: 0, y1: noteTop + 0.5, x2: w, y2: noteTop + 0.5, color: FACE.line })
    ops.push({ op: 'icon', d: INFO, x: PAD, y: noteTop + 6, size: 12, stroke: FACE.ink2, lineWidth: 2.2 })
    const font = faceFont(400, 11)
    ops.push({
      op: 'text',
      text: ellipsize(CONVERSION_NOTE, Math.max(1, w - PAD * 2 - 17), font, measure),
      x: PAD + 17,
      y: noteTop + NOTE_H / 2,
      font,
      color: FACE.ink2,
      align: 'left',
    })
  }

  // the footer: kind badge, name (two lines at most), size · status
  const footerTop = h - footerH
  if (hasPreview)
    ops.push({ op: 'line', x1: 0, y1: footerTop + 0.5, x2: w, y2: footerTop + 0.5, color: FACE.line })
  const iconY = footerTop + (footerH - ICON_H) / 2
  ops.push({
    op: 'rect',
    x: PAD,
    y: iconY,
    w: ICON_W,
    h: ICON_H,
    fill: ICON_BG[input.office ?? ''] ?? ICON_BG[view.kind] ?? ICON_BG.other ?? FACE.accentInk,
    radius: [4, 10, 4, 4],
  })
  ops.push({
    op: 'text',
    text: extensionLabel(view.name, view.kind),
    x: PAD + ICON_W / 2,
    y: iconY + ICON_H / 2,
    font: faceFont(700, 9.5),
    color: FACE.onDark,
    align: 'center',
  })
  const textX = PAD + ICON_W + PAD
  const textW = Math.max(1, w - textX - PAD)
  const nameFont = faceFont(600, NAME_PX)
  const name = wrapClamp(view.name || 'File', textW, nameFont, measure, 2)
  const metaH = META_PX * 1.2
  const blockH = name.length * NAME_LINE + 3 + metaH
  let y = footerTop + (footerH - blockH) / 2
  for (const line of name) {
    ops.push({
      op: 'text',
      text: line,
      x: textX,
      y: y + NAME_LINE / 2,
      font: nameFont,
      color: FACE.ink,
      align: 'left',
    })
    y += NAME_LINE
  }
  y += 3
  const status = statusText(view)
  const statusColor =
    view.missing || view.status === 'ready' || view.status === 'loading'
      ? FACE.ink2
      : view.status === 'failed'
        ? FACE.danger
        : FACE.warn
  const metaFont = faceFont(400, META_PX)
  const size = formatBytes(view.sizeBytes)
  const lead = size ? `${size} · ` : ''
  const leadW = measure(lead, metaFont)
  if (lead)
    ops.push({
      op: 'text',
      text: lead,
      x: textX,
      y: y + metaH / 2,
      font: metaFont,
      color: FACE.ink2,
      align: 'left',
    })
  const statusFont = faceFont(view.status === 'failed' && !view.missing ? 600 : 400, META_PX)
  ops.push({
    op: 'text',
    text: ellipsize(status, Math.max(1, textW - leadW), statusFont, measure),
    x: textX + leadW,
    y: y + metaH / 2,
    font: statusFont,
    color: statusColor,
    align: 'left',
  })

  // the card's outline last, over everything (CSS border: 1 px inside the box)
  ops.push({
    op: 'rect',
    x: 0.5,
    y: 0.5,
    w: w - 1,
    h: h - 1,
    fill: 'transparent',
    stroke: FACE.line,
    radius: [RADIUS, RADIUS, RADIUS, RADIUS],
  })
  return { width: w, height: h, ops }
}

// ---- painting (browser) ------------------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D

function roundRect(
  c: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: readonly number[] = [0, 0, 0, 0],
) {
  const [tl = 0, tr = 0, br = 0, bl = 0] = r.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)))
  c.beginPath()
  c.moveTo(x + tl, y)
  c.lineTo(x + w - tr, y)
  c.arcTo(x + w, y, x + w, y + tr, tr)
  c.lineTo(x + w, y + h - br)
  c.arcTo(x + w, y + h, x + w - br, y + h, br)
  c.lineTo(x + bl, y + h)
  c.arcTo(x, y + h, x, y + h - bl, bl)
  c.lineTo(x, y + tl)
  c.arcTo(x, y, x + tl, y, tl)
  c.closePath()
}

/** Paints `layout` at `pixelRatio` device pixels per card unit, with the decoded images by slot. */
export function paintFace(
  c: Ctx2D,
  layout: FaceLayout,
  images: ReadonlyMap<string, CanvasImageSource & { width: number; height: number }>,
  pixelRatio: number,
): void {
  c.save()
  c.scale(pixelRatio, pixelRatio)
  // the card's rounded corners clip everything (the corners stay transparent)
  roundRect(c, 0, 0, layout.width, layout.height, [RADIUS, RADIUS, RADIUS, RADIUS])
  c.clip()
  c.textBaseline = 'middle'
  for (const op of layout.ops) {
    switch (op.op) {
      case 'rect':
        roundRect(c, op.x, op.y, op.w, op.h, op.radius)
        if (op.fill !== 'transparent') {
          c.fillStyle = op.fill
          c.fill()
        }
        if (op.stroke) {
          c.strokeStyle = op.stroke
          c.lineWidth = 1
          c.stroke()
        }
        break
      case 'line':
        c.beginPath()
        c.moveTo(op.x1, op.y1)
        c.lineTo(op.x2, op.y2)
        c.strokeStyle = op.color
        c.lineWidth = 1
        c.stroke()
        break
      case 'circle':
        c.beginPath()
        c.arc(op.cx, op.cy, op.r, 0, Math.PI * 2)
        c.fillStyle = op.fill
        c.fill()
        break
      case 'text':
        c.font = op.font
        c.fillStyle = op.color
        c.textAlign = op.align
        c.fillText(op.text, op.x, op.y)
        break
      case 'image': {
        const img = images.get(op.slot)
        if (!img || img.width <= 0 || img.height <= 0) break
        c.save()
        c.beginPath()
        c.rect(op.x, op.y, op.w, op.h)
        c.clip()
        if (op.fit === 'contain') {
          const k = Math.min(op.w / img.width, op.h / img.height)
          const dw = img.width * k
          const dh = img.height * k
          c.drawImage(img, op.x + (op.w - dw) / 2, op.y + (op.h - dh) / 2, dw, dh)
        } else {
          const k = Math.max(op.w / img.width, op.h / img.height)
          c.fillStyle = FACE.surface
          c.fillRect(op.x, op.y, op.w, op.h)
          c.drawImage(img, op.x + (op.w - img.width * k) / 2, op.y, img.width * k, img.height * k)
        }
        c.restore()
        break
      }
      case 'icon': {
        const path = new Path2D(op.d)
        c.save()
        c.translate(op.x, op.y)
        c.scale(op.size / 24, op.size / 24)
        if (op.fill) {
          c.fillStyle = op.fill
          c.fill(path)
        }
        if (op.stroke) {
          c.strokeStyle = op.stroke
          c.lineWidth = op.lineWidth ?? 2
          c.lineCap = 'round'
          c.lineJoin = 'round'
          c.stroke(path)
        }
        c.restore()
        break
      }
    }
  }
  c.restore()
}

// ---- composing a card's face for one export (browser) --------------------------------------------------

/** What the faces read: the board's file routes and the api's meta. */
export interface FaceSource {
  readonly boardId: string
  readonly meta: { load(boardId: string, assetId: string, versionId: string): Promise<MetaSnapshot> }
  /** the cover's URL (the board resolver's pick for the card), or null: the cover derivative's own route */
  readonly coverUrl?: (versionId: string, key: FileKey) => Promise<string | null>
  readonly fetchImpl?: (url: string) => Promise<Response>
}

export interface FaceOptions {
  /** device pixels per card unit (the export's scale) */
  readonly pixelRatio: number
  /** the encoding (SVG exports embed a WebP when the browser can make one; bitmaps take a PNG) */
  readonly type: 'image/png' | 'image/webp'
}

/** The longest side of a face bitmap (a 4× export of a large card stays a reasonable image). */
const MAX_FACE_PX = 4096

const defaultFetch = (url: string) => fetch(url, { credentials: 'same-origin' })

async function decode(
  url: string,
  doFetch: (url: string) => Promise<Response>,
): Promise<(ImageBitmap & { width: number; height: number }) | null> {
  try {
    const res = await doFetch(url)
    if (!res.ok) return null
    return await createImageBitmap(await res.blob())
  } catch {
    return null
  }
}

const browserMeasure = (): Measure => {
  const c = document.createElement('canvas').getContext('2d')
  return (text, font) => {
    if (!c) return text.length * 7
    c.font = font
    return c.measureText(text).width
  }
}

/** One card's face as an image `width` × `height` card units, or null when it cannot be drawn here. */
export async function composeCardFace(
  src: FaceSource,
  facts: FileFacts,
  key: FileKey,
  size: { readonly width: number; readonly height: number },
  opts: FaceOptions,
): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null
  const doFetch = src.fetchImpl ?? defaultFetch
  const snap: MetaSnapshot = await src.meta
    .load(src.boardId, facts.assetId, facts.versionId)
    .catch(() => ({ meta: null, missing: false, error: true }))
  const view = cardViewOf(facts, snap)
  const meta = snap.missing ? null : snap.meta
  const images = new Map<string, ImageBitmap & { width: number; height: number }>()
  const cover = view.status === 'ready' && !view.missing ? coverDerivative(meta) : null
  if (cover) {
    const url =
      (await src.coverUrl?.(facts.versionId, key).catch(() => null)) ??
      derivativeUrl(src.boardId, facts.assetId, facts.versionId, cover.id)
    const img = await decode(url, doFetch)
    if (img) images.set('cover', img)
  }
  const pages = view.kind === 'pdf' && !view.missing ? stripPages(meta) : []
  const shown = pages.slice(0, STRIP_MAX)
  const decoded = await Promise.all(
    shown.map((d) => decode(derivativeUrl(src.boardId, facts.assetId, facts.versionId, d.id), doFetch)),
  )
  decoded.forEach((img, i) => {
    if (img) images.set(`page:${i}`, img)
  })
  const office = cardOfficeFormat(meta, facts)
  const layout = cardFaceLayout(
    {
      view,
      office: office?.ext ?? null,
      converted: isConvertedPreview(meta),
      hasCover: images.has('cover'),
      strip: shown.length,
      more: Math.max(0, pages.length - shown.length),
    },
    size.width,
    size.height,
    browserMeasure(),
  )
  const ratio = Math.max(0.25, Math.min(opts.pixelRatio, MAX_FACE_PX / Math.max(layout.width, layout.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(layout.width * ratio))
  canvas.height = Math.max(1, Math.round(layout.height * ratio))
  const c = canvas.getContext('2d')
  if (!c) return null
  paintFace(c, layout, images, ratio)
  for (const img of images.values()) img.close?.()
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), opts.type, opts.type === 'image/webp' ? 0.92 : undefined),
  )
}

// ---- the export's resolver (canvas/export/scene.ts asks it for each card's bytes) ------------------------

/** The slice of canvas/export/scene.ts `SceneExportContext.resolver` an export reads. */
export interface ExportResolver {
  resolveUrl(versionId: string, derivative: Derivative, file: FileKey): Promise<string | null>
  assetOf(versionId: string): string | null
}

interface CardEntry {
  readonly facts: FileFacts
  readonly width: number
  readonly height: number
}

/** The file cards of a scene by version (a placed PDF page and a plain image are not cards). */
export function cardsByVersion(
  elements: readonly {
    type: string
    isDeleted?: boolean
    fileId?: unknown
    width: number
    height: number
    customData?: unknown
  }[],
): Map<string, CardEntry> {
  const out = new Map<string, CardEntry>()
  for (const el of elements) {
    if (el.type !== 'image' || el.isDeleted) continue
    const facts = factsOf(el)
    if (!facts || facts.kind === 'image') continue
    if (pageOfFileId(typeof el.fileId === 'string' ? el.fileId : null) !== null) continue
    const have = out.get(facts.versionId)
    // one face per version (one file per version in the export): the largest card's box
    if (!have || el.width * el.height > have.width * have.height)
      out.set(facts.versionId, { facts, width: el.width, height: el.height })
  }
  return out
}

export interface FaceSession {
  /**
   * CR 3E-5: `SceneExportContext.faceOf`. A card's face (made once per version, for this export only); null
   * for anything that is not a card (a placed page, a plain image) and for a card whose face could not be
   * drawn (the export then uses its cover, as for any other file).
   */
  faceOf(el: unknown, file: FileKey): Promise<Blob | null>
  /** ends the session: no face is handed out after it */
  release(): void
}

/**
 * The faces of one export. Faces are made only for the cards the export asks for. The cover a face is
 * composed over comes from `base`, the board's resolver (its display pick).
 */
export function faceSession(
  base: ExportResolver | null,
  cards: ReadonlyMap<string, CardEntry>,
  src: FaceSource,
  opts: FaceOptions,
  make: typeof composeCardFace = composeCardFace,
): FaceSession {
  const made = new Map<string, Promise<Blob | null>>()
  let released = false
  const coverUrl = (versionId: string, key: FileKey) =>
    base ? base.resolveUrl(versionId, 'display', key) : Promise.resolve(null)
  return {
    faceOf(_el, file) {
      const card = file.page === null ? cards.get(file.versionId) : undefined
      if (!card || released) return Promise.resolve(null)
      let p = made.get(file.versionId)
      if (!p) {
        p = make({ ...src, coverUrl }, card.facts, file, card, opts).catch(() => null)
        made.set(file.versionId, p)
      }
      return p.then((blob) => (released ? null : blob))
    },
    release() {
      released = true
      made.clear()
    },
  }
}
