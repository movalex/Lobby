// Assembles the PDF export with pdf-lib: one page per rendered frame image, frame names as bookmarks,
// and an invisible text layer so the pages' text can be searched, selected and copied. No DOM here, so
// it runs (and is tested) in Node.
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
import { pdfPageSize } from './pdf-layout.ts'

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
  /** Bookmark title (the frame name). */
  title: string
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
) {
  const text = sanitizeForStandardFont(item.text, charset)
  if (!text) return
  const size = Math.max(1, item.fontSizePx * k)
  const inset = Math.max(0, (item.inset ?? 0) * k)
  const boxX = item.x * k + inset
  const boxW = Math.max(size * 2, item.w * k - inset * 2)
  const boxTop = item.y * k + inset
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

  return {
    get pageCount() {
      return doc.getPageCount()
    },
    async addPage(input) {
      const size = pdfPageSize(input.widthPx, input.heightPx)
      const page = doc.addPage([size.width, size.height])
      // White under the image: transparent PNG pages then read like paper, not like the viewer's background.
      page.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: rgb(1, 1, 1) })
      const image =
        input.image.type === 'png'
          ? await doc.embedPng(input.image.bytes)
          : await doc.embedJpg(input.image.bytes)
      page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height })
      // Encode now rather than all at once in save(): spreads the work (and frees decoded pixels) per page.
      await image.embed()
      if (input.texts?.length) {
        if (!font) {
          font = await doc.embedFont(StandardFonts.Helvetica)
          charset = new Set(font.getCharacterSet())
        }
        for (const item of input.texts) {
          try {
            drawHiddenText(page, font, charset as Set<number>, item, size.ptPerPx, size.height)
          } catch {
            // The text layer is a convenience: a string pdf-lib cannot lay out never fails the export.
          }
        }
      }
      outline.push({ title: bookmarkTitle(input.title, outline.length), ref: page.ref })
    },
    async finish() {
      addOutline(doc, outline)
      return doc.save({ useObjectStreams: true, addDefaultPage: false })
    },
  }
}
