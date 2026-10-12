// N6-3 acceptance with the font engine (N6-1: @pdf-lib/fontkit): a frame whose text is Latin, CJK and emoji gives a
// PDF whose fonts are EMBEDDED SUBSETS of Lobby's own font files (FontFile2, a ToUnicode map), the emoji a picture.
// It is also the N6-1 spike: fontkit must read the self-hosted woff2 files (brotli), or this fails at the embed.
//
// SKIPPED while @pdf-lib/fontkit is not installed (./fontkit.ts answers null): this branch could not fetch it.
// The fonts are the files the build serves (canvas/export/test-fixtures.ts reads them from the installed engine).
import { readFileSync } from 'node:fs'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { servedFontFile } from '../../../canvas/export/test-fixtures.ts'
import { createPdfBuilder } from '../pdf-build.ts'
import { loadFontkit } from './fontkit.ts'

const fontkit = await loadFontkit()
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

describe.skipIf(!fontkit)('vector pages with Lobby’s fonts (needs @pdf-lib/fontkit)', () => {
  it('Latin, CJK and emoji: embedded subset TrueType fonts with ToUnicode, the emoji a picture, no page image', async () => {
    // the real frame export captured from the e2e board (Nunito text, CJK in Lobby's Xiaolai), plus an emoji
    const svg = readFileSync(new URL('./fixtures/intro-names.svg.xml', import.meta.url), 'utf8').replace(
      '日本語のメモ</text>',
      '日本語のメモ 🎉</text>',
    )
    const b = await createPdfBuilder({
      title: 'Board',
      vector: {
        fontkit,
        deps: {
          fetchFace: async (url) => servedFontFile(url),
          glyphs: async () => ({ png: PNG, width: 20, ascent: 16, descent: 4 }),
        },
      },
    })
    expect(await b.addVectorPage({ title: 'Intro', widthPx: 800, heightPx: 600, svg })).toEqual({
      vector: true,
    })
    const doc = await PDFDocument.load(await b.finish())
    const embedded: string[] = []
    let images = 0
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images++
      if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('Font')) continue
      if (obj.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue
      const descendants = obj.lookup(PDFName.of('DescendantFonts'), PDFArray)
      const cid = doc.context.lookup(descendants.get(0), PDFDict)
      const descriptor = cid.lookup(PDFName.of('FontDescriptor'), PDFDict)
      expect(descriptor.get(PDFName.of('FontFile2')), 'a TrueType font program').toBeDefined()
      expect(obj.get(PDFName.of('ToUnicode')), 'a ToUnicode map (searchable)').toBeDefined()
      // a subset: the program holds the few glyphs drawn (a whole Nunito or Xiaolai file is tens of KB)
      const program = doc.context.lookup(descriptor.get(PDFName.of('FontFile2')))
      expect(program).toBeInstanceOf(PDFRawStream)
      expect((program as PDFRawStream).contents.length).toBeLessThan(20_000)
      embedded.push(String(obj.get(PDFName.of('BaseFont'))))
    }
    // Nunito for the Latin line, and at least one Xiaolai file for the CJK one
    expect(embedded.some((n) => /Nunito/i.test(n))).toBe(true)
    expect(embedded.some((n) => /Xiaolai/i.test(n))).toBe(true)
    expect(images).toBe(1) // the emoji's picture, nothing else
  })
})

describe('the font engine', () => {
  it('is reported honestly: installed, or this branch’s missing N6-1 dependency', () => {
    // @pdf-lib/fontkit could not be added in this branch (no registry fetch allowed): the suite above is skipped
    // until it is. This test only pins that the loader never throws.
    expect(fontkit === null || typeof fontkit.create === 'function').toBe(true)
  })
})
