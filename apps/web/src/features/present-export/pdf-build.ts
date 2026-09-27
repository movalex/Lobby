// Assembles the PDF export with pdf-lib: one page per rendered frame image, each under a header band
// with the frame's title (planPdfPage: frame-sized pages, or uniform 16:9 / A4 landscape pages with
// the frame fitted in), frame names as bookmarks, and an invisible text layer so the pages' text can
// be searched, selected and copied. No DOM here, so it runs (and is tested) in Node.
//
// Honesty note: pages are raster images of the frames (tldraw renders text through HTML, and there is
// no SVG-to-PDF vector path or font subsetting with the installed dependencies). The hidden text layer
// uses the standard Helvetica font, so characters outside Windows-1252 are left out of it (the visible
// image still shows them).
import {
  PDFDocument,
  type PDFDocument as PDFDocumentType,
  type PDFFont,
  PDFHexString,
  type PDFImage,
  PDFName,
  type PDFPage,
  type PDFRef,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib'
import { type PdfPageFormat, type PdfPagePlan, planPdfPage } from './pdf-layout.ts'

export interface PdfTextItem {
  text: string
  /** The shape's box in board px relative to the page's top-left. */
  x: number
  y: number
  w: number
  h: number
  /** Rendered font size in board px (so the hidden text roughly overlays the visible text). */
  fontSizePx: number
  align?: 'start' | 'middle' | 'end'
  verticalAlign?: 'start' | 'middle' | 'end'
  /** Padding inside the box, board px. */
  inset?: number
}

export const LINE_HEIGHT = 1.35

/** Greedy word wrap with the font's metrics; words longer than the line are split by character. */
export function wrapLines(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const breakWord = (word: string): string[] => {
    const chunks: string[] = []
    let chunk = ''
    for (const ch of Array.from(word)) {
      if (chunk && width(chunk + ch) > maxWidth) {
        chunks.push(chunk)
        chunk = ch
      } else chunk += ch
    }
    if (chunk) chunks.push(chunk)
    return chunks
  }
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter((w) => w !== '')
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (width(candidate) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      if (width(word) <= maxWidth) {
        line = word
        continue
      }
      const chunks = breakWord(word)
      out.push(...chunks.slice(0, -1))
      line = chunks.at(-1) ?? ''
    }
    out.push(line)
  }
  return out
}

export interface PdfPageInput {
  /** Bookmark title and the page's header (the frame name). */
  title: string
  /** Page size: the frame's own ('fit', the default) or the same 16:9 / A4 landscape page for all. */
  format?: PdfPageFormat
  /**
   * The header title drawn by the browser (any script), for titles the PDF's standard font cannot
   * show (see isWinAnsi). `widthPt`/`heightPt`: its size on the page.
   */
  headerImage?: { bytes: Uint8Array; widthPt: number; heightPt: number }
  /** The area the image shows, in board px (sets the page size and maps text positions). */
  widthPx: number
  heightPx: number
  image: { bytes: Uint8Array; type: 'png' | 'jpeg' }
  texts?: readonly PdfTextItem[]
}

export interface PdfBuilder {
  addPage(page: PdfPageInput): Promise<void>
  readonly pageCount: number
  finish(): Promise<Uint8Array>
}

/** Keeps what the standard font can encode (Windows-1252); tabs become spaces, other characters go. */
export function sanitizeForStandardFont(text: string, charset: ReadonlySet<number>): string {
  let out = ''
  for (const ch of text.normalize('NFC')) {
    if (ch === '\n') out += '\n'
    else if (ch === '\t') out += ' '
    else {
      const cp = ch.codePointAt(0) ?? 0
      if (cp >= 0x20 && charset.has(cp)) out += ch
    }
  }
  return out
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Windows-1252 (what the standard PDF fonts encode): ASCII, Latin-1 and these 27 code points.
const WIN_ANSI_EXTRA = new Set(
  [0x20ac, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x17d]
    .concat([0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153])
    .concat([0x17e, 0x178]),
)

/** Whether the standard PDF font can show all of `text` (else the browser draws it as an image). */
export function isWinAnsi(text: string): boolean {
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp)) continue
    return false
  }
  return true
}

