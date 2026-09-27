// Image derivatives with sharp, in the worker process (libvips is native and bounded by the
// options below). sharp 0.35 ESM has ONLY a default export at runtime: named imports type-check
// but throw at load time.
import { type DerivativeRecord, LIMITS, type ProbeFacts } from '@draftroom/dev-assets'
import sharp, { type Metadata, type SharpOptions } from 'sharp'
import { PREVIEW } from './config.ts'
import type { DerivativeWriter } from './derivatives.ts'
import { PreviewError } from './errors.ts'

// libvips loader class names (8.18.6). GIF is decoded by libnsgif, so its loaders are *Nsgif*;
// unblocking *Gif* does nothing. SVG, PDF, TIFF, HEIF, matrix/csv/raw/vips stay blocked.
const ALLOWED_LOADERS = [
  'VipsForeignLoadJpegFile',
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadPngFile',
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadWebpFile',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadNsgifFile',
  'VipsForeignLoadNsgifBuffer',
]
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif'])

let configured = false

/** sharp with the loader allowlist applied. block/unblock/concurrency are process-global. */
export function lockedSharp(): typeof sharp {
  if (!configured) {
    sharp.block({ operation: ['VipsForeignLoad'] })
    sharp.unblock({ operation: ALLOWED_LOADERS })
    sharp.concurrency(2) // default is one thread per core; keep one job from saturating the box
    sharp.cache(false)
    configured = true
  }
  return sharp
}

// animated:false decodes only the first frame of a GIF/WebP animation.
const INPUT: SharpOptions = { limitInputPixels: LIMITS.maxInputPixels, failOn: 'warning', animated: false }

export interface WebpOut {
  data: Buffer
  width: number
  height: number
}

/** Resize to fit inside maxEdge x maxEdge (never enlarging), auto-orient, encode WebP. Output has no EXIF. */
export async function toWebp(input: Buffer, maxEdge: number, quality: number): Promise<WebpOut> {
  try {
    const { data, info } = await lockedSharp()(input, { ...INPUT, autoOrient: true })
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .timeout({ seconds: PREVIEW.sharpTimeoutSeconds })
      .toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height }
  } catch (e) {
    throw sharpError(e)
  }
}

function sharpError(e: unknown): PreviewError {
  const msg = (String((e as Error)?.message ?? e).split('\n')[0] ?? '').slice(0, 200)
  if (/pixel limit/i.test(msg)) return new PreviewError('IMAGE_TOO_LARGE', msg)
  if (/timeout/i.test(msg)) return new PreviewError('TIMEOUT', msg)
  return new PreviewError('IMAGE_INVALID', msg)
}

export interface Derived {
  probe: Partial<ProbeFacts>
  derivatives: DerivativeRecord[]
}

export async function deriveImage(input: Buffer, writer: DerivativeWriter): Promise<Derived> {
  let meta: Metadata
  try {
    meta = await lockedSharp()(input, INPUT).metadata() // header only; also enforces limitInputPixels
  } catch (e) {
    throw sharpError(e)
  }
  if (!ALLOWED_FORMATS.has(meta.format)) throw new PreviewError('IMAGE_INVALID', `format ${meta.format}`)
  if (meta.width * meta.height > LIMITS.maxInputPixels) {
    throw new PreviewError('IMAGE_TOO_LARGE', `${meta.width}x${meta.height}`)
  }
  // The untrusted original is decoded once; the thumb is made from our own display output.
  const display = await toWebp(input, PREVIEW.displayEdge, PREVIEW.displayQuality)
  const thumb = await toWebp(display.data, PREVIEW.thumbEdge, PREVIEW.thumbQuality)
  const derivatives = [
    await writer.write({ role: 'thumb', page: null, ...thumb }),
    await writer.write({ role: 'display', page: null, ...display }),
  ]
  // Displayed size (EXIF orientation applied): what the canvas needs for the aspect ratio.
  return { probe: { width: meta.autoOrient.width, height: meta.autoOrient.height }, derivatives }
}
