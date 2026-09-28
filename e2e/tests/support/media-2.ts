// Helpers for media-2.spec.ts (PDF page viewer, extracted pages, animated GIFs). Test files are made
// here rather than kept in the repo: an animated GIF (a small GIF89a encoder, below) and a PDF with
// more pages than the worker previews (pdf-lib, an e2e devDependency).
import type { Locator, Page } from '@playwright/test'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import type { BoxLike, RecordLike } from './editor.ts'
import type { FilePayload, FilesEditor } from './files.ts'
import { readF } from './files.ts'

interface AssetLike extends RecordLike {
  type: string
  props: Record<string, unknown>
  meta: Record<string, unknown>
}

/** FilesEditor plus the asset and viewport calls these tests make (tldraw 5.4.2 Editor). */
export interface MediaEditor extends FilesEditor {
  getAsset(id: string): AssetLike | undefined
  getAssets(): AssetLike[]
  getViewportScreenBounds(): BoxLike
  redo(): MediaEditor
  reparentShapes(ids: string[], parentId: string): MediaEditor
}

/** `read` typed for MediaEditor (the callback is still serialized into the page). */
export function readM<T, A = undefined>(page: Page, fn: (editor: MediaEditor, arg: A) => T, arg?: A) {
  return readF<T, A>(page, fn as unknown as (e: FilesEditor, a: A) => T, arg)
}

// ---- animated GIF ----------------------------------------------------------------------------------

export interface GifFrame {
  /** Background colour of the frame, [r, g, b]. */
  bg: readonly [number, number, number]
  /** A block drawn on top (frame-local pixels), so consecutive frames differ in shape too. */
  block: { x: number; y: number; w: number; h: number; color: readonly [number, number, number] }
}

/**
 * A looping GIF89a with one global palette: each frame is a solid background plus one block, shown
 * for `delayCs` hundredths of a second. LZW as in omggif's GifWriter (MIT), minimum code size 8.
 */
export function makeAnimatedGif(w: number, h: number, frames: readonly GifFrame[], delayCs = 12): Buffer {
  const palette: [number, number, number][] = []
  const indexOf = (c: readonly [number, number, number]) => {
    const i = palette.findIndex((p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2])
    if (i !== -1) return i
    palette.push([c[0], c[1], c[2]])
    return palette.length - 1
  }
  const frameIndices = frames.map((f) => {
    const bg = indexOf(f.bg)
    const fg = indexOf(f.block.color)
    const px = new Uint8Array(w * h).fill(bg)
    for (let y = Math.max(0, f.block.y); y < Math.min(h, f.block.y + f.block.h); y++) {
      for (let x = Math.max(0, f.block.x); x < Math.min(w, f.block.x + f.block.w); x++) px[y * w + x] = fg
    }
    return px
  })
  if (palette.length > 256) throw new Error('at most 256 colours')
  const out: number[] = []
  const u16 = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff)
  const ascii = (s: string) => {
    for (const ch of s) out.push(ch.charCodeAt(0))
  }
  ascii('GIF89a')
  u16(w)
  u16(h)
  out.push(0xf7, 0, 0) // global colour table of 256 entries, colour resolution 8 bits
  for (let i = 0; i < 256; i++) out.push(...(palette[i] ?? [0, 0, 0]))
  // NETSCAPE2.0: loop forever.
  out.push(0x21, 0xff, 0x0b)
  ascii('NETSCAPE2.0')
  out.push(0x03, 0x01, 0x00, 0x00, 0x00)
  for (const px of frameIndices) {
    out.push(0x21, 0xf9, 0x04, 0x04) // graphic control: disposal "do not dispose", no transparency
    u16(delayCs)
    out.push(0x00, 0x00)
    out.push(0x2c)
    u16(0)
    u16(0)
    u16(w)
    u16(h)
    out.push(0x00) // no local colour table, not interlaced
    out.push(8) // LZW minimum code size
    const data = lzw(px, 8)
    for (let o = 0; o < data.length; o += 255) {
      const chunk = data.subarray(o, o + 255)
      out.push(chunk.length, ...chunk)
    }
    out.push(0x00)
  }
  out.push(0x3b)
  return Buffer.from(out)
}

function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  let nextCode = eoiCode + 1
  let codeSize = minCodeSize + 1
  let table = new Map<number, number>()
  const bytes: number[] = []
  let cur = 0
  let shift = 0
  const emit = (code: number) => {
    cur |= code << shift
    shift += codeSize
    while (shift >= 8) {
      bytes.push(cur & 0xff)
      cur >>>= 8
      shift -= 8
    }
  }
  emit(clearCode)
  let prefix = indices[0] ?? 0
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i] ?? 0
    const key = (prefix << 8) | k
    const code = table.get(key)
    if (code !== undefined) {
      prefix = code
      continue
    }
    emit(prefix)
    if (nextCode === 4096) {
      emit(clearCode)
      nextCode = eoiCode + 1
      codeSize = minCodeSize + 1
      table = new Map()
    } else {
      if (nextCode >= 1 << codeSize) codeSize++
      table.set(key, nextCode++)
    }
    prefix = k
  }
  emit(prefix)
  emit(eoiCode)
  if (shift > 0) bytes.push(cur & 0xff)
  return Uint8Array.from(bytes)
}