/** Single-line, bounded title text ('' when nothing is left). */
function cleanTitle(title: string): string {
  const clean = String(title ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters do not belong in a title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(clean)
  return chars.length > 200 ? `${chars.slice(0, 199).join('')}…` : clean
}

/** Bookmark titles: trimmed, bounded, never empty. */
export function bookmarkTitle(title: string, index: number): string {
  return cleanTitle(title) || `Page ${index + 1}`
}

export const FALLBACK_DOCUMENT_TITLE = 'Draftroom board'

function drawHiddenText(
  page: PDFPage,
  font: PDFFont,
  charset: ReadonlySet<number>,
  item: PdfTextItem,
  k: number,
  pageHeight: number,
  /** Where the frame's image starts on the page (pt from the left / top edge). */
  origin: { x: number; y: number } = { x: 0, y: 0 },
) {
  const text = sanitizeForStandardFont(item.text, charset)
  if (!text) return
  const size = Math.max(1, item.fontSizePx * k)
  const inset = Math.max(0, (item.inset ?? 0) * k)
  const boxX = origin.x + item.x * k + inset
  const boxW = Math.max(size * 2, item.w * k - inset * 2)
  const boxTop = origin.y + item.y * k + inset
  const boxH = Math.max(size, item.h * k - inset * 2)
  const width = (s: string) => font.widthOfTextAtSize(s, size)
  const lines = wrapLines(text, boxW, width)
  const lineHeight = size * LINE_HEIGHT
  const blockH = lines.length * lineHeight
  const valign = item.verticalAlign ?? 'start'
  const top =
    valign === 'middle' ? boxTop + (boxH - blockH) / 2 : valign === 'end' ? boxTop + boxH - blockH : boxTop
  // Baseline of the first line: the font's ascent sits about 0.8 em below the line box's top.
  const firstBaseline = pageHeight - top - (lineHeight - size) / 2 - size * 0.8
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible))
  try {
    lines.forEach((line, i) => {
      if (!line) return
      const w = width(line)
      const align = item.align ?? 'start'
      const x = align === 'middle' ? boxX + (boxW - w) / 2 : align === 'end' ? boxX + boxW - w : boxX
      page.drawText(line, { x, y: firstBaseline - i * lineHeight, size, font, color: rgb(0, 0, 0) })
    })
  } finally {
    page.pushOperators(popGraphicsState())
  }
}

const BAND_FILL = rgb(0.953, 0.949, 0.933)
const BAND_RULE = rgb(0.863, 0.847, 0.8)
const TITLE_INK = rgb(0.106, 0.137, 0.188)

/** `text` shortened with an ellipsis until it fits `maxWidth`. */
function fitText(text: string, maxWidth: number, width: (s: string) => number): string {
  if (width(text) <= maxWidth) return text
  const chars = Array.from(text)
  while (chars.length > 1 && width(`${chars.join('').trimEnd()}…`) > maxWidth) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/**
 * The header band with the page's title: vector text in the standard font when it can show the
 * title, else the browser-drawn title image plus the title (as far as it encodes) in the hidden text
 * layer, so every page's title stays searchable.
 */
function drawHeader(
  page: PDFPage,
  plan: PdfPagePlan,
  title: string,
  font: PDFFont,
  charset: ReadonlySet<number>,
  image: { embedded: PDFImage; widthPt: number; heightPt: number } | null,
) {
  const band = plan.header
  const bandBottom = plan.height - band.height
  page.drawRectangle({ x: 0, y: bandBottom, width: band.width, height: band.height, color: BAND_FILL })
  page.drawLine({
    start: { x: 0, y: bandBottom },
    end: { x: band.width, y: bandBottom },
    thickness: 0.75,
    color: BAND_RULE,
  })
  const maxWidth = band.width - band.padX * 2
  const size = band.fontSize
  const baseline = bandBottom + (band.height - size) / 2 + size * 0.22
  const text = sanitizeForStandardFont(title, charset)
  const line = text ? fitText(text, maxWidth, (s) => font.widthOfTextAtSize(s, size)) : ''
  if (image) {
    const k = Math.min(1, maxWidth / image.widthPt)
    const w = image.widthPt * k
    const h = image.heightPt * k
    page.drawImage(image.embedded, {
      x: band.padX,
      y: bandBottom + (band.height - h) / 2,
      width: w,
      height: h,
    })
    if (!line) return
    page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible))
    try {
      page.drawText(line, { x: band.padX, y: baseline, size, font, color: TITLE_INK })
    } finally {
      page.pushOperators(popGraphicsState())
    }
    return
  }
  if (line) page.drawText(line, { x: band.padX, y: baseline, size, font, color: TITLE_INK })
}

