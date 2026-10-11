// Vector PDF (wave N, N6-5): the export dialog's choice between vector pages and image pages, its kill switch and
// its wording. Pure, so the sentences are unit-tested.

import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'

/**
 * The kill switch: false hides "Vector (sharp, selectable text)" (a web-only redeploy), and every PDF is made of
 * image pages, as before wave N. It stays false until @pdf-lib/fontkit is installed (./vector/fontkit.ts): without
 * it no Lobby font can be embedded, so nearly every page would fall back to an image.
 */
export const VECTOR_PDF: boolean = false

/** The local-development preview key (the e2e suite's builds and the dev server only; ignored in production). */
export const VECTOR_PDF_DEV_PREVIEW_KEY = 'lobby.dev.vectorPdf'

/**
 * Whether the dialog offers vector pages: VECTOR_PDF, or (behind the local-dev guard only, never in a production
 * build) the preview key set to '1', so the e2e suite exercises the vector path and its fallbacks before the switch
 * is turned on.
 */
export function vectorPdfOffered(devGuard: boolean = DEV_AUTH_ENABLED): boolean {
  if (VECTOR_PDF) return true
  if (!devGuard) return false
  try {
    return globalThis.localStorage?.getItem(VECTOR_PDF_DEV_PREVIEW_KEY) === '1'
  } catch {
    return false
  }
}

/** A PDF above this size gets a note after the export (mail and chat tools refuse large attachments). */
export const PDF_SIZE_WARN_BYTES = 50 * 1024 * 1024

const fmt = new Intl.NumberFormat('en')

/** "3", "3 and 5", "2, 3 and 5". */
function list(pages: readonly number[]): string {
  const n = pages.map((p) => fmt.format(p))
  if (n.length <= 1) return n.join('')
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

/** The note after a vector export whose pages fell back: "Pages 3 and 5 were exported as images". */
export function imagePagesSentence(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  return sorted.length === 1
    ? `Page ${list(sorted)} was exported as an image`
    : `Pages ${list(sorted)} were exported as images`
}

/** The size note: "This PDF is 63 MB: …" (null below the limit). */
export function pdfSizeNote(bytes: number): string | null {
  if (!(bytes > PDF_SIZE_WARN_BYTES)) return null
  const mb = Math.round(bytes / (1024 * 1024))
  return `This PDF is ${fmt.format(mb)} MB: too large for most email and chat attachments. Export fewer frames, or choose Image pages without lossless images for a smaller file.`
}
