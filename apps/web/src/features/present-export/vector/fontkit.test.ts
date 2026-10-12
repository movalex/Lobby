// N6-1 (wave N.1): the font engine adapters (./fontkit.ts) on Lobby's served font files: every glyph of the files the
// two frame fixtures name (Nunito, Excalifont, the CJK line's Xiaolai files) goes through a subset and is read back
// with fontkit itself: the same points, the same on-curve flags, the same advance width (every file the build serves
// is apps/web/test/bundle/pdf-worker-chunk.test.ts's, from the build's own emitted fonts). And the reason the adapter
// exists: fontkit 1.1.1's own subsetter writes garbage glyphs for these woff2 files (the test says so, and says when
// a fontkit bump no longer needs it).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { servedFontFile } from '../../../canvas/export/test-fixtures.ts'
import { encodeSimpleGlyph, loadFontkit, type OutlinePoint } from './fontkit.ts'
import { contourText, rawFontkit, roundTripFontFile, subsetBytes } from './fontkit-roundtrip.ts'

/** The face URLs a frame fixture's face table names (same-origin paths under /excalidraw-assets/fonts/). */
function fixtureFaceUrls(name: string): string[] {
  const svg = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  return [...svg.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1] as string)
}

/** The served files the two frame fixtures name. */
const urls = new Set([...fixtureFaceUrls('intro-names.svg.xml'), ...fixtureFaceUrls('mid-frame.svg.xml')])
const files = [...urls].map((url) => {
  const bytes = servedFontFile(url)
  if (!bytes) throw new Error(`not served: ${url}`)
  return { url, bytes }
})

describe('the font engine adapters (@pdf-lib/fontkit 1.1.1 on the served woff2 files)', () => {
  it('loads (the worker and the no-worker fallback get it from here)', async () => {
    const fk = await loadFontkit()
    expect(typeof fk?.create).toBe('function')
  })

  it(`every glyph of the fixtures' font files (${files.length}) survives a subset: the same points, flags and advance`, async () => {
    expect(files.map((f) => f.url.split('/')[3])).toEqual(
      expect.arrayContaining(['Nunito', 'Excalifont', 'Xiaolai']),
    )
    let glyphs = 0
    for (const f of files) {
      const r = await roundTripFontFile(f.bytes)
      expect(r.transformed, `${f.url} is a woff2 with a transformed glyf`).toBe(true)
      expect(r.problems, f.url).toEqual([])
      glyphs += r.glyphs
    }
    expect(glyphs).toBeGreaterThan(1000)
  })

  it('why the adapter exists: fontkit’s own subset of these files has broken glyphs (remove the adapter when this fails)', async () => {
    const nunito = files.find((f) => /\/Nunito\//.test(f.url))
    expect(nunito).toBeDefined()
    const font = rawFontkit.create((nunito as { bytes: Uint8Array }).bytes) as unknown as {
      createSubset(): Parameters<typeof subsetBytes>[0]
      glyphForCodePoint(cp: number): { id: number }
      getGlyph(gid: number): { _getContours(): OutlinePoint[][] }
    }
    const subset = font.createSubset()
    // 'K' and 'a': real outlines in the font
    const gK = font.glyphForCodePoint(0x4b).id
    const ga = font.glyphForCodePoint(0x61).id
    expect(font.getGlyph(gK)._getContours().length).toBeGreaterThan(0)
    expect(font.getGlyph(ga)._getContours().length).toBeGreaterThan(0)
    const sK = subset.includeGlyph(gK)
    const sa = subset.includeGlyph(ga)
    const back = rawFontkit.create(await subsetBytes(subset))
    // not the font's outlines: bytes of the transformed streams read as glyphs (pdf.js drew nothing for them)
    const outline = (f: { getGlyph(gid: number): { _getContours(): OutlinePoint[][] } }, gid: number) => {
      try {
        return contourText(f.getGlyph(gid)._getContours())
      } catch {
        return ['unreadable']
      }
    }
    expect(outline(back, sK)).not.toEqual(outline(font, gK))
    expect(outline(back, sa)).not.toEqual(outline(font, ga))
  })

  it('a simple glyph: points, on-curve flags, short and long deltas, contours; nothing for an empty glyph', () => {
    const contours: OutlinePoint[][] = [
      [
        { x: 0, y: 0, onCurve: true },
        { x: 300, y: 0, onCurve: true }, // a long x delta
        { x: 300, y: 10, onCurve: false }, // a short y delta, off curve
        { x: 290, y: 700, onCurve: true }, // a long y delta, a negative short x
      ],
      [
        { x: 100, y: 100, onCurve: true },
        { x: 100, y: 100, onCurve: true }, // the same point twice (both deltas 0)
        { x: -40, y: -5, onCurve: true }, // negatives
      ],
    ]
    const g = encodeSimpleGlyph(contours)
    expect(g.length % 4).toBe(0)
    const v = new DataView(g.buffer)
    expect(v.getInt16(0)).toBe(2) // contours
    expect([v.getInt16(2), v.getInt16(4), v.getInt16(6), v.getInt16(8)]).toEqual([-40, -5, 300, 700])
    expect([v.getUint16(10), v.getUint16(12)]).toEqual([3, 6]) // end points
    expect(v.getUint16(14)).toBe(0) // no instructions
    // one flag a point: on curve 0x01, x short 0x02, y short 0x04, x same or positive 0x10, y same or positive 0x20
    expect([...g.subarray(16, 23)]).toEqual([0x31, 0x21, 0x34, 0x03, 0x03, 0x31, 0x07])
    // x deltas: 300 a word; -10, -190, -140 bytes (their sign in the flags)
    expect([...g.subarray(23, 28)]).toEqual([0x01, 0x2c, 10, 190, 140])
    // y deltas: 10 a byte; 690 and -600 words; -105 a byte
    expect([...g.subarray(28, 34)]).toEqual([10, 0x02, 0xb2, 0xfd, 0xa8, 105])
    expect(g.length).toBe(36) // 34 bytes, padded to 4
    expect(encodeSimpleGlyph([])).toEqual(new Uint8Array(0))
    expect(encodeSimpleGlyph([[]])).toEqual(new Uint8Array(0))
  })
})
