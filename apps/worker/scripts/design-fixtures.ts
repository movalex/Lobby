// Builders of the design-file fixtures (wave R, WS3; docs/WAVE-R-CONTRACTS.md §6) for make-fixtures.ts: Photoshop files
// written with ag-psd (and byte patches of them for what ag-psd cannot write: CMYK, 16-bit, lying headers), TIFF
// files written with sharp or by hand (multi-page, a pixel bomb), Illustrator files written with pdf-lib. All content
// is synthetic and non-sensitive.
import zlib from 'node:zlib'
import agPsd from 'ag-psd'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'

// ---- Photoshop -----------------------------------------------------------------------------------------------------

type Rgba = { width: number; height: number; data: Uint8ClampedArray }

/** A synthetic picture: a diagonal gradient, a dark band and (alpha) a transparent top-left corner. */
function picture(width: number, height: number, alpha: boolean, tint = 0): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const band = y > height * 0.4 && y < height * 0.6
      data[i] = band ? 30 : Math.round((255 * x) / width)
      data[i + 1] = band ? 30 : Math.round((255 * y) / height)
      data[i + 2] = band ? 30 : 160 + tint
      data[i + 3] = alpha && x < width / 8 && y < height / 8 ? 0 : 255
    }
  }
  return { width, height, data }
}

const versionInfo = (hasRealMergedData: boolean) => ({
  hasRealMergedData,
  writerName: 'Lobby fixtures',
  readerName: 'Lobby fixtures',
  fileVersion: 1,
})

async function jpegThumbnail(width: number, height: number) {
  const { data } = picture(width, height, false)
  const jpeg = await sharp(Buffer.from(data.buffer), { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .jpeg({ quality: 80 })
    .toBuffer()
  return { width, height, data: new Uint8Array(jpeg) }
}

/** A 1200x800 RGB PSD with a real composite (with transparency), two layers and an embedded thumbnail. */
export async function psd(opts: { psb?: boolean } = {}): Promise<Buffer> {
  const width = 1200
  const height = 800
  const doc = {
    width,
    height,
    imageData: picture(width, height, true),
    imageResources: { versionInfo: versionInfo(true), thumbnailRaw: await jpegThumbnail(160, 107) },
    children: [
      { name: 'Background', imageData: picture(width, height, false) },
      { name: 'Overlay', left: 100, top: 100, imageData: picture(200, 120, false, 90) },
    ],
  }
  return Buffer.from(agPsd.writePsdUint8Array(doc as never, { psb: opts.psb === true }))
}

/** Saved without "Maximize Compatibility": a blank composite, version info saying so, and maybe the thumbnail. */
export async function psdWithoutComposite(thumbnail: boolean): Promise<Buffer> {
  const width = 900
  const height = 600
  const blank = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }
  const doc = {
    width,
    height,
    imageData: blank,
    imageResources: {
      versionInfo: versionInfo(false),
      ...(thumbnail ? { thumbnailRaw: await jpegThumbnail(160, 107) } : {}),
    },
  }
  return Buffer.from(agPsd.writePsdUint8Array(doc as never))
}

/** `src` with its header's colour mode (offset 24) or depth (offset 22) changed: what ag-psd cannot write. */
export function patchPsdHeader(src: Buffer, field: 'mode' | 'depth', value: number): Buffer {
  const out = Buffer.from(src)
  out.writeUInt16BE(value, field === 'mode' ? 24 : 22)
  return out
}

/** Only a header and empty sections, claiming width x height: refused from its first 26 bytes. */
export function psdBombHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(26 + 4 + 4 + 4 + 2)
  b.write('8BPS', 0, 'latin1')
  b.writeUInt16BE(1, 4)
  b.writeUInt16BE(3, 12)
  b.writeUInt32BE(height, 14)
  b.writeUInt32BE(width, 18)
  b.writeUInt16BE(8, 22)
  b.writeUInt16BE(3, 24)
  return b // the sections are empty and the composite compression is 0, with no data at all
}

/** A small PSD whose layer section claims `count` layer records (none are there). */
export function psdManyLayers(count: number): Buffer {
  const head = psdBombHeader(64, 64).subarray(0, 26 + 4 + 4)
  const layerInfo = Buffer.alloc(4 + 4 + 2)
  layerInfo.writeUInt32BE(6, 0) // the layer and mask section's length
  layerInfo.writeUInt32BE(2, 4) // the layer info's length
  layerInfo.writeInt16BE(count, 8)
  const composite = Buffer.alloc(2 + 64 * 64 * 3, 0x80) // raw
  composite.writeUInt16BE(0, 0)
  return Buffer.concat([head, layerInfo, composite])
}

// ---- TIFF -----------------------------------------------------------------------------------------------------------

/** The 1600x1000 picture as a TIFF with `compression` (sharp/libvips, libtiff). */
export async function tiff(
  compression: 'lzw' | 'deflate' | 'jpeg' | 'packbits',
  colourspace: 'srgb' | 'cmyk' = 'srgb',
): Promise<Buffer> {
  const { width, height, data } = picture(1600, 1000, false)
  let s = sharp(Buffer.from(data.buffer), { raw: { width, height, channels: 4 } }).removeAlpha()
  if (colourspace === 'cmyk') s = s.toColourspace('cmyk')
  return s.tiff({ compression, quality: 85 }).toBuffer()
}

