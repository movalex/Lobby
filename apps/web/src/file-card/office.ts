// Office documents on a file card (wave 4). They are kind 'pdf': the worker converts them to PDF and the
// card and page viewer show that PDF's pages. What makes them different on screen is said here, from
// the version's meta when the worker has confirmed the type by content, else from the upload's own
// type and name: the kind word ("Word document", never "PDF"), and the note that the pages are a
// converted preview, not the document itself (AGENTS.md: never claim a flattened preview is the file).
import type { FileCardShapeProps } from '@draftroom/canvas-schema'
import {
  type AssetVersionMeta,
  isOfficeUpload,
  type OfficeFormat,
  officeFormat,
  officeFormatByMime,
} from '../assets/contract.ts'

type CardProps = Pick<FileCardShapeProps, 'kind' | 'mimeType' | 'name'>

/** Shown on a card (and in the page viewer) whose pages come from an Office document's PDF conversion. */
export const CONVERSION_NOTE = 'Preview made from a PDF conversion'
/** What the conversion can change, for the page viewer's longer note. */
export const CONVERSION_DETAIL = 'Fonts and layout can differ from the original.'

/**
 * The Office format of a card, or null (a PDF, or not a document). A type the worker confirmed wins
 * (a real PDF named .docx is a PDF); before that, and after a failure, the upload's type and name say.
 */
export function cardOfficeFormat(meta: AssetVersionMeta | null, props: CardProps): OfficeFormat | null {
  const kind = meta?.kind ?? props.kind
  if (kind !== 'pdf') return null
  const confirmed = meta?.status === 'ready' ? meta.mimeType : null
  if (confirmed) return officeFormatByMime(confirmed)
  return isOfficeUpload(kind, props.mimeType, props.name) ? officeFormat(props.mimeType, props.name) : null
}

/** True when the pages shown are a conversion (ready, and confirmed as an Office document by content). */
export function isConvertedPreview(meta: AssetVersionMeta | null): boolean {
  return meta?.status === 'ready' && meta.kind === 'pdf' && officeFormatByMime(meta.mimeType) !== null
}

/** "Word document", "PowerPoint presentation"… or "PDF". */
export function documentLabel(meta: AssetVersionMeta | null, props: CardProps): string {
  return cardOfficeFormat(meta, props)?.label ?? 'PDF'
}
