// One vector PDF page from a frame's SVG (wave N, N6-3/N6-4), drawn with @cantoo/pdf-lib's drawSvg:
//  - text: each line split by the face that draws each character (./text-layout.ts), every run drawn in an embedded
//    subset of Lobby's own font file for that range (fetched same-origin, embedded through fontkit), so the text is
//    real, selectable and searchable in every script Lobby's fonts cover; characters no Lobby font has (emoji) are
//    drawn as small pictures at their place;
//  - images: taken out of the SVG and drawn natively (embedJpg / embedPng; other formats transcoded) at their
//    transform, under their crop mask and their symbol's viewport, so photos keep their pixels and text stays vector
//    (Excalidraw writes an image's rounded-corner clip-path in the SVG namespace, which browsers ignore: so does
//    this);
//  - shapes: drawSvg, element by element in paint order, each with its resolved transform and style; dashed strokes
//    natively (drawSvg drops dashes); clip paths and masks (frame clips, an arrow label's hole) as PDF clips;
//  - Lobby's soft note shadow (an SVG filter) as a light offset copy of the note.
// Anything else the probe names (./svg-scene.ts) makes the page an image page instead (the raster fallback), as does
// any failure here: `prepareVectorFrame` reports why, and nothing is added to the document.
//
// No DOM: the worker supplies font bytes, image transcoding and glyph pictures (./worker-deps.ts), and the tests
// supply their own.

import {
  appendBezierCurve,
  appendQuadraticCurve,
  clip,
  clipEvenOdd,
  closePath,
  colorString,
  endPath,
  FillRule,
  LineCapStyle,
  lineTo,
  moveTo,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFOperator,
  type PDFPage,
  type PDFRef,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
} from '@cantoo/pdf-lib'
import { FACES_METADATA_ID } from '../../../canvas/export/fonts.ts'
import {
  applyMatrix,
  type ClipRef,
  hrefOf,
  IDENTITY,
  type Matrix,
  multiply,
  num,
  ownStyle,
  parseTransform,
  readScene,
  type SvgScene,
  scaling,
  symbolImage,
  translation,
} from './svg-scene.ts'
import { escapeAttr, escapeText, refId, type XElement } from './svg-tree.ts'
import {
  type Draw,
  FaceIndex,
  hasRtl,
  layoutText,
  type Measure,
  type PdfFace,
  parseFaceTable,
} from './text-layout.ts'

/** A picture of characters no Lobby font has (emoji), drawn by the browser. Sizes in the text's user units. */
export interface GlyphPicture {
  readonly png: Uint8Array
  readonly width: number
  readonly ascent: number
  readonly descent: number
}

/** What the page needs from its environment (the worker's, or a test's). */
export interface VectorDeps {
  /** a Lobby font file's bytes (same-origin), or null when it cannot be read */
  fetchFace(url: string): Promise<Uint8Array | null>
  /** an image pdf-lib cannot embed (WebP, GIF…) as PNG or JPEG, or null when this environment cannot */
  transcode?(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; type: 'png' | 'jpeg' } | null>
  /** characters no Lobby font draws, as a picture, or null when this environment cannot */
  glyphs?(text: string, sizePx: number, bold: boolean, color: string): Promise<GlyphPicture | null>
}

export type VectorOutcome = { readonly vector: true } | { readonly vector: false; readonly reason: string }

/** Where the frame goes on the page, in PDF points (`top`: the PDF y of its top edge). */
export interface PageArea {
  readonly x: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const fmt = (n: number) => {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? '0' : String(r)
}
const matrixAttr = (m: Matrix) => `matrix(${m.map(fmt).join(' ')})`

function bytesOfDataUrl(href: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]+);base64,/i.exec(href)
  if (!m) return null
  try {
    const bin = atob(href.slice(m[0].length).replace(/\s+/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, mime: (m[1] as string).toLowerCase() }
  } catch {
    return null
  }
}