interface TiffPage {
  width: number
  height: number
  /** uncompressed 8-bit grey samples, or (compression 8) a deflate stream that claims to be them */
  strip: Buffer
  compression: 1 | 8
}

/** A little-endian TIFF written by hand: one 8-bit greyscale strip per page, pages chained as IFDs. */
export function tiffByHand(pages: TiffPage[]): Buffer {
  const parts: Buffer[] = []
  const header = Buffer.alloc(8)
  header.write('II', 0, 'latin1')
  header.writeUInt16LE(42, 2)
  header.writeUInt32LE(8, 4)
  parts.push(header)
  let offset = 8
  const ENTRIES = 9
  const ifdBytes = 2 + ENTRIES * 12 + 4
  for (const [n, p] of pages.entries()) {
    const stripAt = offset + ifdBytes
    const next = n === pages.length - 1 ? 0 : stripAt + p.strip.length + (p.strip.length & 1)
    const ifd = Buffer.alloc(ifdBytes)
    ifd.writeUInt16LE(ENTRIES, 0)
    const entry = (i: number, tag: number, type: 3 | 4, value: number) => {
      const o = 2 + i * 12
      ifd.writeUInt16LE(tag, o)
      ifd.writeUInt16LE(type, o + 2)
      ifd.writeUInt32LE(1, o + 4)
      if (type === 3) ifd.writeUInt16LE(value, o + 8)
      else ifd.writeUInt32LE(value, o + 8)
    }
    entry(0, 256, 4, p.width) // ImageWidth
    entry(1, 257, 4, p.height) // ImageLength
    entry(2, 258, 3, 8) // BitsPerSample
    entry(3, 259, 3, p.compression) // Compression
    entry(4, 262, 3, 1) // PhotometricInterpretation: BlackIsZero
    entry(5, 273, 4, stripAt) // StripOffsets
    entry(6, 277, 3, 1) // SamplesPerPixel
    entry(7, 278, 4, p.height) // RowsPerStrip
    entry(8, 279, 4, p.strip.length) // StripByteCounts
    ifd.writeUInt32LE(next, 2 + ENTRIES * 12)
    parts.push(ifd, p.strip)
    if (p.strip.length & 1) parts.push(Buffer.alloc(1))
    offset = next
  }
  return Buffer.concat(parts)
}

const greyPage = (width: number, height: number, shade: number): TiffPage => ({
  width,
  height,
  strip: Buffer.alloc(width * height, shade),
  compression: 1,
})

/** `count` small greyscale pages (a multi-page TIFF, or one with too many pages). */
export const tiffPages = (count: number, size = 64) =>
  tiffByHand(Array.from({ length: count }, (_, i) => greyPage(size, size, (40 + i * 37) % 256)))

/** A TIFF whose one page claims width x height, with a deflate strip of a few bytes (a decompression bomb). */
export const tiffBomb = (width: number, height: number) =>
  tiffByHand([{ width, height, strip: zlib.deflateSync(Buffer.alloc(4096)), compression: 8 }])

// ---- Illustrator ----------------------------------------------------------------------------------------------------

/** An Illustrator file saved with PDF content: a PDF whose pages are the artboards (pdf-lib, no dates). */
export async function illustrator(artboards: number): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setCreator('Adobe Illustrator 28.0 (Lobby fixture)')
  doc.setProducer('Lobby fixtures')
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let i = 1; i <= artboards; i++) {
    const page = doc.addPage([800, 600])
    page.drawRectangle({ x: 0, y: 0, width: 800, height: 600, color: rgb(0.98, 0.95, 0.9) })
    page.drawEllipse({ x: 400, y: 300, xScale: 220, yScale: 160, color: rgb(0.9, 0.3, 0.2) })
    page.drawText(`Artboard ${i}`, { x: 300, y: 290, size: 36, font: bold, color: rgb(1, 1, 1) })
  }
  return Buffer.from(await doc.save())
}

/** An Illustrator file saved without PDF content: one page with Illustrator's notice, as Illustrator writes it. */
export async function illustratorWithoutPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setCreator('Adobe Illustrator 28.0 (Lobby fixture)')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, 792])
  const lines = [
    'This is an Adobe Illustrator File that was',
    'saved without PDF Content.',
    'To Place or open this file in other',
    'applications, it should be re-saved from',
    'Adobe Illustrator with the "Create PDF',
    'Compatible File" option turned on.',
  ]
  for (const [i, line] of lines.entries()) page.drawText(line, { x: 72, y: 700 - i * 22, size: 16, font })
  return Buffer.from(await doc.save())
}

/** An old (PostScript) Illustrator file: no PDF in it at all. */
export const illustratorPostScript = () =>
  Buffer.from(
    '%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%Title: (legacy.ai)\n' +
      '%%BoundingBox: 0 0 200 200\n%%EndComments\n0 0 moveto 200 200 lineto stroke\nshowpage\n%%EOF\n',
  )

// ---- HEIC -----------------------------------------------------------------------------------------------------------

/** An ISO-BMFF `ftyp heic` box and filler: what a HEIC upload looks like to a sniffer (never decoded by Lobby). */
export function heic(): Buffer {
  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24, 0)
  ftyp.write('ftypheic', 4, 'latin1')
  ftyp.writeUInt32BE(0, 12)
  ftyp.write('mif1heic', 16, 'latin1')
  return Buffer.concat([ftyp, Buffer.alloc(2048, 0x11)])
}
