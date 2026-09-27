// Content sniffing: the declared kind comes from the browser (Content-Type + file name) and is
// untrusted. Magic bytes are only the first gate; the decoders are the real validation (a garbage
// file that starts with %PDF, or a truncated MP4, still sniffs as valid).
import { open } from 'node:fs/promises'
import type { AssetKind } from '@draftroom/dev-assets'
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
      // Illustrator .ai files are PDFs underneath; file-type reports them as postscript.
      if (s.mime === 'application/pdf' || s.ext === 'ai') return 'application/pdf'
      throw new PreviewError('TYPE_MISMATCH', `declared pdf, content ${s.mime ?? 'unknown'}`)
    case 'video':
      if (s.mime && MP4_MIMES.has(s.mime)) return s.mime
      // A real video in a container M0 cannot play (WebM, Matroska, AVI...): keep it downloadable.
      if (s.mime?.startsWith('video/')) throw new PreviewError('UNSUPPORTED_CODEC', `container ${s.mime}`)
      throw new PreviewError('TYPE_MISMATCH', `declared video, content ${s.mime ?? 'unknown'}`)
  }
}
