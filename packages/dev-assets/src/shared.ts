// Browser-safe part of the milestone-0 asset contract (types, ids, limits, classification).
// No Node imports here: apps/web imports this entry.

export type AssetKind = 'image' | 'pdf' | 'video' | 'other'
export type AssetStatus = 'queued' | 'processing' | 'ready' | 'failed'
export type DerivativeRole = 'thumb' | 'display' | 'page' | 'poster'

export interface DerivativeRecord {
  id: string // drv_...
  role: DerivativeRole
  page: number | null // 1-based PDF page for role 'page' (and the cover); null otherwise
  width: number
  height: number
  mimeType: 'image/webp' | 'image/png'
  bytes: number
  file: string // basename inside the version's derivatives/ dir
}

export interface ProbeFacts {
  width: number | null
  height: number | null
  pageCount: number | null
  durationMs: number | null
  videoCodec: string | null
  audioCodec: string | null
}

/** `message` is shown to users: never include file paths, stack traces or raw tool output. */
export interface AssetError {
  code: string
  message: string
}

export interface AssetVersionMeta {
  schemaVersion: 1
  assetId: string
  versionId: string
  boardId: string
  name: string
  declaredMimeType: string
  mimeType: string
  kind: AssetKind
  sizeBytes: number
  sha256: string
  uploadedBy: string
  createdAt: string
  updatedAt: string
  status: AssetStatus
  attempts: number
  error: AssetError | null
  probe: ProbeFacts
  derivatives: DerivativeRecord[]
}

export const PREVIEW_PROFILE = 'm0-preview-v1'

export interface PreviewJob {
  assetId: string
  versionId: string
  boardId: string
  profile: typeof PREVIEW_PROFILE
  enqueuedAt: string
  attempt: number
}

// ---- ids ---------------------------------------------------------------------------------------

export type IdPrefix = 'ast' | 'ver' | 'drv'
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ID_BODY = 20

/** Random base62 id with a type prefix, e.g. `ast_3fK...`. Matches canvas-schema's appId validator. */
export function newId(prefix: IdPrefix): string {
  let body = ''
  while (body.length < ID_BODY) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= 248) continue // rejection sampling: 248 = 4 * 62, keeps the distribution uniform
      body += ALPHABET[b % 62]
      if (body.length === ID_BODY) break
    }
  }
  return `${prefix}_${body}`
}

// Accept exactly what the canvas-schema appId validator accepts (10-40), so a card that is valid on
// the canvas is never treated as "missing" here. newId() always generates 20.
const ID_RES: Record<IdPrefix, RegExp> = {
  ast: /^ast_[0-9A-Za-z]{10,40}$/,
  ver: /^ver_[0-9A-Za-z]{10,40}$/,
  drv: /^drv_[0-9A-Za-z]{10,40}$/,
}

export function isId(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === 'string' && ID_RES[prefix].test(value)
}

/** Same rule as apps/sync BOARD_ID_RE: lowercase only (case-insensitive filesystems would split rooms). */
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/

// ---- limits (proposed product limits from the build plan section 8; not measured capacity) --------

const MiB = 1024 * 1024
export const LIMITS = {
  maxBytes: { image: 25 * MiB, pdf: 100 * MiB, video: 500 * MiB, other: 250 * MiB } satisfies Record<
    AssetKind,
    number
  >,
  /** Office documents (OFFICE_FORMATS): the build plan's "PDFs/Office documents 100 MB". See maxUploadBytes(). */
  maxOfficeBytes: 100 * MiB,
  /** LibreOffice's wall clock for converting one Office document to PDF (the page render has its own budget). */
  officeConvertTimeoutMs: 120_000,
  /** Sum of the uncompressed sizes an Office document's ZIP may declare (zip-bomb guard, checked before conversion). */
  officeMaxUnzippedBytes: 1024 * MiB,
  /** Entries in an Office document's ZIP. */
  officeMaxZipEntries: 10_000,
  maxNameLength: 200,
  maxInputPixels: 100_000_000,
  maxPdfPages: 2_000,
  /** Pages rendered eagerly by the M0 worker (cover + a short strip); the rest are a lazy M3 feature. */
  eagerPdfPages: 8,
  maxVideoDurationMs: 15 * 60_000,
  jobTimeoutMs: 90_000,
  pdfPageTimeoutMs: 20_000,
  maxAttempts: 3,
  /** A job whose processing file has not been touched for this long is considered abandoned. */
  staleProcessingMs: 120_000,
} as const

// ---- classification (a first gate only; the worker re-checks by content) -------------------------

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm'])