/** Six clearly different frames (colour and block position) of a w x h loop. */
export function loopFrames(w: number, h: number): GifFrame[] {
  const colours: [number, number, number][] = [
    [214, 69, 65],
    [242, 159, 5],
    [60, 160, 90],
    [40, 110, 200],
    [120, 70, 190],
    [30, 30, 40],
  ]
  return colours.map((bg, i) => ({
    bg,
    block: {
      x: Math.round((i * w) / 7),
      y: Math.round(h / 3),
      w: Math.round(w / 6),
      h: Math.round(h / 3),
      color: [250, 250, 250],
    },
  }))
}

export const gifPayload = (name: string, w: number, h: number): FilePayload => ({
  name,
  mimeType: 'image/gif',
  buffer: makeAnimatedGif(w, h, loopFrames(w, h)),
})

// ---- PDF ---------------------------------------------------------------------------------------------

/** A US Letter PDF of `pages` pages, each saying "Page N of M" in large type. */
export async function makePdf(name: string, pages: number): Promise<FilePayload> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([612, 792])
    page.drawRectangle({
      x: 36,
      y: 36,
      width: 540,
      height: 720,
      borderColor: rgb(0.2, 0.3, 0.5),
      borderWidth: 3,
    })
    page.drawText(`Page ${n} of ${pages}`, { x: 72, y: 600, size: 54, font, color: rgb(0.1, 0.15, 0.3) })
  }
  const bytes = await doc.save({ useObjectStreams: false })
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) }
}

// ---- viewer and board reads ----------------------------------------------------------------------------

export const viewer = (page: Page) => page.getByTestId('pdf-viewer')
export const viewerCounter = (page: Page) => page.getByTestId('pdf-viewer-counter')
export const viewerPage = (page: Page) => page.getByTestId('pdf-viewer-page')
export const selectBox = (page: Page, n: number) =>
  page.locator(`[data-testid="pdf-viewer-select"][data-page="${n}"]`)

/** The decoded natural size of an <img> (0 x 0 until it has loaded). */
export const naturalSize = (img: Locator) =>
  img.evaluate((el) => {
    const i = el as HTMLImageElement
    return { w: i.complete ? i.naturalWidth : 0, h: i.complete ? i.naturalHeight : 0 }
  })

export interface PlacedPage {
  id: string
  parentId: string
  bounds: { x: number; y: number; w: number; h: number }
  assetId: string | null
  altText: string
  asset: {
    src: string | null
    mimeType: string | null
    w: number
    h: number
    name: string
    meta: unknown
  } | null
}

/** Every image shape on the page with its asset, left to right. */
export const imageShapes = (page: Page) =>
  readM(page, (ed) =>
    ed
      .getCurrentPageShapes()
      .filter((s) => s.type === 'image')
      .map((s) => {
        const b = ed.getShapePageBounds(s.id)
        const asset = s.props.assetId ? ed.getAsset(String(s.props.assetId)) : undefined
        return {
          id: s.id,
          parentId: s.parentId,
          bounds: b ? { x: b.x, y: b.y, w: b.w, h: b.h } : { x: 0, y: 0, w: 0, h: 0 },
          assetId: (s.props.assetId as string | null) ?? null,
          altText: String(s.props.altText ?? ''),
          asset: asset
            ? {
                src: (asset.props.src as string | null) ?? null,
                mimeType: (asset.props.mimeType as string | null) ?? null,
                w: Number(asset.props.w),
                h: Number(asset.props.h),
                name: String(asset.props.name),
                meta: asset.meta,
              }
            : null,
        }
      })
      .sort((a, b) => a.bounds.x - b.bounds.x),
  ) as Promise<PlacedPage[]>

/** Centres the camera on a shape at an exact zoom level (no animation). */
export async function lookAt(page: Page, shapeId: string, z: number) {
  await readM(
    page,
    (ed, arg) => {
      const b = ed.getShapePageBounds(arg.id)
      if (!b) return false
      const vp = ed.getViewportScreenBounds()
      ed.setCamera(
        { x: vp.w / 2 / arg.z - (b.x + b.w / 2), y: vp.h / 2 / arg.z - (b.y + b.h / 2), z: arg.z },
        { immediate: true },
      )
      return true
    },
    { id: shapeId, z },
  )
}
