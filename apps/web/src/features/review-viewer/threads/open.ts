// OWNER: WS3 (wave S, media comments). Opening the review viewer for media comments: from the canvas's thread
// popover ("Jump to 00:12.4", "Open page 3", a "v1" chip opens the viewer on that version), and from the selection
// bar's "Review" on one video, PDF (or Office document) or image.
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type { CommentAnchor } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { factsOf, pageOfFileId } from '../../../file-card/ported/model.ts'
import { formatClock } from '../video/timecode.ts'
import { openReviewViewer } from '../viewer-state.ts'
import { mediaCommentsOn } from './shared.tsx'

/** The kinds the viewer comments on (an "other" file has no picture). */
const MEDIA_KINDS: ReadonlySet<string> = new Set(['video', 'pdf', 'image'])

/** The file a live element shows, when it is one the viewer takes. */
export function mediaFileOf(ctx: CanvasFeatureContext, elementId: string) {
  const el = ctx.canvas.get(elementId)
  if (!el || el.isDeleted) return null
  const facts = factsOf(el)
  if (!facts || !MEDIA_KINDS.has(facts.kind)) return null
  const page = pageOfFileId((el as { fileId?: string | null }).fileId)
  return { elementId: el.id, facts, page }
}

/** The one selected element the selection bar's "Review" opens (the media comments switch on), or null. */
export function reviewTarget(ctx: CanvasFeatureContext, selection: readonly string[]) {
  if (!mediaCommentsOn() || selection.length !== 1) return null
  return mediaFileOf(ctx, selection[0] ?? '')
}

/** Opens the viewer on the selected file (a placed PDF page opens at its page). */
export function reviewSelection(ctx: CanvasFeatureContext, selection: readonly string[]): boolean {
  const t = reviewTarget(ctx, selection)
  if (!t) return false
  openReviewViewer(ctx.registries, {
    elementId: t.elementId,
    assetId: t.facts.assetId,
    versionId: t.facts.versionId,
    ...(t.page ? { at: { page: t.page } } : {}),
  })
  return true
}

/** What the canvas popover's button says for a thread's anchor, or null when the viewer does not take it. */
export function viewerButtonText(ctx: CanvasFeatureContext, anchor: CommentAnchor): string | null {
  if (anchor.kind !== 'asset' || !mediaCommentsOn()) return null
  const id = fromShapeRef(anchor.shapeId)
  const file = id ? mediaFileOf(ctx, id) : null
  if (!file || file.facts.assetId !== anchor.assetId) return null
  if (anchor.timeMs !== undefined) return `Jump to ${formatClock(anchor.timeMs)}`
  if (anchor.page !== undefined) return `Open page ${anchor.page}`
  return 'Open in viewer'
}

/** Opens the viewer on a thread: its version, its time or page, the thread picked in the list. */
export function openThreadInViewer(
  ctx: CanvasFeatureContext,
  threadId: string,
  anchor: CommentAnchor,
): boolean {
  if (anchor.kind !== 'asset') return false
  const id = fromShapeRef(anchor.shapeId)
  const file = id ? mediaFileOf(ctx, id) : null
  if (!file || file.facts.assetId !== anchor.assetId) return false
  openReviewViewer(ctx.registries, {
    elementId: file.elementId,
    assetId: anchor.assetId,
    versionId: anchor.versionId,
    at: {
      ...(anchor.timeMs !== undefined ? { timeMs: anchor.timeMs } : {}),
      ...(anchor.page !== undefined ? { page: anchor.page } : {}),
    },
    threadId,
  })
  return true
}
