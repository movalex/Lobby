// OWNER: WS4 (wave S, the review summary PDF). The summary's pictures: any image the browser can decode, made into a
// JPEG data: URL no larger than SUMMARY_PICTURE_SIDE on its long side (a summary of 60 pages must stay a file one can
// mail). Browser only. The data: URL goes into the PDF page's own image object; it is never put anywhere else (not in
// an element, not in a request).
import type { SummaryPicture } from './layout.ts'

/** The longest side of a printed picture, px. */
export const SUMMARY_PICTURE_SIDE = 1200
const QUALITY = 0.85

/** `blob` as a summary picture, or null when the browser cannot decode it. */
export async function toSummaryPicture(
  blob: Blob,
  maxSide = SUMMARY_PICTURE_SIDE,
): Promise<SummaryPicture | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    return null
  }
  try {
    const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * k))
    const height = Math.max(1, Math.round(bitmap.height * k))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // JPEG has no alpha: a transparent picture prints on white paper
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
    return dataUrl.startsWith('data:image/jpeg;base64,') ? { dataUrl, width, height } : null
  } finally {
    bitmap.close()
  }
}
