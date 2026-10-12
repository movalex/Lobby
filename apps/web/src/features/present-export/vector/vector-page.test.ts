// N6-3/N6-4: vector pages in Node: a frame's SVG drawn with @cantoo/pdf-lib (read back with the original pdf-lib),
// images as image XObjects at their place, dashes and clips as PDF operators, and the honest fallback: a page the
// vector drawing cannot reproduce adds nothing and says why, so the caller adds an image page instead.

import { readFileSync } from 'node:fs'
import { PDFPage as CantooPage } from '@cantoo/pdf-lib'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfBuilder, type PdfVectorPageInput } from '../pdf-build.ts'
import { ownStyle, readScene } from './svg-scene.ts'
import { FaceIndex, layoutText, parseFaceTable } from './text-layout.ts'
import type { VectorDeps } from './vector-page.ts'

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const PNG = b64(PNG_B64)
// a 2×2 RIFF/WEBP header is enough to be "not PNG or JPEG" (the transcoder decides what it is)
const WEBP_B64 = btoa('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')

const noFonts: VectorDeps = { fetchFace: async () => null }

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Response(stream).text()
}

/** The page content streams of a saved PDF, decoded, and its image XObjects. */
async function inspect(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes)
  const pages = doc.getPages()
  const contents: string[] = []
  const images: { width: number; height: number }[] = []
  const fonts: string[] = []
  for (const page of pages) {
    let text = ''
    const c = page.node.Contents()
    const streams = c instanceof PDFStream ? [c] : c ? c.asArray().map((r) => doc.context.lookup(r)) : []
    for (const s of streams)
      if (s instanceof PDFRawStream)
        text += `${await inflate(s.contents).catch(() => new TextDecoder().decode(s.contents))}\n`
    contents.push(text)
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [, ref] of xobjects?.entries() ?? []) {
      const x = doc.context.lookup(ref)
      if (x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
        images.push({
          width: Number(x.dict.get(PDFName.of('Width'))),
          height: Number(x.dict.get(PDFName.of('Height'))),
        })
    }
    const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
    for (const [, ref] of fontDict?.entries() ?? []) {
      const f = doc.context.lookup(ref)
      if (f instanceof PDFDict) fonts.push(String(f.get(PDFName.of('BaseFont'))))
    }
  }
  let imageObjects = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects())
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
      imageObjects++
  return { doc, pageCount: pages.length, contents, images, fonts, imageObjects }
}

/**
 * Whether every path object of a content stream is well formed (PDF 32000 8.5.2): between the first path
 * construction operator and the painting (or clipping) operator, nothing but path construction and W/W*: a `cm` or
 * `q` there makes viewers drop the path (and with it a clip: the image under it vanished in pdf.js).
 */
function pathObjectsWellFormed(content: string): string | null {
  const ops = content.split(/\s+/).filter((t) => /^[A-Za-z*'"]+$/.test(t))
  const construct = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're'])
  const paint = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])
  let inPath = false
  for (const op of ops) {
    if (construct.has(op)) inPath = true
    else if (paint.has(op)) inPath = false
    else if (op === 'W' || op === 'W*') {
      if (!inPath) return 'a clip without a path'
    } else if (inPath) return `${op} inside a path object`
  }
  return inPath ? 'an unfinished path' : null
}

const hex = (s: string) =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('')

/** A 400×300 frame as Lobby exports it with fonts: 'names' (Excalidraw's structure, Lobby's passes). */
function frameSvg(body: string, defs = '', faces = '{"v":1,"faces":[]}') {
  return (
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">' +
    '<!-- svg-source:excalidraw --><metadata></metadata>' +
    `<defs><style class="style-fonts">\n\n</style><metadata id="lobby-pdf-faces">${faces}</metadata>${defs}</defs>` +
    '<rect x="0" y="0" width="400" height="300" fill="#ffffff"></rect>' +
    body +
    '</svg>'
  )
}