function addOutline(doc: PDFDocumentType, entries: { title: string; ref: PDFRef }[]) {
  if (entries.length === 0) return
  const ctx = doc.context
  const outlinesRef = ctx.nextRef()
  const refs = entries.map(() => ctx.nextRef())
  entries.forEach((entry, i) => {
    const item = ctx.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: outlinesRef,
      Dest: ctx.obj([entry.ref, PDFName.of('Fit')]),
    })
    const prev = refs[i - 1]
    const next = refs[i + 1]
    if (prev) item.set(PDFName.of('Prev'), prev)
    if (next) item.set(PDFName.of('Next'), next)
    ctx.assign(refs[i] as PDFRef, item)
  })
  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: 'Outlines',
      First: refs[0] as PDFRef,
      Last: refs[refs.length - 1] as PDFRef,
      Count: refs.length,
    }),
  )
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  // Open with the bookmarks panel showing, so the frame list is one click away.
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}

/** An incremental builder: add pages as they are rendered (one image in memory at a time), then finish. */
export async function createPdfBuilder(meta: { title: string; now?: Date }): Promise<PdfBuilder> {
  const doc = await PDFDocument.create()
  doc.setTitle(cleanTitle(meta.title) || FALLBACK_DOCUMENT_TITLE, { showInWindowTitleBar: true })
  doc.setCreator('Draftroom')
  doc.setProducer('Draftroom')
  const now = meta.now ?? new Date()
  doc.setCreationDate(now)
  doc.setModificationDate(now)
  let font: PDFFont | null = null
  let charset: Set<number> | null = null
  const outline: { title: string; ref: PDFRef }[] = []
  const ensureFont = async () => {
    if (!font || !charset) {
      font = await doc.embedFont(StandardFonts.Helvetica)
      charset = new Set(font.getCharacterSet())
    }
    return { font, charset }
  }

  return {
    get pageCount() {
      return doc.getPageCount()
    },
    async addPage(input) {
      const plan = planPdfPage(input.widthPx, input.heightPx, input.format ?? 'fit')
      const page = doc.addPage([plan.width, plan.height])
      // White under the image: transparent PNG pages then read like paper, not like the viewer's background.
      page.drawRectangle({ x: 0, y: 0, width: plan.width, height: plan.height, color: rgb(1, 1, 1) })
      const image =
        input.image.type === 'png'
          ? await doc.embedPng(input.image.bytes)
          : await doc.embedJpg(input.image.bytes)
      page.drawImage(image, {
        x: plan.image.x,
        y: plan.height - plan.image.y - plan.image.height,
        width: plan.image.width,
        height: plan.image.height,
      })
      // Encode now rather than all at once in save(): spreads the work (and frees decoded pixels) per page.
      await image.embed()
      const { font: f, charset: cs } = await ensureFont()
      const title = bookmarkTitle(input.title, outline.length)
      const header =
        input.headerImage && !isWinAnsi(title)
          ? { ...input.headerImage, embedded: await doc.embedPng(input.headerImage.bytes) }
          : null
      drawHeader(page, plan, title, f, cs, header)
      for (const item of input.texts ?? []) {
        try {
          drawHiddenText(page, f, cs, item, plan.ptPerPx, plan.height, plan.image)
        } catch {
          // The text layer is a convenience: a string pdf-lib cannot lay out never fails the export.
        }
      }
      outline.push({ title, ref: page.ref })
    },
    async finish() {
      addOutline(doc, outline)
      return doc.save({ useObjectStreams: true, addDefaultPage: false })
    },
  }
}
