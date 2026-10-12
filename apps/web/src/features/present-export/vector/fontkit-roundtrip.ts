// Test support (wave N.1, N6-1), imported by tests only, never by the app: one font file through the adapted
// subsetter (./fontkit.ts) with EVERY glyph included, the subset read back with fontkit itself, and each glyph compared
// with the file's own: the same contours (points and on-curve flags, a composite as its components' points) and the
// same advance width. ./fontkit.test.ts runs it on the files the frame fixtures name, and
// apps/web/test/bundle/pdf-worker-chunk.test.ts on every font file the production build emits.
import * as pdfLibFontkit from '@pdf-lib/fontkit'
import { adaptFontkit, hasTransformedGlyf, type OutlinePoint } from './fontkit.ts'

interface Glyph {
  readonly advanceWidth: number
  _getContours(): OutlinePoint[][]
}
interface Font {
  readonly numGlyphs: number
  getGlyph(gid: number): Glyph
  createSubset(): {
    includeGlyph(g: number): number
    encodeStream(): { on(ev: string, cb: (d?: unknown) => void): unknown }
  }
  readonly hmtx: { metrics: HmtxMetrics }
}
/** fontkit's decoded hmtx metrics: an array, or its lazy array with get(i) */
interface HmtxMetrics {
  readonly length: number
  get?(i: number): { advance: number }
  readonly [i: number]: { advance: number }
}
interface Engine {
  create(b: Uint8Array): Font
}

const installed = pdfLibFontkit as unknown as { default?: Engine } & Engine
/** @pdf-lib/fontkit as it is installed (no adapter): to read subsets back. */
export const rawFontkit: Engine = installed.default ?? installed

/** A subset's bytes (fontkit's stream API, as @cantoo/pdf-lib reads it). */
export function subsetBytes(subset: ReturnType<Font['createSubset']>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = []
    const stream = subset.encodeStream()
    stream.on('data', (d) => parts.push(new Uint8Array(d as Uint8Array)))
    stream.on('error', (e) => reject(e))
    stream.on('end', () => {
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
      let o = 0
      for (const p of parts) {
        out.set(p, o)
        o += p.length
      }
      resolve(out)
    })
  })
}

/** Contours as comparable strings: "x,y" a point, "~" off curve. */
export const contourText = (contours: OutlinePoint[][]) =>
  contours.map((c) => c.map((p) => `${Math.round(p.x)},${Math.round(p.y)}${p.onCurve ? '' : '~'}`).join(' '))

/** The advance of glyph `gid` as hmtx stores it (the last metric repeats for the glyphs past it). */
function storedAdvance(font: Font, gid: number): number {
  const m = font.hmtx.metrics
  const at = (i: number) => (typeof m.get === 'function' ? m.get(i) : m[i]) as { advance: number }
  return at(Math.min(gid, m.length - 1)).advance
}

export interface RoundTrip {
  /** a woff2 with a transformed glyf table (every Lobby font file is one) */
  readonly transformed: boolean
  readonly glyphs: number
  /** "glyph 12: outline" / "glyph 12: advance 512 ≠ 500" / "glyph count 40 ≠ 41": empty when every glyph survived */
  readonly problems: string[]
}

export async function roundTripFontFile(bytes: Uint8Array): Promise<RoundTrip> {
  const font = (adaptFontkit(rawFontkit as never) as unknown as Engine).create(bytes)
  const subset = font.createSubset()
  const ids: number[] = []
  for (let gid = 0; gid < font.numGlyphs; gid++) ids.push(subset.includeGlyph(gid))
  const back = rawFontkit.create(await subsetBytes(subset))
  const problems: string[] = []
  if (back.numGlyphs !== font.numGlyphs) problems.push(`glyph count ${back.numGlyphs} ≠ ${font.numGlyphs}`)
  for (let gid = 0; gid < font.numGlyphs && problems.length < 5; gid++) {
    const sid = ids[gid] as number
    const want = font.getGlyph(gid)
    let got: string[]
    try {
      got = contourText(back.getGlyph(sid)._getContours())
    } catch (e) {
      problems.push(`glyph ${gid}: unreadable (${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    if (JSON.stringify(got) !== JSON.stringify(contourText(want._getContours())))
      problems.push(`glyph ${gid}: outline`)
    const adv = storedAdvance(back, sid)
    if (adv !== want.advanceWidth) problems.push(`glyph ${gid}: advance ${adv} ≠ ${want.advanceWidth}`)
  }
  return { transformed: hasTransformedGlyf(font), glyphs: font.numGlyphs, problems }
}
