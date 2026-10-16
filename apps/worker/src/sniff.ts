// Content sniffing: the declared kind comes from the browser (Content-Type + file name) and is
// untrusted. Magic bytes are only the first gate; the decoders are the real validation (a garbage
// file that starts with %PDF, or a truncated MP4, still sniffs as valid).
import { open } from 'node:fs/promises'
import { type AssetKind, designFormatByMime, LIMITS, officeFormatByMime } from '@draftroom/dev-assets'
import { fileTypeFromFile } from 'file-type'
import { PreviewError } from './errors.ts'

export interface Sniffed {
  mime: string | null
  ext: string | null
}

export async function sniffFile(path: string): Promise<Sniffed> {
  const r = await fileTypeFromFile(path)
  if (r) return { mime: r.mime, ext: r.ext }
  // The PDF spec lets a header sit anywhere in the first 1024 bytes; file-type only checks offset 0.
  if (await headContains(path, '%PDF-', 1024)) return { mime: 'application/pdf', ext: 'pdf' }
  return { mime: null, ext: null }
}

async function headContains(path: string, needle: string, bytes: number): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).includes(needle, 0, 'latin1')
  } finally {
    await fh.close()
  }
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// ISO-BMFF / QuickTime family: the only containers the forced `-f mov` demuxer reads.
const MP4_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/3gpp', 'video/3gpp2'])

/** Sniffed types of kind-'pdf' uploads the worker renders as one flattened page itself (not through pdf.js). */
export const DESIGN_PAGE_MIMES: ReadonlySet<string> = new Set(['image/vnd.adobe.photoshop', 'image/tiff'])
const POSTSCRIPT_MIMES = new Set(['application/postscript', 'application/eps'])

/**
 * The size limit of a file of `kind` by its content: a PSD may be 200 MiB, a TIFF, PDF or Office document 100 MiB
 * (dev-assets DESIGN_FORMATS and LIMITS). The upload's own limit came from its declared type and name.
 */
export function contentByteLimit(kind: AssetKind, s: Sniffed): number {
  if (kind !== 'pdf') return LIMITS.maxBytes[kind]
  if (officeFormatByMime(s.mime)) return LIMITS.maxOfficeBytes
  const design = s.mime && DESIGN_PAGE_MIMES.has(s.mime) ? designFormatByMime(s.mime) : null
  return design?.maxBytes ?? LIMITS.maxBytes.pdf
}

/**
 * Throws when the content contradicts the declared kind. Returns the sniffed MIME type, which
 * replaces the declared one in meta (a JPEG named .png is still an image and is served as JPEG).
 */
export function confirmKind(kind: AssetKind, s: Sniffed): string | null {
  switch (kind) {
    case 'other':
      return null
    case 'image':
      if (s.mime && IMAGE_MIMES.has(s.mime)) return s.mime
      if (s.mime?.startsWith('image/')) {
        throw new PreviewError('IMAGE_INVALID', `unsupported image type ${s.mime}`)
      }
      throw new PreviewError('TYPE_MISMATCH', `declared image, content ${s.mime ?? 'unknown'}`)
    case 'pdf':
      // Illustrator .ai files are PDFs underneath (file-type 22 reports them as PDFs; older ones said ai).
      if (s.mime === 'application/pdf' || s.ext === 'ai') return 'application/pdf'
      // Photoshop and TIFF files are previewed as one flattened page (wave R: psd.ts, tiff.ts).
      if (s.mime && DESIGN_PAGE_MIMES.has(s.mime)) return s.mime
      // An old (PostScript) Illustrator file or an EPS: no preview without Ghostscript (AGPL, not used).
      if (s.mime && POSTSCRIPT_MIMES.has(s.mime)) {
        throw new PreviewError('POSTSCRIPT_NOT_SUPPORTED', `content ${s.mime}`)
      }
      throw new PreviewError('TYPE_MISMATCH', `declared pdf, content ${s.mime ?? 'unknown'}`)
    case 'video':
      if (s.mime && MP4_MIMES.has(s.mime)) return s.mime
      // A real video in a container M0 cannot play (WebM, Matroska, AVI...): keep it downloadable.
      if (s.mime?.startsWith('video/')) throw new PreviewError('UNSUPPORTED_CODEC', `container ${s.mime}`)
      throw new PreviewError('TYPE_MISMATCH', `declared video, content ${s.mime ?? 'unknown'}`)
  }
}
