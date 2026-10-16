// Design files on a file card (wave R, WS3; docs/WAVE-R-CONTRACTS.md §6). Photoshop, Illustrator and TIFF files are kind
// 'pdf': the worker renders them as flattened pages, so the card and the page viewer show those pages with the
// "Flattened preview" badge and the original's type ("PSD"), never "editable" (AGENTS.md: never claim a flattened
// preview is the file); the download is the original. HEIC files are attachments with a hint (no HEVC decoder on the
// server). Decided from the version's meta once the worker has confirmed the type by content (a real PDF named .psd
// is a PDF), else from the upload's own type and name.
import type { FileCardShapeProps } from '@draftroom/canvas-schema'
import {
  DESIGN_FORMAT_ROWS,
  DESIGN_PREVIEW_BADGE,
  DESIGN_PREVIEW_CODES,
  DESIGN_PREVIEW_MESSAGES,
  type DesignFormatRow,
  designFormatOf,
} from '@draftroom/contracts'
import { type AssetVersionMeta, usableDerivatives } from '../assets/contract.ts'

type CardProps = Pick<FileCardShapeProps, 'kind' | 'mimeType' | 'name'>

export { DESIGN_PREVIEW_BADGE }

/** What the page viewer adds to the badge: the pages are a rendering, not the file. */
export const FLATTENED_DETAIL = 'Layers are not shown. Download the original to work on it.'

const byMime = (mime: string | null | undefined) => {
  const m = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? ''
  if (!m || m === 'application/postscript') return null
  return DESIGN_FORMAT_ROWS.find((r) => r.mimes.includes(m)) ?? null
}
const AI = DESIGN_FORMAT_ROWS.find((r) => r.kind === 'ai') ?? null

/**
 * The design format of a card, or null. A type the worker confirmed wins: a PSD or TIFF by its sniffed type, an
 * Illustrator file as a PDF with an .ai name. Before that, and after a failure, the upload's type and name say (as
 * the upload route classified it: pages formats are kind 'pdf', HEIC kind 'other').
 */
export function cardDesignFormat(meta: AssetVersionMeta | null, props: CardProps): DesignFormatRow | null {
  const kind = meta?.kind ?? props.kind
  const name = meta?.name || props.name
  if (meta?.status === 'ready' && kind === 'pdf') {
    const confirmed = byMime(meta.mimeType)
    if (confirmed) return confirmed.preview === 'pages' ? confirmed : null
    return meta.mimeType === 'application/pdf' && designFormatOf('', name)?.kind === 'ai' ? AI : null
  }
  const declared = designFormatOf(props.mimeType, name)
  if (!declared) return null
  return (declared.preview === 'pages' ? kind === 'pdf' : kind === 'other') ? declared : null
}

/** True when the card shows a flattened preview of a design file (ready, pages from the worker). */
export function isFlattenedPreview(meta: AssetVersionMeta | null, props: CardProps): boolean {
  return meta?.status === 'ready' && meta.kind === 'pdf' && cardDesignFormat(meta, props)?.preview === 'pages'
}

/**
 * A Photoshop file saved without "Maximize Compatibility": the worker could only use its embedded thumbnail, which
 * it hands over as the cover alone (a `thumb`, no `page` derivative).
 */
export function isLowResolutionPreview(meta: AssetVersionMeta | null, props: CardProps): boolean {
  if (!meta || !isFlattenedPreview(meta, props) || cardDesignFormat(meta, props)?.kind !== 'psd') return false
  const all = usableDerivatives(meta)
  return all.some((d) => d.role === 'thumb') && !all.some((d) => d.role === 'page')
}

/** The badge's words: "Flattened preview · PSD". */
export const designBadgeText = (format: DesignFormatRow) => `${DESIGN_PREVIEW_BADGE} · ${format.label}`

/** The hint a design card shows under its preview, or null: HEIC's (no preview), or the low-resolution note. */
export function designHint(meta: AssetVersionMeta | null, props: CardProps): string | null {
  const format = cardDesignFormat(meta, props)
  if (format?.kind === 'heic') return DESIGN_PREVIEW_MESSAGES[DESIGN_PREVIEW_CODES.heic]
  if (isLowResolutionPreview(meta, props)) {
    return DESIGN_PREVIEW_MESSAGES[DESIGN_PREVIEW_CODES.psdThumbnailOnly]
  }
  return null
}

/** What the page viewer and the card's description call the file: "PSD", "AI", "TIFF", or null. */
export function designLabel(meta: AssetVersionMeta | null, props: CardProps): string | null {
  const format = cardDesignFormat(meta, props)
  return format?.preview === 'pages' ? format.label : null
}
