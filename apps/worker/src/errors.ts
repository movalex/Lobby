// Failure classification for preview jobs. Only `code` and the fixed user message ever reach
// meta.json (and so the browser); `detail` is for the worker's own log and never contains file
// names or paths.

export type FailureCode =
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_INVALID'
  | 'TYPE_MISMATCH'
  | 'PDF_ENCRYPTED'
  | 'PDF_INVALID'
  | 'PDF_TOO_MANY_PAGES'
  | 'UNSUPPORTED_CODEC'
  | 'VIDEO_INVALID'
  | 'VIDEO_TOO_LONG'
  | 'FILE_TOO_LARGE'
  | 'FILE_MISSING'
  | 'TIMEOUT'
  | 'INTERNAL'
  | 'OFFICE_ENCRYPTED'
  | 'OFFICE_INVALID'
  | 'OFFICE_TOO_MANY_PAGES'
  | 'OFFICE_UNAVAILABLE'
  // design files (wave R): the codes of @draftroom/contracts DESIGN_PREVIEW_CODES (HEIC_NO_PREVIEW is the web's)
  | 'NO_PDF_CONTENT'
  | 'POSTSCRIPT_NOT_SUPPORTED'
  | 'PSD_NO_COMPOSITE'
  | 'PSD_UNSUPPORTED'
  | 'DESIGN_TOO_LARGE'

const MESSAGES: Record<FailureCode, string> = {
  IMAGE_TOO_LARGE: 'This image is too large to preview. You can still download it.',
  IMAGE_INVALID: 'This image could not be previewed. It may be damaged or in an unsupported format.',
  TYPE_MISMATCH: "The file's contents do not match its file type, so no preview was made.",
  PDF_ENCRYPTED: 'This PDF is password-protected. Download it to view it.',
  PDF_INVALID: 'This PDF could not be read. It may be damaged or incomplete.',
  PDF_TOO_MANY_PAGES: 'This PDF has too many pages to preview. You can still download it.',
  UNSUPPORTED_CODEC: 'This video format cannot be played here yet. You can still download it.',
  VIDEO_INVALID: 'This video could not be read. It may be damaged or incomplete.',
  VIDEO_TOO_LONG: 'This video is too long to preview. You can still download it.',
  FILE_TOO_LARGE: 'This file is larger than the preview limit. You can still download it.',
  FILE_MISSING: 'The uploaded file is missing. Try uploading it again.',
  TIMEOUT: 'Making the preview took too long. You can still download the file.',
  INTERNAL: 'The preview could not be made. Try uploading the file again.',
  // Office documents (office.ts). The api keeps the same catalog (apps/api/src/worker/protocol.ts).
  OFFICE_ENCRYPTED: 'This document is password-protected. Download it to open it.',
  OFFICE_INVALID:
    'This document could not be converted for preview. It may be damaged, password-protected or too complex. You can still download it.',
  OFFICE_TOO_MANY_PAGES: 'This document has too many pages to preview. You can still download it.',
  OFFICE_UNAVAILABLE:
    'Previews of Office documents are not available right now. You can still download the file.',
  // Design files (psd.ts, tiff.ts, pdf.ts for Illustrator). The same words as @draftroom/contracts
  // DESIGN_PREVIEW_MESSAGES, which the api shows (the worker does not depend on contracts; a test compares them).
  NO_PDF_CONTENT: 'No preview: re-save it in Illustrator with “Create PDF Compatible File” on.',
  POSTSCRIPT_NOT_SUPPORTED: 'No preview: PostScript files (old .ai and .eps) are not previewed.',
  PSD_NO_COMPOSITE: 'No preview: re-save it in Photoshop with “Maximize Compatibility” on.',
  PSD_UNSUPPORTED: 'No preview: Lobby previews 8-bit RGB and greyscale Photoshop files.',
  DESIGN_TOO_LARGE: 'No preview: the file is too large to preview.',
}

/** Every failure code, e.g. to check that the api knows each one. */
export const FAILURE_CODES = Object.keys(MESSAGES) as FailureCode[]

export function userMessage(code: FailureCode): string {
  return MESSAGES[code]
}

/** A deterministic failure caused by the file itself: retrying cannot help, so the job fails now. */
export class PreviewError extends Error {
  readonly code: FailureCode
  readonly detail: string
  /** Facts learned before the failure (e.g. codecs of an unsupported video), kept in meta.probe. */
  readonly probe: Record<string, number | string | null>

  constructor(code: FailureCode, detail = '', probe: Record<string, number | string | null> = {}) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'PreviewError'
    this.code = code
    this.detail = detail
    this.probe = probe
  }
}

/** Environment or infrastructure trouble (tool missing, child crashed): retried up to LIMITS.maxAttempts. */
export class TransientError extends Error {
  readonly detail: string
  constructor(detail: string) {
    super(detail)
    this.name = 'TransientError'
    this.detail = detail
  }
}

/** The worker is shutting down and gave up on this job; it is released, not failed. */
export class AbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortedError'
  }
}

export function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new AbortedError()
}
