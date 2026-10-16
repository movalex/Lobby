// HEIC photos in the uploader (wave R, WS3; docs/WAVE-R-CONTRACTS.md §6). Lobby's server never decodes HEVC, so a HEIC
// upload is an attachment with a hint. Safari (17+) decodes HEIC with Apple's own decoder, though: where the browser
// can, the picture is converted to a JPEG here, before upload, and uploaded as an ordinary image (the server then
// treats it like any JPEG: sniffed, limited, re-encoded). Chrome, Edge and Firefox cannot decode it, and the file is
// uploaded unchanged. Nothing is installed and no request is made: createImageBitmap and OffscreenCanvas only. The
// re-encode also drops the photo's EXIF block (location included); the orientation is applied first.
import { designFormatOf } from '@draftroom/contracts'

/** Bigger pictures stay HEIC (an attachment): the canvas takes 4 bytes a pixel. iPhones take 12 or 48 MP. */
export const HEIC_MAX_PIXELS = 50_000_000
export const HEIC_JPEG_QUALITY = 0.9

export interface HeicDeps {
  createImageBitmap?: (file: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>
  OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas
}

const browser = (): HeicDeps => ({
  createImageBitmap: typeof createImageBitmap === 'function' ? createImageBitmap : undefined,
  OffscreenCanvas: typeof OffscreenCanvas === 'function' ? OffscreenCanvas : undefined,
})

export function isHeicFile(file: Pick<File, 'type' | 'name'>): boolean {
  return designFormatOf(file.type, file.name)?.kind === 'heic'
}

/** "IMG_0001.HEIC" → "IMG_0001.jpg". */
export const jpegName = (name: string) => `${name.replace(/\.(heic|heif)$/i, '') || 'photo'}.jpg`

/** The HEIC photo as a JPEG when this browser can decode it, else the file unchanged (never throws). */
export async function heicAsJpeg(file: File, deps: HeicDeps = browser()): Promise<File> {
  if (!isHeicFile(file) || !deps.createImageBitmap || !deps.OffscreenCanvas) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await deps.createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file // no HEIC decoder in this browser
  }
  try {
    const { width, height } = bitmap
    if (!(width > 0 && height > 0) || width * height > HEIC_MAX_PIXELS) return file
    const canvas = new deps.OffscreenCanvas(width, height)
    const g = canvas.getContext('2d')
    if (!g) return file
    g.drawImage(bitmap, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: HEIC_JPEG_QUALITY })
    if (blob.type !== 'image/jpeg' || blob.size === 0) return file
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  } finally {
    bitmap.close()
  }
}

/** The files of one upload with their HEIC photos converted where possible (the others unchanged). */
export async function convertHeicPhotos(files: readonly File[], deps?: HeicDeps): Promise<File[]> {
  return Promise.all(files.map((f) => (isHeicFile(f) ? heicAsJpeg(f, deps) : f)))
}
