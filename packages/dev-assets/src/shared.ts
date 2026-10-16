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
  /**
   * Wave S (WS3, optional): frames per second from ffprobe's avg_frame_rate, for frame steps and hh:mm:ss:ff
   * timecodes. Absent or null: unknown (the viewer steps at contracts MEDIA_COMMENT_RULES.defaultFrameRate).
   */
  frameRate?: number | null
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
  // Photoshop, Illustrator and TIFF files are previewed as flattened pages (wave R) once the preview worker can make
  // them (designPreviewsEnabled: DRAFTROOM_DESIGN_PREVIEWS); until then they are attachments, as before wave R.
  // HEIC stays an attachment either way.
  if (designFormat(mime, name)?.preview === 'pages' && designPreviewsEnabled()) return 'pdf'
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

// ---- design files (wave R, WS3; landed by the foundation) ----------------------------------------------------

let designPreviewsOn = false

/**
 * Whether Photoshop, Illustrator and TIFF uploads are previewed as flattened pages (kind 'pdf') or are plain
 * attachments (kind 'other', the 'other' limit), as before wave R. The api sets it from DRAFTROOM_DESIGN_PREVIEWS
 * ("on" only; unset, empty or "off" is off) when it starts; the web sets it from what the api says (GET
 * /api/auth/config `designPreviews`), so a browser classifies like the server. Off until told otherwise (fail closed). One answer per
 * process: the api and the web each run one deployment's setting. HEIC (an attachment with a hint) is unaffected.
 */
export function setDesignPreviews(on: boolean): void {
  designPreviewsOn = on
}

export function designPreviewsEnabled(): boolean {
  return designPreviewsOn
}

export type DesignExt = 'psd' | 'ai' | 'tif' | 'tiff' | 'heic' | 'heif'

export interface DesignFormat {
  kind: 'psd' | 'ai' | 'tiff' | 'heic'
  exts: readonly DesignExt[]
  mimes: readonly string[]
  /** 'pages': previewed as flattened pages (classified 'pdf', like Office); 'none': an attachment with a hint */
  preview: 'pages' | 'none'
  /** the upload limit; null: the PDF limit */
  maxBytes: number | null
}

/**
 * The design files the NAS worker previews as FLATTENED pages (Photoshop, Illustrator, TIFF) or keeps as an
 * attachment with a hint (HEIC: no HEVC decoder on the server). The same rows as @draftroom/contracts
 * design-previews.ts DESIGN_FORMAT_ROWS (the worker does not depend on contracts; an api test compares the two).
 * classifyUpload makes the 'pages' rows kind 'pdf' (the worker previews them: apps/worker/src/{psd,tiff}.ts, and an
 * Illustrator file is a PDF); maxUploadBytes reads their limits.
 */
export const DESIGN_FORMATS: readonly DesignFormat[] = [
  {
    kind: 'psd',
    exts: ['psd'],
    mimes: ['image/vnd.adobe.photoshop', 'application/x-photoshop', 'application/photoshop'],
    preview: 'pages',
    maxBytes: 200 * MiB,
  },
  {
    kind: 'ai',
    exts: ['ai'],
    mimes: ['application/illustrator', 'application/postscript'],
    preview: 'pages',
    maxBytes: null,
  },
  { kind: 'tiff', exts: ['tif', 'tiff'], mimes: ['image/tiff'], preview: 'pages', maxBytes: 100 * MiB },
  {
    kind: 'heic',
    exts: ['heic', 'heif'],
    mimes: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
    preview: 'none',
    maxBytes: null,
  },
]

/**
 * The design format of an upload by its declared type and name (the same rule as @draftroom/contracts
 * designFormatOf): the extension first, else the type, where `application/postscript` alone is EPS or old
 * PostScript, not Illustrator. Untrusted (the worker decides by content).
 */
export function designFormat(mimeType: string, name: string): DesignFormat | null {
  const mime = baseMime(mimeType)
  const ext = extOf(name)
  const byExt = DESIGN_FORMATS.find((f) => (f.exts as readonly string[]).includes(ext))
  if (byExt) return byExt
  if (mime === 'application/postscript') return null
  return DESIGN_FORMATS.find((f) => f.mimes.includes(mime)) ?? null
}

/** The design format a MIME type names exactly (the worker's sniffed type), or null. */
export function designFormatByMime(mimeType: string | null | undefined): DesignFormat | null {
  const mime = baseMime(mimeType ?? '')
  if (!mime || mime === 'application/postscript') return null
  return DESIGN_FORMATS.find((f) => f.mimes.includes(mime)) ?? null
}

/**
 * A design upload with its own limit: classified 'pdf' by its design format ('pages'), or an attachment of a
 * 'none' format (HEIC). A file the type or name makes an image, a PDF or an Office document keeps their limits.
 */
export function designUploadFormat(kind: AssetKind, mimeType: string, name: string): DesignFormat | null {
  const mime = baseMime(mimeType)
  const ext = extOf(name)
  const pdfOrOffice = mime === 'application/pdf' || ext === 'pdf' || officeFormat(mimeType, name) !== null
  if (kind === 'pdf' && pdfOrOffice) return null
  const d = designFormat(mimeType, name)
  if (!d) return null
  if (d.preview === 'pages' && !designPreviewsOn) return null
  return (d.preview === 'pages' ? kind === 'pdf' : kind === 'other') ? d : null
}

/** The upload size limit of a file of `kind` with this declared type and name (Office, design files: their own). */
export function maxUploadBytes(kind: AssetKind, mimeType: string, name: string): number {
  if (isOfficeUpload(kind, mimeType, name)) return LIMITS.maxOfficeBytes
  const design = designUploadFormat(kind, mimeType, name)
  if (design) return design.maxBytes ?? LIMITS.maxBytes.pdf
  return LIMITS.maxBytes[kind]
}

/** The largest file of `kind` any upload may be (the worker's first size gate, before it knows the content). */
export function maxKindBytes(kind: AssetKind): number {
  if (kind !== 'pdf') return LIMITS.maxBytes[kind]
  const design = DESIGN_FORMATS.filter((f) => f.preview === 'pages').map((f) => f.maxBytes ?? 0)
  return Math.max(LIMITS.maxBytes.pdf, LIMITS.maxOfficeBytes, ...design)
}

/**
 * Characters that make a name read differently on screen than it is stored (FC-3,
 * docs/SECURITY-REVIEW-2026-09-27.md): the bidirectional controls U+061C, U+200E/F, U+202A-U+202E (the
 * embeddings and overrides: a U+202E in `invoice<U+202E>fdp.exe` shows the tail reversed, as `exe.pdf`)
 * and U+2066-U+2069 (the isolates), plus the line and paragraph separators U+2028/9. The same set the
 * guest names refuse (packages/contracts guests.ts).
 */
const BIDI_AND_SEPARATORS = /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/**
 * Display name: strip path parts, control characters (C0 and DEL) and bidi controls, cap the length.
 * Never used as a filesystem path.
 */
export function sanitizeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(BIDI_AND_SEPARATORS, '')
    .trim()
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

// ---- wave S: versions of a deliverable (docs/WAVE-S-CONTRACTS.md §3) --------------------------------------------

/**
 * The upload header that makes the upload a NEW VERSION of an existing deliverable: its value is the version it
 * supersedes (`ver_…`, the newest servable on the board), and the new version keeps that version's asset id
 * (contracts asset-versions.ts). Lower case, as Node exposes it. Until WS2 ships the api ignores it (a fresh asset,
 * as before wave S).
 */
export const SUPERSEDES_HEADER = 'x-lobby-supersedes'
