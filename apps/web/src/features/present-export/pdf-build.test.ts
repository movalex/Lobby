import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  bookmarkTitle,
  createPdfBuilder,
  FALLBACK_DOCUMENT_TITLE,
  isWinAnsi,
  LINE_HEIGHT,
  sanitizeForStandardFont,
  wrapLines,
} from './pdf-build.ts'
import { FIXED_PAGE_PT, headerBandHeight, planPdfPage } from './pdf-layout.ts'

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
// 1×1 images (a red PNG and a baseline JPEG): enough for pdf-lib to embed.
const PNG = b64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
)
const JPEG = b64(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
)

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Response(stream).text()
}

/** Every Flate-compressed stream of the document, decoded (page content streams among them). */
async function decodedStreams(doc: PDFDocument): Promise<string> {
  const parts: string[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const filter = obj.dict.get(PDFName.of('Filter'))
    if (filter !== PDFName.of('FlateDecode')) continue
    try {
      parts.push(await inflate(obj.contents))
    } catch {
      // object streams etc. that are not plain deflate content
    }
  }
  return parts.join('\n')
}

function outlineTitles(doc: PDFDocument): string[] {
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict)
  const titles: string[] = []
  let ref = outlines.get(PDFName.of('First'))
  while (ref instanceof PDFRef) {
    const item = doc.context.lookup(ref, PDFDict)
    titles.push(item.lookup(PDFName.of('Title'), PDFHexString).decodeText())
    ref = item.get(PDFName.of('Next'))
  }
  return titles
}

describe('sanitizeForStandardFont', () => {
  it('keeps Windows-1252 text and drops what Helvetica cannot encode', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const charset = new Set(font.getCharacterSet())
    expect(sanitizeForStandardFont('Café “crème” – €5', charset)).toBe('Café “crème” – €5')
    expect(sanitizeForStandardFont('Idea 💡 日本 ok', charset)).toBe('Idea ok')
    expect(sanitizeForStandardFont('a\tb\n\n\n\nc\u0007', charset)).toBe('a b\n\nc')
    expect(sanitizeForStandardFont('🙂🙂', charset)).toBe('')
    // The sanitized text always encodes.
    expect(() => font.encodeText(sanitizeForStandardFont('Ω≈ç√∫ é ñ ß', charset))).not.toThrow()
  })
})

describe('wrapLines', () => {
  const w = (s: string) => s.length // 1 unit per character
  it('wraps words greedily and keeps paragraphs', () => {
    expect(wrapLines('aaa bbb ccc', 7, w)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapLines('aaa\nbbb ccc', 20, w)).toEqual(['aaa', 'bbb ccc'])
    expect(wrapLines('a\n\nb', 5, w)).toEqual(['a', '', 'b'])
  })
  it('splits words longer than a line', () => {
    expect(wrapLines('abcdefghij', 4, w)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapLines('xy abcdefghij z', 4, w)).toEqual(['xy', 'abcd', 'efgh', 'ij z'])
  })
})

describe('isWinAnsi', () => {
  it('accepts what the standard PDF fonts encode', () => {
    expect(isWinAnsi('Concept B – Fresh Start “€5”')).toBe(true)
    expect(isWinAnsi('Café crème')).toBe(true)
    expect(isWinAnsi('Idea 💡')).toBe(false)
    expect(isWinAnsi('企画')).toBe(false)
    expect(isWinAnsi('Ω')).toBe(false)
  })
})

describe('bookmarkTitle', () => {
  it('cleans titles and never returns an empty one', () => {
    expect(bookmarkTitle('  Intro\n slide ', 0)).toBe('Intro slide')
    expect(bookmarkTitle('', 4)).toBe('Page 5')
    expect(Array.from(bookmarkTitle('x'.repeat(500), 0))).toHaveLength(200)
  })
})