const baseMime = (mimeType: string) => mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
const extOf = (name: string) => name.toLowerCase().split('.').pop() ?? ''

/**
 * SVG is deliberately NOT an image here: untrusted SVG is never rendered inline (attachment only).
 * Office documents (OFFICE_FORMATS) are 'pdf': the worker converts them to PDF and they are previewed
 * as pages, with the PDF limits and page viewer. Their original is still served as an attachment
 * (only application/pdf is ever inline), and meta.mimeType says what they really are.
 */
export function classifyUpload(mimeType: string, name: string): AssetKind {
  const mime = baseMime(mimeType)
  const ext = extOf(name)
  if (IMAGE_MIMES.has(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (VIDEO_MIMES.has(mime) || ['mp4', 'm4v', 'mov', 'webm'].includes(ext)) return 'video'
  if (officeFormat(mime, name)) return 'pdf'
  return 'other'
}

// ---- Office documents (wave 4) ------------------------------------------------------------------------

export type OfficeExt = 'docx' | 'pptx' | 'xlsx' | 'odt' | 'odp' | 'ods'

export interface OfficeFormat {
  ext: OfficeExt
  mime: string
  /** What the card and the page viewer call the file ("Word document"). */
  label: string
}

/**
 * The Office formats the preview worker converts to PDF (with LibreOffice, in isolation). Nothing else:
 * macro-enabled (.docm, .xlsm, .pptm), legacy binary (.doc, .xls, .ppt) and Apple iWork files stay
 * attachments. The MIME types are what file-type reports for the content (apps/worker/src/sniff.ts).
 */
export const OFFICE_FORMATS: readonly OfficeFormat[] = [
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
  },
  {
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint presentation',
  },
  {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel spreadsheet',
  },
  { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', label: 'OpenDocument text' },
  {
    ext: 'odp',
    mime: 'application/vnd.oasis.opendocument.presentation',
    label: 'OpenDocument presentation',
  },
  {
    ext: 'ods',
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    label: 'OpenDocument spreadsheet',
  },
]

/** The Office format a MIME type names exactly (parameters and case ignored), or null. */
export function officeFormatByMime(mimeType: string | null | undefined): OfficeFormat | null {
  const mime = baseMime(mimeType ?? '')
  return OFFICE_FORMATS.find((f) => f.mime === mime) ?? null
}

/**
 * The Office format of an upload: by its declared type, else by its file name's extension. Untrusted
 * (the worker decides by content); used to classify, to pick the limit and to label a card.
 */
export function officeFormat(mimeType: string, name: string): OfficeFormat | null {
  const ext = extOf(name)
  return officeFormatByMime(mimeType) ?? OFFICE_FORMATS.find((f) => f.ext === ext) ?? null
}

/** An upload that classifyUpload made 'pdf' because it is an Office document (not a PDF by type or name). */
export function isOfficeUpload(kind: AssetKind, mimeType: string, name: string): boolean {
  return (
    kind === 'pdf' &&
    baseMime(mimeType) !== 'application/pdf' &&
    extOf(name) !== 'pdf' &&
    officeFormat(mimeType, name) !== null
  )
}

/** The upload size limit for a file of `kind` with this declared type and name (Office documents have their own). */
export function maxUploadBytes(kind: AssetKind, mimeType: string, name: string): number {
  return isOfficeUpload(kind, mimeType, name) ? LIMITS.maxOfficeBytes : LIMITS.maxBytes[kind]
}

/** Display name: strip path parts and control characters, cap the length. Never used as a filesystem path. */
export function sanitizeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || 'file').slice(0, LIMITS.maxNameLength)
}

// ---- URL contract (served by apps/api with board authorization since M1; see docs/M1-CONTRACTS.md §5)

/** Stable, host-less reference stored in tldraw asset `src`. Never a signed or expiring URL. */
export function stableFileRef(assetId: string, versionId: string): string {
  return `/files/${assetId}/${versionId}/original`
}

export function derivativeUrl(boardId: string, assetId: string, versionId: string, derivativeId: string) {
  return `/files/${assetId}/${versionId}/d/${derivativeId}?board=${encodeURIComponent(boardId)}`
}

export function originalUrl(boardId: string, assetId: string, versionId: string) {
  return `/files/${assetId}/${versionId}/original?board=${encodeURIComponent(boardId)}`
}

export function metaUrl(boardId: string, assetId: string, versionId: string) {
  return `/api/boards/${encodeURIComponent(boardId)}/assets/${assetId}/${versionId}`
}

export function uploadUrl(boardId: string) {
  return `/api/boards/${encodeURIComponent(boardId)}/assets`
}