/** FNV-1a over a string (the image cache key across pages: the same photo on several frames is embedded once). */
function hashOf(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}:${s.length}`
}

const isPng = (b: Uint8Array) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/** The document's shared fonts, images and glyph pictures (embedded once, used by every page). */
export class VectorResources {
  private readonly faces = new Map<string, Promise<PDFFont | null>>()
  private readonly standard = new Map<boolean, Promise<PDFFont>>()
  private readonly images = new Map<string, Promise<PDFImage | null>>()
  private readonly glyphs = new Map<string, Promise<{ image: PDFImage; pic: GlyphPicture } | null>>()
  /** objects embedded for the page being prepared (dropped from the file when it falls back) */
  private pageRefs: PDFRef[] = []
  private pageKeys: string[] = []
  /** the font family keys drawSvg reads (`fonts` option) */
  private readonly keys = new Map<PDFFont, string>()

  readonly doc: PDFDocument
  readonly deps: VectorDeps
  constructor(doc: PDFDocument, deps: VectorDeps) {
    this.doc = doc
    this.deps = deps
  }

  face(face: PdfFace): Promise<PDFFont | null> {
    let p = this.faces.get(face.url)
    if (!p) {
      p = (async () => {
        const bytes = await this.deps.fetchFace(face.url).catch(() => null)
        if (!bytes) return null
        try {
          // throws without a registered fontkit, or for a file fontkit cannot read
          return await this.doc.embedFont(bytes, { subset: true })
        } catch {
          return null
        }
      })()
      this.faces.set(face.url, p)
    }
    return p
  }

  helvetica(bold: boolean): Promise<PDFFont> {
    let p = this.standard.get(bold)
    if (!p) {
      p = this.doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)
      this.standard.set(bold, p)
    }
    return p
  }

  private async embedRaster(bytes: Uint8Array, mime: string): Promise<PDFImage | null> {
    let data = bytes
    let type: 'png' | 'jpeg' | null = isPng(bytes) ? 'png' : isJpeg(bytes) ? 'jpeg' : null
    if (!type) {
      const t = (await this.deps.transcode?.(bytes, mime).catch(() => null)) ?? null
      if (!t) return null
      data = t.bytes
      type = t.type
    }
    const image = type === 'png' ? await this.doc.embedPng(data) : await this.doc.embedJpg(data)
    await image.embed() // written now, so a fallback can drop it again (pdf-build.ts discardPage)
    this.pageRefs.push(image.ref)
    return image
  }

  image(href: string): Promise<PDFImage | null> {
    const key = hashOf(href)
    let p = this.images.get(key)
    if (!p) {
      const decoded = bytesOfDataUrl(href)
      p = decoded ? this.embedRaster(decoded.bytes, decoded.mime).catch(() => null) : Promise.resolve(null)
      this.images.set(key, p)
      this.pageKeys.push(key)
    }
    return p
  }

  glyph(text: string, sizePx: number, bold: boolean, color: string) {
    const key = `${text}\u0000${sizePx}\u0000${bold}\u0000${color}`
    let p = this.glyphs.get(key)
    if (!p) {
      p = (async () => {
        const pic = (await this.deps.glyphs?.(text, sizePx, bold, color).catch(() => null)) ?? null
        if (!pic || !isPng(pic.png)) return null
        const image = await this.doc.embedPng(pic.png)
        await image.embed()
        this.pageRefs.push(image.ref)
        return { image, pic }
      })().catch(() => null)
      this.glyphs.set(key, p)
      this.pageKeys.push(`g:${key}`)
    }
    return p
  }

  /** The family key drawSvg's `fonts` map knows this font by. */
  keyOf(font: PDFFont): string {
    let k = this.keys.get(font)
    if (!k) {
      k = `LobbyPdfFont${this.keys.size}`
      this.keys.set(font, k)
    }
    return k
  }

  fontsMap(): Record<string, PDFFont> {
    const out: Record<string, PDFFont> = {}
    for (const [font, key] of this.keys) out[key] = font
    return out
  }

  /** Starts a page: what it embeds from now on is its own until `keepPage`. */
  beginPage() {
    this.pageRefs = []
    this.pageKeys = []
  }
  keepPage() {
    this.pageRefs = []
    this.pageKeys = []
  }
  /** The page fell back: the images and pictures embedded for it alone leave the file (and the caches). */
  discardPage() {
    for (const ref of this.pageRefs) this.doc.context.delete(ref)
    for (const k of this.pageKeys) {
      if (k.startsWith('g:')) this.glyphs.delete(k.slice(2))
      else this.images.delete(k)
    }
    this.pageRefs = []
    this.pageKeys = []
  }
}

// ---- drawing program --------------------------------------------------------------------------------------------

type Op =
  /** an element drawSvg draws (serialized, flat, with its matrix) */
  | { readonly kind: 'svg'; readonly xml: string; readonly clips: readonly ClipRef[] }
  /** an image drawn natively: unit square → PDF by `matrix` (root user space), clipped by `local` rects */
  | {
      readonly kind: 'image'
      readonly image: PDFImage
      readonly matrix: Matrix
      readonly opacity: number
      readonly clips: readonly ClipRef[]
      /** a clip rect in the image element's own user space (a symbol's viewport) */
      readonly box: { readonly ctm: Matrix; readonly w: number; readonly h: number } | null
    }
  /** a dashed stroke, drawn natively */
  | {
      readonly kind: 'dash'
      readonly d: string
      readonly ctm: Matrix
      readonly style: Readonly<Record<string, string>>
      readonly opacity: number
      readonly clips: readonly ClipRef[]
    }

const clipKey = (clips: readonly ClipRef[]) =>
  clips.map((c) => `${c.kind}#${c.el.attrs.id}@${c.ctm.join(',')}`).join('|')