describe('createPdfBuilder', () => {
  it('writes one page per frame, sized from the frame plus a title band, with bookmarks and metadata', async () => {
    const builder = await createPdfBuilder({
      title: 'Spring campaign',
      now: new Date('2026-09-27T10:00:00Z'),
    })
    await builder.addPage({
      title: 'Intro',
      widthPx: 1920,
      heightPx: 1080,
      image: { bytes: JPEG, type: 'jpeg' },
    })
    await builder.addPage({ title: '', widthPx: 800, heightPx: 1200, image: { bytes: PNG, type: 'png' } })
    expect(builder.pageCount).toBe(2)
    const bytes = await builder.finish()

    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(2)
    const [p1, p2] = doc.getPages()
    expect(p1?.getSize()).toEqual({ width: 1440, height: 810 + headerBandHeight(1440) })
    expect(p2?.getSize()).toEqual({
      width: planPdfPage(800, 1200).width,
      height: planPdfPage(800, 1200).height,
    })
    expect(doc.getTitle()).toBe('Spring campaign')
    expect(doc.getCreator()).toBe('Draftroom')
    expect(outlineTitles(doc)).toEqual(['Intro', 'Page 2'])
    expect(doc.catalog.get(PDFName.of('PageMode'))).toBe(PDFName.of('UseOutlines'))
  })

  it('adds an invisible, searchable text layer at the shapes positions', async () => {
    const builder = await createPdfBuilder({ title: 'Board' })
    await builder.addPage({
      title: 'Notes',
      widthPx: 1000,
      heightPx: 500,
      image: { bytes: PNG, type: 'png' },
      texts: [
        { text: 'Hello', x: 100, y: 100, w: 200, h: 200, fontSizePx: 22 },
        { text: '日本語 only', x: 400, y: 100, w: 200, h: 200, fontSizePx: 22 },
        { text: '💡', x: 0, y: 0, w: 10, h: 10, fontSizePx: 22 },
      ],
    })
    const doc = await PDFDocument.load(await builder.finish())
    const content = await decodedStreams(doc)
    // Text render mode 3 (invisible) wraps the text objects.
    expect(content).toMatch(/\b3 Tr\b/)
    // WinAnsi-encoded "Hello" and " only" (the CJK part is dropped from the hidden layer).
    expect(content).toContain('<48656C6C6F>')
    expect(content).toContain('<6F6E6C79>')
    // "Hello": 22 px at 0.75 pt/px = 16.5 pt. Line box 16.5 * 1.35; first baseline =
    // page top (375) - box top (75) - half the leading (2.8875) - ascent (0.8 em = 13.2) = 283.9125.
    expect(content).toContain('16.5 Tf')
    expect(content).toMatch(/1 0 0 1 75 283\.91\d* Tm/)
  })

  it('wraps and centres note text inside its box', async () => {
    const builder = await createPdfBuilder({ title: 'Board' })
    await builder.addPage({
      title: 'Notes',
      widthPx: 1000,
      heightPx: 1000,
      image: { bytes: PNG, type: 'png' },
      texts: [
        {
          text: 'one two three four five six seven eight nine ten',
          x: 0,
          y: 0,
          w: 200,
          h: 200,
          fontSizePx: 22,
          align: 'middle',
          verticalAlign: 'middle',
          inset: 16,
        },
      ],
    })
    const doc = await PDFDocument.load(await builder.finish())
    const content = await decodedStreams(doc)
    // The page's own title sits in the band above the frame (y >= 750); the note's lines are below.
    const lines = [...content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)]
      .map((m) => [Number(m[1]), Number(m[2])])
      .filter(([, y]) => (y ?? 0) < 750)
    expect(lines.length).toBeGreaterThan(1)
    for (const [x, y] of lines) {
      // Inside the note's box (0..150 pt on both axes, PDF y grows upwards from 750).
      expect(x).toBeGreaterThanOrEqual(12)
      expect(x).toBeLessThan(138)
      expect(y).toBeGreaterThan(750 - 150)
      expect(y).toBeLessThan(750)
    }
    // Baselines step down by one line height.
    expect((lines[0]?.[1] ?? 0) - (lines[1]?.[1] ?? 0)).toBeCloseTo(16.5 * LINE_HEIGHT, 3)
  })

  it('titles every page in a header band as real text, and 16:9 pages all have one size', async () => {
    const builder = await createPdfBuilder({ title: 'Deck' })
    const frames = [
      ['Concept A – Bold', 1920, 1080],
      ['Concept B', 800, 1200],
      ['Wide strip', 5000, 400],
    ] as const
    for (const [title, w, h] of frames)
      await builder.addPage({
        title,
        widthPx: w,
        heightPx: h,
        format: '16:9',
        image: { bytes: PNG, type: 'png' },
      })
    const doc = await PDFDocument.load(await builder.finish())
    for (const page of doc.getPages()) expect(page.getSize()).toEqual(FIXED_PAGE_PT['16:9'])
    const content = await decodedStreams(doc)
    // Visible (not render mode 3) WinAnsi text: "Concept A " … the en dash is 0x96 in WinAnsi.
    expect(content).toContain('<436F6E6365707420412096') // "Concept A –"
    expect(content).toContain('<436F6E636570742042>') // "Concept B"
    expect(content).toContain('<57696465207374726970>') // "Wide strip"
    expect(outlineTitles(doc)).toEqual(['Concept A – Bold', 'Concept B', 'Wide strip'])
  })

  it('draws titles the standard font cannot show as the browser-drawn image, keeping what encodes searchable', async () => {
    const builder = await createPdfBuilder({ title: 'Deck' })
    await builder.addPage({
      title: 'Idee 💡 企画',
      widthPx: 1000,
      heightPx: 600,
      format: 'a4',
      image: { bytes: JPEG, type: 'jpeg' },
      headerImage: { bytes: PNG, widthPt: 120, heightPt: 18 },
    })
    // A WinAnsi title ignores the image and is drawn as text.
    await builder.addPage({
      title: 'Plain',
      widthPx: 1000,
      heightPx: 600,
      format: 'a4',
      image: { bytes: JPEG, type: 'jpeg' },
      headerImage: { bytes: PNG, widthPt: 120, heightPt: 18 },
    })
    const doc = await PDFDocument.load(await builder.finish())
    const [first, second] = doc.getPages()
    const images = (page: typeof first) =>
      page?.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)?.keys().length ?? 0
    expect(images(first)).toBe(2) // the frame and the title
    expect(images(second)).toBe(1)
    const content = await decodedStreams(doc)
    expect(content).toContain('<49646565>') // "Idee" in the hidden layer
    expect(content).toContain('<506C61696E>') // "Plain"
  })

  it('finishes an empty document without an outline', async () => {
    const builder = await createPdfBuilder({ title: '' })
    const doc = await PDFDocument.load(await builder.finish())
    expect(doc.getPageCount()).toBe(0)
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeUndefined()
    expect(doc.getTitle()).toBe(FALLBACK_DOCUMENT_TITLE)
  })
})
