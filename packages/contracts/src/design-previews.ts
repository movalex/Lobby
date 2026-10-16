// Design-file previews (wave R, WS3; docs/WAVE-R-CONTRACTS.md §6). OWNER: WS3 after the wave R foundation. Frozen by
// the foundation. Photoshop, Illustrator and TIFF files are previewed in the NAS worker as FLATTENED pages, like Office
// documents (they are classified `pdf`: the page viewer and the PDF limits); HEIC is kept as an attachment with a hint
// (no HEVC decoder on the server). The file card says "Flattened preview" and the original's type; it never says
// "editable", and the download is always the original.
//
// The table here is what the web's file card and the api's upload route agree on. packages/dev-assets/src/shared.ts
// DESIGN_FORMATS (used by the worker, which does not depend on this package) holds the same rows; a test in the api
// compares the two.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

export const DESIGN_PREVIEW_KINDS = ['psd', 'ai', 'tiff', 'heic'] as const
export type DesignPreviewKind = (typeof DESIGN_PREVIEW_KINDS)[number]

const MiB = 1024 * 1024

export interface DesignFormatRow {
  readonly kind: DesignPreviewKind
  /** the type the card shows next to the badge */
  readonly label: string
  readonly exts: readonly string[]
  readonly mimes: readonly string[]
  /** 'pages': a flattened preview (classified `pdf`); 'none': an attachment with a hint */
  readonly preview: 'pages' | 'none'
  /** the upload limit; null = the PDF limit (LIMITS.maxBytes.pdf) */
  readonly maxBytes: number | null
}

export const DESIGN_FORMAT_ROWS: readonly DesignFormatRow[] = [
  {
    kind: 'psd',
    label: 'PSD',
    exts: ['psd'],
    mimes: ['image/vnd.adobe.photoshop', 'application/x-photoshop', 'application/photoshop'],
    preview: 'pages',
    maxBytes: 200 * MiB,
  },
  {
    kind: 'ai',
    label: 'AI',
    exts: ['ai'],
    mimes: ['application/illustrator', 'application/postscript'],
    preview: 'pages',
    maxBytes: null,
  },
  {
    kind: 'tiff',
    label: 'TIFF',
    exts: ['tif', 'tiff'],
    mimes: ['image/tiff'],
    preview: 'pages',
    maxBytes: 100 * MiB,
  },
  {
    kind: 'heic',
    label: 'HEIC',
    exts: ['heic', 'heif'],
    mimes: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
    preview: 'none',
    maxBytes: null,
  },
]

/** The design format of a file by its declared type and name (a first gate only: the worker sniffs the content). */
export function designFormatOf(mimeType: string, name: string): DesignFormatRow | null {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
  const ext = name.toLowerCase().split('.').pop() ?? ''
  // application/postscript alone is EPS or old PostScript: only an .ai name makes it Illustrator
  const byExt = DESIGN_FORMAT_ROWS.find((r) => r.exts.includes(ext))
  if (byExt) return byExt
  return DESIGN_FORMAT_ROWS.find((r) => r.mimes.includes(mime) && mime !== 'application/postscript') ?? null
}

/**
 * Why a design file has no preview, or only a low-resolution one (the worker's `error.code` on the version, and the
 * card's words). Codes only: the card shows the message for the code.
 */
export const DESIGN_PREVIEW_CODES = {
  /** an Illustrator file saved without "Create PDF Compatible File" */
  noPdfContent: 'NO_PDF_CONTENT',
  /** an old AI or EPS file (PostScript needs Ghostscript, AGPL: not used) */
  postscript: 'POSTSCRIPT_NOT_SUPPORTED',
  /** a PSD saved without "Maximize Compatibility": only its embedded thumbnail is shown */
  psdThumbnailOnly: 'PSD_THUMBNAIL_ONLY',
  /** a PSD with neither a composite nor a thumbnail */
  psdNoComposite: 'PSD_NO_COMPOSITE',
  /** PSB, 16/32-bit, or a colour mode other than RGB and greyscale */
  psdUnsupported: 'PSD_UNSUPPORTED',
  /** HEIC/HEIF: no preview on the server */
  heic: 'HEIC_NO_PREVIEW',
  /** over the pixel, page, layer or time limits */
  tooLarge: 'DESIGN_TOO_LARGE',
} as const
export type DesignPreviewCode = (typeof DESIGN_PREVIEW_CODES)[keyof typeof DESIGN_PREVIEW_CODES]

export const DESIGN_PREVIEW_MESSAGES: Readonly<Record<DesignPreviewCode, string>> = {
  NO_PDF_CONTENT: 'No preview: re-save it in Illustrator with “Create PDF Compatible File” on.',
  POSTSCRIPT_NOT_SUPPORTED: 'No preview: PostScript files (old .ai and .eps) are not previewed.',
  PSD_THUMBNAIL_ONLY: 'Low-resolution preview: re-save it in Photoshop with “Maximize Compatibility” on.',
  PSD_NO_COMPOSITE: 'No preview: re-save it in Photoshop with “Maximize Compatibility” on.',
  PSD_UNSUPPORTED: 'No preview: Lobby previews 8-bit RGB and greyscale Photoshop files.',
  HEIC_NO_PREVIEW:
    'HEIC has no preview in Lobby: on iPhone set Camera → Formats → Most Compatible, or export it as JPEG.',
  DESIGN_TOO_LARGE: 'No preview: the file is too large to preview.',
}

/** The badge a design file's card shows (never "editable"). */
export const DESIGN_PREVIEW_BADGE = 'Flattened preview'

/** The worker's limits for design files (on top of the PDF and image limits). */
export const DESIGN_PREVIEW_LIMITS = {
  psdMaxPixels: 40_000_000,
  psdMaxSide: 30_000,
  psdMaxLayerRecords: 2_000,
  psdChildHeapMb: 768,
  psdTimeoutMs: 30_000,
  tiffMaxPagesRead: 50,
  tiffEagerPages: 8,
  tiffTimeoutMs: 20_000,
} as const