const NOTE =
  '<g transform="translate(40 40) rotate(0 60 60)"><path d="M0 0 L120 0 L120 120 L0 120 Z" fill="#fff9b1" filter="url(#lobby-note-shadow)"></path></g>' +
  '<g transform="translate(50 60) rotate(0 40 10)"><text x="0" y="18" font-family="ui-sans-serif, system-ui" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;" direction="ltr" dominant-baseline="alphabetic">Kickoff</text></g>'
const NOTE_DEFS = '<filter id="lobby-note-shadow"><feGaussianBlur stdDeviation="3"/></filter>'

const page = (svg: string, extra: Partial<PdfVectorPageInput> = {}): PdfVectorPageInput => ({
  title: 'Intro',
  widthPx: 400,
  heightPx: 300,
  svg,
  ...extra,
})

afterEach(() => vi.restoreAllMocks())

describe('vector pages', () => {
  it('a frame of shapes and text is a vector page: no image at all, the text real text, the header and bookmark kept', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const out = await b.addVectorPage(
      page(
        frameSvg(
          `${NOTE}<g stroke-linecap="round" transform="translate(200 40) rotate(0 50 30)"><path d="M0 0 L100 0 L100 60 L0 60 Z" stroke="none" fill="#a5d8ff"></path><path d="M0 0 L100 0 L100 60 L0 60 Z" stroke="#1971c2" stroke-width="2" fill="none"></path></g>`,
          NOTE_DEFS,
        ),
      ),
    )
    expect(out).toEqual({ vector: true })
    const pdf = await inspect(await b.finish())
    expect(pdf.pageCount).toBe(1)
    expect(pdf.images).toEqual([])
    expect(pdf.imageObjects).toBe(0)
    const content = pdf.contents[0] as string
    expect(content).toContain(`<${hex('Kickoff')}> Tj`) // real text, drawn in Helvetica (a system font in the SVG)
    expect(content).not.toContain('3 Tr') // not the invisible text layer of image pages
    expect(content).toContain(`<${hex('Intro')}> Tj`) // the header band's title
    // the page is 400×300 px at 0.75 pt/px plus the 28 pt band
    const [p] = pdf.doc.getPages()
    expect([p?.getWidth(), p?.getHeight()]).toEqual([300, 225 + 28])
  })

  it('a frame with an image: an image XObject drawn at its place (not the page), the text stays vector', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const out = await b.addVectorPage(
      page(
        frameSvg(
          `${NOTE}<g transform="translate(200 100) rotate(0 50 50)" clip-path="url(#image-clipPath-i)"><use href="#image-f" width="100" height="100" opacity="1"></use></g>`,
          `${NOTE_DEFS}<symbol id="image-f"><image href="data:image/png;base64,${PNG_B64}" preserveAspectRatio="none" width="100%" height="100%"></image></symbol><clipPath id="image-clipPath-i" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="100" height="100" rx="8" ry="8"></rect></clipPath>`,
        ),
      ),
    )
    expect(out).toEqual({ vector: true })
    const pdf = await inspect(await b.finish())
    expect(pdf.images).toEqual([{ width: 1, height: 1 }])
    const content = pdf.contents[0] as string
    expect(content).toContain(`<${hex('Kickoff')}> Tj`)
    // drawn at 100 px × 0.75 = 75 pt, not page-sized; under its rounded clip (curves, W n)
    expect(content).toMatch(/75 0 0 -?75 [\d.]+ [\d.]+ cm/)
    expect(content).toMatch(/ c\n[\s\S]*W\nn/)
    expect(pathObjectsWellFormed(content)).toBeNull()
  })

  it('the same image on two pages is embedded once', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const svg = frameSvg(
      '<g transform="translate(10 10)"><use href="#image-f" width="50" height="50"></use></g>',
      `<symbol id="image-f"><image href="data:image/png;base64,${PNG_B64}" preserveAspectRatio="none" width="100%" height="100%"></image></symbol>`,
    )
    expect(await b.addVectorPage(page(svg))).toEqual({ vector: true })
    expect(await b.addVectorPage(page(svg, { title: 'Two' }))).toEqual({ vector: true })
    const pdf = await inspect(await b.finish())
    expect(pdf.pageCount).toBe(2)
    expect(pdf.imageObjects).toBe(1)
  })

  it('two different photos never share one embedding, even when a weak hash of their data URLs collides', async () => {
    // a red and a blue 1×1 PNG (a tEXt chunk varied until they collide): equal length, equal 32-bit FNV-1a hash,
    // which the cache key once was
    const RED =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXRFWHRuNgAwMDNtOWkKBW1uAAAAD0lEQVR4AQEEAPv/AP8AAAMBAQCNHeWCAAAAAElFTkSuQmCC'
    const BLUE =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXRFWHRuNgAwMDA4bm9uXkB9AAAAD0lEQVR4AQEEAPv/AAAA/wEDAQB8wnTbAAAAAElFTkSuQmCC'
    const fnv = (s: string) => {
      let h = 0x811c9dc5
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
      return h >>> 0
    }
    expect(RED).not.toBe(BLUE)
    expect([RED.length, fnv(RED)]).toEqual([BLUE.length, fnv(BLUE)])
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const svg = frameSvg(
      '<g transform="translate(10 10)"><use href="#image-r" width="50" height="50"></use></g><g transform="translate(100 10)"><use href="#image-b" width="50" height="50"></use></g>',
      `<symbol id="image-r"><image href="${RED}" preserveAspectRatio="none" width="100%" height="100%"></image></symbol><symbol id="image-b"><image href="${BLUE}" preserveAspectRatio="none" width="100%" height="100%"></image></symbol>`,
    )
    expect(await b.addVectorPage(page(svg))).toEqual({ vector: true })
    const pdf = await inspect(await b.finish())
    expect(pdf.imageObjects).toBe(2)
    const drawn = [...(pdf.contents[0] as string).matchAll(/\/(\S+) Do/g)].map((m) => m[1])
    expect(drawn).toHaveLength(2)
    expect(new Set(drawn).size).toBe(2)

    // no SubtleCrypto (a page on a plain-http LAN address): keyed by the whole data URL, exact as well, and the same
    // photo twice is still embedded once
    vi.stubGlobal('crypto', {})
    try {
      const c = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
      expect(await c.addVectorPage(page(svg))).toEqual({ vector: true })
      expect(await c.addVectorPage(page(svg, { title: 'Two' }))).toEqual({ vector: true })
      expect((await inspect(await c.finish())).imageObjects).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('dashes are drawn natively and an arrow label’s hole is an even-odd clip', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const out = await b.addVectorPage(
      page(
        frameSvg(
          '<g mask="url(#mask-a)" stroke-linecap="round"><path d="M 10 150 L 390 150" stroke="#1e1e1e" stroke-width="2" fill="none" stroke-dasharray="8 10" transform="translate(0 0) rotate(0 0 0)"></path></g><mask id="mask-a" maskUnits="userSpaceOnUse" x="0" y="0" width="500" height="400"><rect x="0" y="0" fill="#fff" width="500" height="400"></rect><rect x="150" y="140" fill="#000" width="100" height="20" opacity="1"></rect></mask>',
        ),
      ),
    )
    expect(out).toEqual({ vector: true })
    const content = (await inspect(await b.finish())).contents[0] as string
    expect(content).toContain('[8 10] 0 d')
    expect(content).toContain('W*\nn')
    expect(pathObjectsWellFormed(content)).toBeNull()
  })

  it('N6-4: a frame with an SVG filter falls back: nothing is added, the reason is given, and an image page can follow', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const out = await b.addVectorPage(
      page(
        frameSvg(
          `${NOTE}<g filter="url(#blur)"><path d="M0 0 L10 10" stroke="#000"></path></g>`,
          `${NOTE_DEFS}<filter id="blur"><feGaussianBlur stdDeviation="3"/></filter><symbol id="image-f"><image href="data:image/png;base64,${PNG_B64}" width="100%" height="100%"></image></symbol>`,
        ),
      ),
    )
    expect(out).toEqual({ vector: false, reason: 'it uses a filter' })
    expect(b.pageCount).toBe(0)
    await b.addPage({ title: 'Intro', widthPx: 400, heightPx: 300, image: { bytes: PNG, type: 'png' } })
    const pdf = await inspect(await b.finish())
    expect(pdf.pageCount).toBe(1)
    expect(pdf.imageObjects).toBe(1) // the image page's own image only
  })

  it('N6-4: a semi-transparent note (group opacity over its paints) falls back, and says why', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    const out = await b.addVectorPage(
      page(
        frameSvg(
          '<g opacity="0.5" transform="translate(40 40)"><path d="M4 4 L124 4 L124 124 L4 124 Z" fill="#000" fill-opacity="0.16"></path><path d="M0 0 L120 0 L120 120 L0 120 Z" fill="#fff9b1"></path></g>',
        ),
      ),
    )
    expect(out).toEqual({ vector: false, reason: 'it uses a partly transparent group' })
    expect(b.pageCount).toBe(0)
  })

  it('N6-4: a drawSvg throw falls back, and the page and its embedded images leave the file', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    vi.spyOn(CantooPage.prototype, 'drawSvg').mockImplementation(() => {
      throw new Error('drawSvg failed')
    })
    const svg = frameSvg(
      `${NOTE}<g transform="translate(10 10)"><use href="#image-f" width="50" height="50"></use></g>`,
      `${NOTE_DEFS}<symbol id="image-f"><image href="data:image/png;base64,${PNG_B64}" preserveAspectRatio="none" width="100%" height="100%"></image></symbol>`,
    )
    expect(await b.addVectorPage(page(svg))).toEqual({ vector: false, reason: 'the vector drawing failed' })
    expect(b.pageCount).toBe(0)
    vi.restoreAllMocks()
    // the same image on the next (working) page is embedded again, once
    expect(await b.addVectorPage(page(svg))).toEqual({ vector: true })
    const pdf = await inspect(await b.finish())
    expect(pdf.pageCount).toBe(1)
    expect(pdf.imageObjects).toBe(1)
  })

  it('text in a Lobby font is never drawn in a stand-in: without the font engine the page falls back and says so', async () => {
    const faces = JSON.stringify({
      v: 1,
      faces: [
        {
          family: 'Excalifont',
          url: '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a.woff2',
          unicodeRange: 'U+20-7e',
          weight: '400',
          style: 'normal',
        },
      ],
    })
    const fetched: string[] = []
    const b = await createPdfBuilder({
      title: 'Board',
      vector: {
        deps: {
          fetchFace: async (url) => {
            fetched.push(url)
            return new Uint8Array([0, 1, 0, 0])
          },
        },
      },
    })
    const out = await b.addVectorPage(
      page(
        frameSvg(
          '<g><text x="0" y="20" font-family="Excalifont, Xiaolai, Segoe UI Emoji" font-size="20px" fill="#1e1e1e" style="white-space: pre;">Hello</text></g>',
          '',
          faces,
        ),
      ),
    )
    expect(out).toEqual({ vector: false, reason: 'the font Excalifont could not be embedded' })
    expect(fetched).toEqual(['/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a.woff2'])
  })

  it('images pdf-lib cannot embed are transcoded; when they cannot be, the page falls back', async () => {
    const svg = frameSvg(
      '<g><use href="#image-w" width="50" height="50"></use></g>',
      `<symbol id="image-w"><image href="data:image/webp;base64,${WEBP_B64}" preserveAspectRatio="none" width="100%" height="100%"></image></symbol>`,
    )
    const without = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    expect(await without.addVectorPage(page(svg))).toEqual({
      vector: false,
      reason: 'an image could not be embedded',
    })
    const seen: string[] = []
    const withT = await createPdfBuilder({
      title: 'Board',
      vector: {
        deps: {
          ...noFonts,
          transcode: async (_bytes, mime) => {
            seen.push(mime)
            return { bytes: PNG, type: 'png' }
          },
        },
      },
    })
    expect(await withT.addVectorPage(page(svg))).toEqual({ vector: true })
    expect(seen).toEqual(['image/webp'])
    expect((await inspect(await withT.finish())).images).toEqual([{ width: 1, height: 1 }])
  })

  it('emoji (no Lobby font has them) are drawn as small pictures where the environment can, else the page falls back', async () => {
    const svg = frameSvg(
      '<g><text x="0" y="20" font-family="Segoe UI Emoji" font-size="20px" fill="#1e1e1e" style="white-space: pre;">ok 🎉</text></g>',
    )
    const without = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    expect(await without.addVectorPage(page(svg))).toEqual({
      vector: false,
      reason: 'it has characters none of Lobby’s fonts can show',
    })
    const asked: string[] = []
    const withG = await createPdfBuilder({
      title: 'Board',
      vector: {
        deps: {
          ...noFonts,
          glyphs: async (text, size) => {
            asked.push(`${text}@${size}`)
            return { png: PNG, width: 20, ascent: 16, descent: 4 }
          },
        },
      },
    })
    expect(await withG.addVectorPage(page(svg))).toEqual({ vector: true })
    expect(asked).toEqual(['🎉@20'])
    const pdf = await inspect(await withG.finish())
    expect(pdf.images).toEqual([{ width: 1, height: 1 }])
    // the space is text too (drawn in the standard font's run: the text keeps it)
    expect(pdf.contents[0]).toContain(`<${hex('ok ')}> Tj`)
    // the picture's text is there as invisible text (rendering mode 3) in the invisible-text font, code 1
    expect(pdf.contents[0]).toMatch(/BT\n3 Tr\n[^\n]+ Tm\n\/LobbyText-\d+ 20 Tf\n<01> Tj\nET/)
  })

  it('without the vector environment a vector page is refused (image pages only)', async () => {
    const b = await createPdfBuilder({ title: 'Board' })
    expect(await b.addVectorPage(page(frameSvg('')))).toEqual({
      vector: false,
      reason: 'vector pages are not available here',
    })
  })

  it('a real frame export (fonts: names, captured from the e2e board) reads with no problem; its text needs Nunito and Lobby’s CJK font', async () => {
    const svg = readFileSync(new URL('./fixtures/intro-names.svg.xml', import.meta.url), 'utf8')
    const scene = readScene(svg)
    expect(scene.problems).toEqual([])
    expect(scene.leaves.filter((l) => l.noteShadow)).toHaveLength(1)
    const faces = new FaceIndex(parseFaceTable(scene.metadata.get('lobby-pdf-faces')))
    const runs = scene.leaves
      .filter((l) => l.el.name === 'text')
      .flatMap((l) =>
        layoutText(
          l.el,
          l.style,
          faces,
          { width: (_d, t, s) => t.length * s * 0.5, ascent: (_d, s) => s, descent: () => 0 },
          ownStyle,
        ),
      )
      .map((r) => [r.text, r.draw.kind === 'face' ? r.draw.face.family : r.draw.kind])
    expect(runs[0]).toEqual(['Kickoff agenda', 'Nunito'])
    // the CJK line: one run per Xiaolai file (each unicode-range chunk is its own embedded font)
    const cjk = runs.slice(1)
    expect(cjk.map(([t]) => t).join('')).toBe('日本語のメモ')
    expect(new Set(cjk.map(([, f]) => f))).toEqual(new Set(['Xiaolai']))
    expect(cjk.length).toBeGreaterThan(1)
    // without the font engine the page is honestly an image page (fetches only Lobby font paths)
    const fetched: string[] = []
    const b = await createPdfBuilder({
      title: 'Board',
      vector: {
        deps: {
          fetchFace: async (url) => {
            fetched.push(url)
            return null
          },
        },
      },
    })
    expect(await b.addVectorPage(page(svg, { widthPx: 800, heightPx: 600 }))).toEqual({
      vector: false,
      reason: 'the font Nunito could not be embedded',
    })
    expect(fetched.every((u) => /^\/excalidraw-assets\/fonts\/Nunito\//.test(u))).toBe(true)
  })

  it('an SVG that is not XML falls back', async () => {
    const b = await createPdfBuilder({ title: 'Board', vector: { deps: noFonts } })
    expect(await b.addVectorPage(page('<svg><g></svg>'))).toEqual({
      vector: false,
      reason: 'the frame’s drawing could not be read',
    })
  })
})