/** The prepared page: drawn by `drawVectorFrame` without any more waiting. */
export interface PreparedFrame {
  readonly scene: SvgScene
  readonly ops: readonly Op[]
}

interface Colour {
  rgb: ReturnType<typeof colorString>['rgb']
  alpha: number
}
function colour(v: string | undefined): Colour | null {
  if (!v || v === 'none' || v === 'transparent') return null
  const c = v === 'currentColor' ? 'black' : v
  try {
    const parsed = colorString(c)
    const a = parsed.alpha === undefined ? 1 : Number(parsed.alpha)
    return { rgb: parsed.rgb, alpha: Number.isFinite(a) ? a : 1 }
  } catch {
    return null
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Paint properties folded into explicit attributes (drawSvg does not multiply a group's opacity in). */
function paintAttrs(style: Readonly<Record<string, string>>, opacity: number, withStroke: boolean): string[] {
  const out: string[] = []
  const fill = style.fill ?? 'black'
  const fc = colour(fill)
  if (fc) {
    out.push(`fill="${escapeAttr(fill)}"`)
    out.push(`fill-opacity="${fmt(clamp01(opacity * (num(style['fill-opacity'] ?? '1') ?? 1) * fc.alpha))}"`)
  } else out.push('fill="none"')
  const sc = withStroke ? colour(style.stroke) : null
  if (sc) {
    out.push(`stroke="${escapeAttr(style.stroke as string)}"`)
    out.push(
      `stroke-opacity="${fmt(clamp01(opacity * (num(style['stroke-opacity'] ?? '1') ?? 1) * sc.alpha))}"`,
    )
    out.push(`stroke-width="${fmt(num(style['stroke-width'] ?? '1') ?? 1)}"`)
    for (const k of ['stroke-linecap', 'stroke-linejoin'] as const)
      if (style[k]) out.push(`${k}="${escapeAttr(style[k] as string)}"`)
  }
  if (style['fill-rule']) out.push(`fill-rule="${escapeAttr(style['fill-rule'])}"`)
  return out
}

const GEOMETRY: Record<string, readonly string[]> = {
  path: ['d'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
}

function shapeXml(name: string, source: XElement, ctm: Matrix, paint: string[], d?: string): string {
  // a rect's missing rx or ry is the other one (SVG's auto); drawSvg would draw square corners
  const el =
    name === 'rect' && (source.attrs.rx === undefined) !== (source.attrs.ry === undefined)
      ? {
          ...source,
          attrs: {
            ...source.attrs,
            rx: source.attrs.rx ?? source.attrs.ry ?? '0',
            ry: source.attrs.ry ?? source.attrs.rx ?? '0',
          },
        }
      : source
  const geo = (GEOMETRY[name] ?? [])
    .map((k) =>
      (k === 'd' && d !== undefined ? d : el.attrs[k]) !== undefined
        ? `${k}="${escapeAttr((k === 'd' && d !== undefined ? d : el.attrs[k]) as string)}"`
        : '',
    )
    .filter(Boolean)
  return `<${name} transform="${matrixAttr(ctm)}" ${[...geo, ...paint].join(' ')}></${name}>`
}

const pointsPath = (points: string, close: boolean) => {
  const nums = points
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (nums.length < 4) return ''
  let d = `M${fmt(nums[0] as number)} ${fmt(nums[1] as number)}`
  for (let i = 2; i + 1 < nums.length; i += 2)
    d += ` L${fmt(nums[i] as number)} ${fmt(nums[i + 1] as number)}`
  return close ? `${d} Z` : d
}

const dashes = (v: string | undefined): number[] | null => {
  if (!v || v === 'none') return null
  const list = v
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => num(s))
  if (list.some((n) => n === null || (n as number) < 0)) return null
  const n = list as number[]
  if (n.every((x) => x === 0)) return null
  return n.length % 2 ? [...n, ...n] : n
}

/**
 * Reads, probes and prepares a frame's SVG: fonts, images and glyph pictures embedded, every element turned into a
 * drawing step. Returns why it cannot be a vector page instead (nothing is drawn; the caller draws an image page).
 */
export async function prepareVectorFrame(
  svgText: string,
  res: VectorResources,
): Promise<{ ok: true; frame: PreparedFrame } | { ok: false; reason: string }> {
  let scene: SvgScene
  try {
    scene = readScene(svgText)
  } catch {
    return { ok: false, reason: 'the frame’s drawing could not be read' }
  }
  if (scene.problems.length) return { ok: false, reason: `it uses ${scene.problems.join(', ')}` }
  const faces = new FaceIndex(parseFaceTable(scene.metadata.get(FACES_METADATA_ID)))
  const texts = scene.leaves.filter((l) => l.el.name === 'text')
  if (texts.some((t) => hasRtl(t.el))) return { ok: false, reason: 'it has right-to-left text' }

  // pass 1: which fonts and glyph pictures the text needs (any measure will do to find them)
  const rough: Measure = {
    width: (_d, text, size) => text.length * size * 0.5,
    ascent: (_d, size) => size * 0.8,
    descent: (_d, size) => size * 0.2,
  }
  const needFaces = new Set<PdfFace>()
  const needGlyphs = new Map<string, { text: string; size: number; bold: boolean; fill: string }>()
  for (const t of texts)
    for (const r of layoutText(t.el, t.style, faces, rough, ownStyle)) {
      if (r.draw.kind === 'face') needFaces.add(r.draw.face)
      else if (r.draw.kind === 'glyph')
        needGlyphs.set(`${r.text}\u0000${r.sizePx}\u0000${r.bold}\u0000${r.fill}`, {
          text: r.text,
          size: r.sizePx,
          bold: r.bold,
          fill: r.fill,
        })
    }
  const fontOf = new Map<PdfFace, PDFFont>()
  for (const face of needFaces) {
    const f = await res.face(face)
    if (!f) return { ok: false, reason: `the font ${face.family} could not be embedded` }
    fontOf.set(face, f)
  }
  // the standard font measures spaces between runs too
  const helv = await res.helvetica(false)
  const helvBold = await res.helvetica(true)
  const glyphOf = new Map<string, { image: PDFImage; pic: GlyphPicture }>()
  for (const [key, g] of needGlyphs) {
    const got = await res.glyph(g.text, g.size, g.bold, g.fill)
    if (!got) return { ok: false, reason: 'it has characters none of Lobby’s fonts can show' }
    glyphOf.set(key, got)
  }
  const fontFor = (d: Draw, bold: boolean): PDFFont =>
    d.kind === 'face' ? (fontOf.get(d.face) ?? helv) : bold ? helvBold : helv
  const glyphKey = (text: string, size: number, bold: boolean, fill: string) =>
    `${text}\u0000${size}\u0000${bold}\u0000${fill}`
  const measure: Measure = {
    width: (d, text, size, bold) => {
      if (d.kind === 'glyph') {
        // a glyph run is measured as its picture (keyed by its own fill, found below); fall back to the size
        for (const [k, g] of glyphOf)
          if (k.startsWith(`${text}\u0000${size}\u0000${bold}\u0000`)) return g.pic.width
        return size
      }
      return fontFor(d, bold).widthOfTextAtSize(text, size)
    },
    ascent: (d, size, bold) =>
      d.kind === 'glyph' ? size * 0.8 : fontFor(d, bold).heightAtSize(size, { descender: false }),
    descent: (d, size, bold) => {
      if (d.kind === 'glyph') return size * 0.2
      const f = fontFor(d, bold)
      return Math.max(0, f.heightAtSize(size) - f.heightAtSize(size, { descender: false }))
    },
  }

  // pass 2: the drawing steps, in paint order
  const ops: Op[] = []
  for (const leaf of scene.leaves) {
    const { el, ctm, style, opacity, clips } = leaf
    switch (el.name) {
      case 'text': {
        for (const r of layoutText(el, style, faces, measure, ownStyle)) {
          if (r.draw.kind === 'glyph') {
            const g = glyphOf.get(glyphKey(r.text, r.sizePx, r.bold, r.fill))
            if (!g) return { ok: false, reason: 'it has characters none of Lobby’s fonts can show' }
            const top = r.y - g.pic.ascent
            const h = g.pic.ascent + g.pic.descent
            ops.push({
              kind: 'image',
              image: g.image,
              matrix: multiply(ctm, [g.pic.width, 0, 0, -h, r.x, top + h]),
              opacity: clamp01(opacity * r.fillOpacity),
              clips,
              box: null,
            })
            continue
          }
          const font = fontFor(r.draw, r.bold)
          const key = res.keyOf(font)
          const fc = colour(r.fill)
          if (!fc) continue
          const fo = clamp01(opacity * r.fillOpacity * fc.alpha)
          ops.push({
            kind: 'svg',
            clips,
            xml:
              `<text transform="${matrixAttr(ctm)}" x="${fmt(r.x)}" y="${fmt(r.y)}" font-family="${key}" ` +
              `font-size="${fmt(r.sizePx)}" font-weight="400" font-style="normal" fill="${escapeAttr(r.fill)}" ` +
              `fill-opacity="${fmt(fo)}">${escapeText(r.text)}</text>`,
          })
        }
        break
      }
      case 'use':
      case 'image': {
        const imageEl =
          el.name === 'use' ? symbolImage(scene.ids.get(refId(hrefOf(el)) ?? '') as XElement) : el
        if (!imageEl) return { ok: false, reason: 'it reuses an element that is not an image' }
        const image = await res.image(hrefOf(imageEl))
        if (!image) return { ok: false, reason: 'an image could not be embedded' }
        const viewport =
          el.name === 'use'
            ? { w: num(el.attrs.width) ?? 0, h: num(el.attrs.height) ?? 0 }
            : { w: num(el.attrs.width) ?? image.width, h: num(el.attrs.height) ?? image.height }
        const len = (v: string | undefined, of: number, natural: number) => {
          if (v === undefined) return el.name === 'use' ? of : natural
          const pct = /^([\d.]+)%$/.exec(v.trim())
          return pct ? (Number(pct[1]) / 100) * of : (num(v) ?? natural)
        }
        let w = len(imageEl.attrs.width, viewport.w, image.width)
        let h = len(imageEl.attrs.height, viewport.h, image.height)
        let ix = num(imageEl.attrs.x) ?? 0
        let iy = num(imageEl.attrs.y) ?? 0
        const par = (imageEl.attrs.preserveAspectRatio ?? 'xMidYMid meet').trim()
        if (par !== 'none') {
          // meet (the default): the whole image, centred in its box
          if (!/^xMidYMid( meet)?$/.test(par))
            return { ok: false, reason: 'an image with its own aspect rule' }
          const s = Math.min(w / image.width, h / image.height)
          const fw = image.width * s
          const fh = image.height * s
          ix += (w - fw) / 2
          iy += (h - fh) / 2
          w = fw
          h = fh
        }
        if (!(w > 0 && h > 0)) continue
        // a symbol's <image> brings its own transform and opacity; a plain <image> leaf has them in its ctm already
        const viaUse = el.name === 'use'
        const imgCtm = viaUse ? multiply(ctm, parseTransform(imageEl.attrs.transform) ?? IDENTITY) : ctm
        ops.push({
          kind: 'image',
          image,
          matrix: multiply(imgCtm, [w, 0, 0, -h, ix, iy + h]),
          opacity: clamp01(opacity * (viaUse ? (num(ownStyle(imageEl).opacity ?? '1') ?? 1) : 1)),
          clips,
          box: el.name === 'use' ? { ctm, w: viewport.w, h: viewport.h } : null,
        })
        break
      }
      default: {
        const dash = dashes(style['stroke-dasharray'])
        const name = el.name === 'polyline' || el.name === 'polygon' ? 'path' : el.name
        const d =
          el.name === 'polyline' || el.name === 'polygon'
            ? pointsPath(el.attrs.points ?? '', el.name === 'polygon')
            : undefined
        if (leaf.noteShadow && (name === 'path' || name === 'rect')) {
          // Lobby's soft note shadow (two blurred, offset copies of the note's alpha): a light copy 3 px down
          const shadow = multiply(translation(0, 3), ctm)
          ops.push({
            kind: 'svg',
            clips,
            xml: shapeXml(
              name,
              el,
              shadow,
              [`fill="#000000"`, `fill-opacity="${fmt(clamp01(opacity * 0.12))}"`],
              d,
            ),
          })
        }
        const strokedHere = !dash || name === 'line'
        if (name === 'line' && dash) {
          // a dashed <line>: drawn natively as a path
          const x1 = num(el.attrs.x1) ?? 0
          const y1 = num(el.attrs.y1) ?? 0
          const x2 = num(el.attrs.x2) ?? 0
          const y2 = num(el.attrs.y2) ?? 0
          ops.push({
            kind: 'dash',
            d: `M${fmt(x1)} ${fmt(y1)} L${fmt(x2)} ${fmt(y2)}`,
            ctm,
            style,
            opacity,
            clips,
          })
          break
        }
        ops.push({
          kind: 'svg',
          clips,
          xml: shapeXml(name, el, ctm, paintAttrs(style, opacity, strokedHere), d),
        })
        if (dash && colour(style.stroke)) {
          const pathD =
            name === 'path'
              ? (d ?? el.attrs.d ?? '')
              : name === 'rect' || name === 'circle' || name === 'ellipse'
                ? shapePath(el)
                : ''
          if (!pathD) return { ok: false, reason: `a dashed <${el.name}>` }
          ops.push({ kind: 'dash', d: pathD, ctm, style, opacity, clips })
        }
      }
    }
  }
  return { ok: true, frame: { scene, ops } }
}

/** A rect, circle or ellipse as path data (for a dashed outline drawn natively). */
function shapePath(el: XElement): string {
  const k = 0.5522847498
  if (el.name === 'rect') {
    const x = num(el.attrs.x) ?? 0
    const y = num(el.attrs.y) ?? 0
    const w = num(el.attrs.width) ?? 0
    const h = num(el.attrs.height) ?? 0
    const rx0 = num(el.attrs.rx)
    const ry0 = num(el.attrs.ry)
    const rx = Math.min(w / 2, rx0 ?? ry0 ?? 0)
    const ry = Math.min(h / 2, ry0 ?? rx0 ?? 0)
    if (!rx || !ry)
      return `M${fmt(x)} ${fmt(y)} L${fmt(x + w)} ${fmt(y)} L${fmt(x + w)} ${fmt(y + h)} L${fmt(x)} ${fmt(y + h)} Z`
    const c = (a: number, b: number) => `${fmt(a)} ${fmt(b)}`
    return (
      `M${c(x + rx, y)} L${c(x + w - rx, y)} C${c(x + w - rx + rx * k, y)} ${c(x + w, y + ry - ry * k)} ${c(x + w, y + ry)} ` +
      `L${c(x + w, y + h - ry)} C${c(x + w, y + h - ry + ry * k)} ${c(x + w - rx + rx * k, y + h)} ${c(x + w - rx, y + h)} ` +
      `L${c(x + rx, y + h)} C${c(x + rx - rx * k, y + h)} ${c(x, y + h - ry + ry * k)} ${c(x, y + h - ry)} ` +
      `L${c(x, y + ry)} C${c(x, y + ry - ry * k)} ${c(x + rx - rx * k, y)} ${c(x + rx, y)} Z`
    )
  }
  const cx = num(el.attrs.cx) ?? 0
  const cy = num(el.attrs.cy) ?? 0
  const rx = el.name === 'circle' ? (num(el.attrs.r) ?? 0) : (num(el.attrs.rx) ?? 0)
  const ry = el.name === 'circle' ? (num(el.attrs.r) ?? 0) : (num(el.attrs.ry) ?? 0)
  if (!rx || !ry) return ''
  const c = (a: number, b: number) => `${fmt(a)} ${fmt(b)}`
  return (
    `M${c(cx + rx, cy)} C${c(cx + rx, cy + ry * k)} ${c(cx + rx * k, cy + ry)} ${c(cx, cy + ry)} ` +
    `C${c(cx - rx * k, cy + ry)} ${c(cx - rx, cy + ry * k)} ${c(cx - rx, cy)} ` +
    `C${c(cx - rx, cy - ry * k)} ${c(cx - rx * k, cy - ry)} ${c(cx, cy - ry)} ` +
    `C${c(cx + rx * k, cy - ry)} ${c(cx + rx, cy - ry * k)} ${c(cx + rx, cy)} Z`
  )
}

// ---- clips as PDF operators ---------------------------------------------------------------------------------------
// A clip path is built in PAGE coordinates (each point mapped here): a PDF path object may not contain `cm`, so the
// transform is applied to the points, which is exact for lines and Bézier curves under an affine map.

/** Absolute or relative M/L/H/V/C/Q/Z path data → PDF path operators, every point mapped by `m`. */
function pathOps(d: string, m: Matrix): PDFOperator[] | null {
  const tokens = d.match(/[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
  const ops: PDFOperator[] = []
  const p = (x: number, y: number) => applyMatrix(m, x, y)
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  const next = () => Number(tokens[i++])
  while (i < tokens.length) {
    const t = tokens[i] as string
    if (/[A-Za-z]/.test(t)) {
      cmd = t
      i++
      if (cmd === 'Z' || cmd === 'z') {
        ops.push(closePath())
        x = sx
        y = sy
        continue
      }
    }
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + next()
        y = oy + next()
        sx = x
        sy = y
        ops.push(moveTo(...p(x, y)))
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
        x = ox + next()
        y = oy + next()
        ops.push(lineTo(...p(x, y)))
        break
      case 'H':
        x = ox + next()
        ops.push(lineTo(...p(x, y)))
        break
      case 'V':
        y = oy + next()
        ops.push(lineTo(...p(x, y)))
        break
      case 'C': {
        const c1 = p(ox + next(), oy + next())
        const c2 = p(ox + next(), oy + next())
        x = ox + next()
        y = oy + next()
        ops.push(appendBezierCurve(...c1, ...c2, ...p(x, y)))
        break
      }
      case 'Q': {
        const c1 = p(ox + next(), oy + next())
        x = ox + next()
        y = oy + next()
        ops.push(appendQuadraticCurve(...c1, ...p(x, y)))
        break
      }
      default:
        return null
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  }
  return ops
}

/** One shape of a clip path or mask (its own transform applied), as path operators mapped into page space by `m`. */
function shapeOps(el: XElement, m: Matrix): PDFOperator[] | null {
  const transform = parseTransform(el.attrs.transform)
  if (!transform) return null
  const d = el.name === 'path' ? (el.attrs.d ?? '') : shapePath(el)
  return d ? pathOps(d, multiply(m, transform)) : null
}

const isWhiteFill = (s: XElement, mask: XElement) =>
  /^(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i.test(
    (ownStyle(s).fill ?? ownStyle(mask).fill ?? 'black').trim(),
  )

/** PDF operators that clip to one clip path or mask whose user space maps to the page by `toPage`. */
function clipOps(ref: ClipRef, toPage: Matrix): PDFOperator[] | null {
  const out: PDFOperator[] = []
  const space = multiply(toPage, ref.ctm)
  const shapes = ref.el.children.filter(
    (c): c is XElement => typeof c !== 'string' && c.name !== 'title' && c.name !== 'desc',
  )
  if (ref.kind === 'clip-path') {
    // the union of the shapes (non-zero): every shape's path, one clip
    for (const s of shapes) {
      const ops = shapeOps(s, space)
      if (!ops) return null
      out.push(...ops)
    }
    out.push(clip(), endPath())
    return out
  }
  // a mask: the white rect minus the black ones (even-odd); then the mask's own region when it has one
  const white = shapes.filter((s) => isWhiteFill(s, ref.el))
  const black = shapes.filter((s) => !white.includes(s))
  for (const s of [...white, ...black]) {
    const ops = shapeOps(s, space)
    if (!ops) return null
    out.push(...ops)
  }
  out.push(black.length ? clipEvenOdd() : clip(), endPath())
  if (ref.el.attrs.maskUnits === 'userSpaceOnUse') {
    const region = shapeOps(
      {
        name: 'rect',
        attrs: {
          x: ref.el.attrs.x ?? '0',
          y: ref.el.attrs.y ?? '0',
          width: ref.el.attrs.width ?? '0',
          height: ref.el.attrs.height ?? '0',
        },
        children: [],
      },
      space,
    )
    if (!region) return null
    out.push(...region, clip(), endPath())
  }
  return out
}

/** Clips to the rect (0, 0, w, h) of a user space that maps to the page by `toPage × ctm`. */
function rectClipOps(ctm: Matrix, toPage: Matrix, w: number, h: number): PDFOperator[] {
  const m = multiply(toPage, ctm)
  const p = (x: number, y: number) => applyMatrix(m, x, y)
  return [
    moveTo(...p(0, 0)),
    lineTo(...p(w, 0)),
    lineTo(...p(w, h)),
    lineTo(...p(0, h)),
    closePath(),
    clip(),
    endPath(),
  ]
}

const CAPS: Record<string, LineCapStyle> = {
  butt: LineCapStyle.Butt,
  round: LineCapStyle.Round,
  square: LineCapStyle.Projecting,
}

/**
 * Draws a prepared frame into `area` of `page`. Throws when the fork's drawing fails (the caller then removes the
 * page and draws an image page instead).
 */
export function drawVectorFrame(
  page: PDFPage,
  frame: PreparedFrame,
  area: PageArea,
  res: VectorResources,
): void {
  const vb = frame.scene.viewBox
  const s = Math.min(area.width / vb.width, area.height / vb.height)
  const dx = (area.width - vb.width * s) / 2
  const dy = (area.height - vb.height * s) / 2
  // root user space → PDF points (y up), exactly as drawSvg maps the root viewBox into {x, y, width, height}
  const toPage: Matrix = [s, 0, 0, -s, area.x + dx - s * vb.x, area.top - dy + s * vb.y]
  const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.width)} ${fmt(vb.height)}" width="${fmt(vb.width)}" height="${fmt(vb.height)}">`
  const drawOpts = { x: area.x, y: area.top, width: area.width, height: area.height, fonts: res.fontsMap() }
  const rootClip = rectClipOps(translation(vb.x, vb.y), toPage, vb.width, vb.height)

  let i = 0
  const ops = frame.ops
  while (i < ops.length) {
    const first = ops[i] as Op
    const key = clipKey(first.clips)
    // one clip group: the steps that share these clips, drawn inside one q … Q
    let j = i
    while (j < ops.length && clipKey((ops[j] as Op).clips) === key) j++
    const group = ops.slice(i, j)
    const clipped = first.clips.length > 0
    if (clipped) {
      page.pushOperators(pushGraphicsState())
      for (const c of first.clips) {
        const co = clipOps(c, toPage)
        if (!co) throw new Error('a clip could not be drawn')
        page.pushOperators(...co)
      }
    }
    let k = 0
    while (k < group.length) {
      const op = group[k] as Op
      if (op.kind === 'svg') {
        let xml = ''
        while (k < group.length && (group[k] as Op).kind === 'svg') {
          xml += (group[k] as Extract<Op, { kind: 'svg' }>).xml
          k++
        }
        page.drawSvg(`${svgOpen}${xml}</svg>`, drawOpts)
        continue
      }
      if (op.kind === 'image') {
        page.pushOperators(pushGraphicsState(), ...rootClip)
        if (op.box) page.pushOperators(...rectClipOps(op.box.ctm, toPage, op.box.w, op.box.h))
        page.drawImage(op.image, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: op.opacity,
          matrix: [...multiply(toPage, op.matrix)] as [number, number, number, number, number, number],
        })
        page.pushOperators(popGraphicsState())
      } else {
        const sc = colour(op.style.stroke)
        if (sc) {
          const m = multiply(multiply(toPage, op.ctm), scaling(1, -1))
          const list = dashes(op.style['stroke-dasharray']) ?? []
          page.pushOperators(pushGraphicsState(), ...rootClip)
          page.drawSvgPath(op.d, {
            x: 0,
            y: 0,
            borderColor: sc.rgb,
            borderWidth: num(op.style['stroke-width'] ?? '1') ?? 1,
            borderOpacity: clamp01(op.opacity * (num(op.style['stroke-opacity'] ?? '1') ?? 1) * sc.alpha),
            borderDashArray: list,
            borderDashPhase: num(op.style['stroke-dashoffset'] ?? '0') ?? 0,
            ...(CAPS[op.style['stroke-linecap'] ?? ''] !== undefined
              ? { borderLineCap: CAPS[op.style['stroke-linecap'] as string] as LineCapStyle }
              : {}),
            fillRule: op.style['fill-rule'] === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero,
            matrix: [...m] as [number, number, number, number, number, number],
          })
          page.pushOperators(popGraphicsState())
        }
      }
      k++
    }
    if (clipped) page.pushOperators(popGraphicsState())
    i = j
  }
}
