// OWNER: the wave S foundation (the lead). The review viewer's named slots, so WS1, WS2 and WS3 each fill their part
// of the one modal from their own folder and never edit the same file (docs/WAVE-S-CONTRACTS.md §7):
//
//   header   the bar under the title: WS2's version picker and "Compare" (order 10), WS1's status pill and buttons
//            (order 20)
//   body     the file itself, per kind: WS3's video transport and scrubber markers (video), image with spot pins
//            (image), the PDF pages with page markers (pdf)
//   compare  WS2's A/B compare (slider, side by side, onion skin; video A/B), shown instead of `body` in compare mode
//   threads  WS3's side list of this version's threads (a bottom sheet on phones), the composer, "Export comments"
//
// A slot entry is registered once at module load by its owner's index (registerViewerSlot returns the undo, for
// tests). The host renders, per slot, the entries whose `kinds` include the file's kind (absent: every kind), by
// `order`. Keys are the viewer's own (ViewerHost stops them at the dialog; Excalidraw never sees them).
import type { ComponentType } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { ReviewViewerRequest } from './viewer-state.ts'

export const VIEWER_SLOTS = ['header', 'body', 'compare', 'threads'] as const
export type ViewerSlotName = (typeof VIEWER_SLOTS)[number]

export type ViewerFileKind = 'image' | 'pdf' | 'video' | 'other'

/** What every slot component gets: the board page, the request, and the file as the card names it. */
export interface ViewerSlotProps {
  readonly ctx: CanvasFeatureContext
  readonly request: ReviewViewerRequest
  readonly file: { readonly kind: ViewerFileKind; readonly name: string; readonly mimeType: string }
  /** closes the viewer (Escape and the close button do too) */
  readonly close: () => void
}

export interface ViewerSlotEntry {
  /** unique, `<workstream>.<what>` (e.g. 'ws3.video') */
  readonly id: string
  readonly slot: ViewerSlotName
  /** the file kinds it is for; absent: every kind */
  readonly kinds?: readonly ViewerFileKind[]
  /** lower first; default 0 */
  readonly order?: number
  readonly Component: ComponentType<ViewerSlotProps>
}

const entries = new Map<string, ViewerSlotEntry>()

/** Adds (or replaces, by id) a slot entry; returns its removal. */
export function registerViewerSlot(entry: ViewerSlotEntry): () => void {
  entries.set(entry.id, entry)
  return () => {
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
  }
}

/** The entries of `slot` for a file of `kind`, in order (then by id, so the order never depends on load order). */
export function viewerSlotEntries(slot: ViewerSlotName, kind: ViewerFileKind): ViewerSlotEntry[] {
  return [...entries.values()]
    .filter((e) => e.slot === slot && (!e.kinds || e.kinds.includes(kind)))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
}
