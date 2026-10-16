// TIFF previews (wave R, docs/WAVE-R-CONTRACTS.md §6): the first page (IFD 0) as one flattened page, through sharp's own
// TIFF loader (libvips + libtiff, the reviewed LGPL entry), read from the file: only VipsForeignLoadTiffFile is
// unblocked (image.ts ALLOWED_LOADERS). In process, like images, with the pixel limit checked from the header, a page
// limit and sharp's timeout. The page count is reported; only page 1 has a preview (the page viewer says so).
import { LIMITS } from '@draftroom/dev-assets'
import type { Metadata, SharpOptions } from 'sharp'
import { PREVIEW } from './config.ts'
import type { DerivativeWriter } from './derivatives.ts'
import { PreviewError } from './errors.ts'
import type { Derived } from './image.ts'
import { lockedSharp, toWebp } from './image.ts'

/** The same values as @draftroom/contracts DESIGN_PREVIEW_LIMITS (tiff*). */
export const TIFF_LIMITS = {
  /** a TIFF with more pages than this is refused (DESIGN_TOO_LARGE): the directory chain is walked to count them */
  maxPagesRead: 50,
  /** pixels of the page that is decoded (the first) */
  maxPixels: LIMITS.maxInputPixels,
  timeoutMs: 20_000,
} as const

// failOn 'error': libtiff warns about unknown tags in ordinary files, but a truncated or broken strip is an error.
const INPUT: SharpOptions = { limitInputPixels: TIFF_LIMITS.maxPixels, failOn: 'error', page: 0, pages: 1 }

function tiffError(e: unknown): PreviewError {
  const msg = (String((e as Error)?.message ?? e).split('\n')[0] ?? '').slice(0, 200)
  if (/pixel limit/i.test(msg)) return new PreviewError('DESIGN_TOO_LARGE', msg)
  if (/timeout/i.test(msg)) return new PreviewError('TIMEOUT', msg)
  return new PreviewError('IMAGE_INVALID', msg)
}

export async function deriveTiff(input: string, writer: DerivativeWriter): Promise<Derived> {
  const sharp = lockedSharp()
  let meta: Metadata
  try {
    meta = await sharp(input, INPUT).metadata() // the header (and the page count); enforces limitInputPixels
  } catch (e) {
    throw tiffError(e)
  }
  if (meta.format !== 'tiff') throw new PreviewError('IMAGE_INVALID', `format ${meta.format}`)
  const pages = meta.pages ?? 1
  if (pages > TIFF_LIMITS.maxPagesRead) throw new PreviewError('DESIGN_TOO_LARGE', `${pages} pages`)
  if (meta.width * meta.height > TIFF_LIMITS.maxPixels) {
    throw new PreviewError('DESIGN_TOO_LARGE', `${meta.width}x${meta.height}`)
  }
  let page: { data: Buffer; width: number; height: number }
  try {
    const { data, info } = await sharp(input, { ...INPUT, autoOrient: true })
      .flatten({ background: '#ffffff' })
      .resize({
        width: PREVIEW.displayEdge,
        height: PREVIEW.displayEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: PREVIEW.pageQuality })
      .timeout({ seconds: Math.ceil(TIFF_LIMITS.timeoutMs / 1000) })
      .toBuffer({ resolveWithObject: true })
    page = { data, width: info.width, height: info.height }
  } catch (e) {
    throw tiffError(e)
  }
  const thumb = await toWebp(page.data, PREVIEW.thumbEdge, PREVIEW.thumbQuality)
  const derivatives = [
    await writer.write({ role: 'page', page: 1, ...page }),
    await writer.write({ role: 'thumb', page: 1, ...thumb }),
  ]
  return {
    probe: { pageCount: pages, width: meta.autoOrient.width, height: meta.autoOrient.height },
    derivatives,
  }
}
