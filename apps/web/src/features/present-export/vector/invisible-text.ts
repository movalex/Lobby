// Invisible text for what a vector page draws without a font of its own (wave N.1): a character no Lobby font has,
// drawn as a picture by the browser (emoji, a symbol), and a space or a format character no font has, drawn as
// nothing. Each is written as text in a Type 3 font of empty glyphs, in text rendering mode 3 (invisible), where it
// is drawn and as wide, and the font's ToUnicode names each code's text exactly: a viewer's search, select and copy
// find it in its place, and the PDF's text is the board's.
//
// One code (a byte, 1–255) per distinct text and width; a font holds 255, then the next one starts. The fonts are
// written when the document is (`write`, from pdf-build.ts finish()). Pure pdf-lib objects: no font program, nothing
// fetched.
import { type PDFDocument, PDFName, type PDFRef } from '@cantoo/pdf-lib'

/** The codes of one font a run uses, as a text-showing operand (hex). */
export interface InvisibleSegment {
  readonly font: PDFRef
  readonly hex: string
}

interface Entry {
  readonly text: string
  /** the advance, 1/1000 of the font size */
  readonly width: number
}

const CODES_PER_FONT = 255

/** UTF-16BE, as ToUnicode names a code's text. */
const utf16Hex = (text: string) => {
  let out = ''
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return out
}
const byteHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase()

/** A ToUnicode CMap for one-byte codes 1..n (PDF 32000 9.10.3; at most 100 entries a bfchar block). */
function toUnicodeCmap(entries: readonly Entry[]): string {
  const blocks: string[] = []
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100)
    const lines = part.map((e, k) => `<${byteHex(i + k + 1)}> <${utf16Hex(e.text)}>`)
    blocks.push(`${part.length} beginbfchar\n${lines.join('\n')}\nendbfchar`)
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
}

export class InvisibleText {
  private readonly fonts: { readonly ref: PDFRef; readonly entries: Entry[] }[] = []
  private readonly codes = new Map<string, { readonly font: PDFRef; readonly code: number }>()
  private readonly doc: PDFDocument
  constructor(doc: PDFDocument) {
    this.doc = doc
  }

  private code(text: string, width: number) {
    const w = Math.max(0, Math.round(width))
    const key = `${w}\u0000${text}`
    let c = this.codes.get(key)
    if (!c) {
      let font = this.fonts[this.fonts.length - 1]
      if (!font || font.entries.length >= CODES_PER_FONT) {
        font = { ref: this.doc.context.nextRef(), entries: [] }
        this.fonts.push(font)
      }
      font.entries.push({ text, width: w })
      c = { font: font.ref, code: font.entries.length }
      this.codes.set(key, c)
    }
    return c
  }

  /**
   * A run's text as codes: one a piece (a grapheme cluster), each `widths[i]` wide (1/1000 of the font size), in as
   * many segments as fonts they fall in.
   */
  segments(pieces: readonly string[], widths: readonly number[]): InvisibleSegment[] {
    const out: { font: PDFRef; hex: string }[] = []
    pieces.forEach((piece, i) => {
      const c = this.code(piece, widths[i] ?? 0)
      const last = out[out.length - 1]
      if (last && last.font === c.font) last.hex += byteHex(c.code)
      else out.push({ font: c.font, hex: byteHex(c.code) })
    })
    return out
  }

  /** Writes every font (before the document is saved): empty glyphs, their widths, the ToUnicode map. */
  write() {
    const ctx = this.doc.context
    for (const font of this.fonts) {
      const charProcs = ctx.obj({})
      const differences: (number | PDFName)[] = [1]
      font.entries.forEach((e, i) => {
        const name = PDFName.of(`g${i + 1}`)
        charProcs.set(name, ctx.register(ctx.stream(`${e.width} 0 d0`)))
        differences.push(name)
      })
      const toUnicode = ctx.register(ctx.flateStream(toUnicodeCmap(font.entries)))
      ctx.assign(
        font.ref,
        ctx.obj({
          Type: 'Font',
          Subtype: 'Type3',
          FontBBox: [0, 0, 0, 0],
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: charProcs,
          Encoding: ctx.obj({ Type: 'Encoding', Differences: differences }),
          FirstChar: 1,
          LastChar: font.entries.length,
          Widths: font.entries.map((e) => e.width),
          Resources: ctx.obj({}),
          ToUnicode: toUnicode,
        }),
      )
    }
  }
}
