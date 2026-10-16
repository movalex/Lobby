// OWNER: WS3 (wave S, media comments). Fills the review viewer's slots (../slots.ts) once, at module load: the `body`
// per kind (video transport and scrubber markers, image with spot pins, PDF pages with page markers) and the
// `threads` list with the composer and "Export comments". Imported by the comments feature (features/comments/
// ported/index.tsx), which also offers "Review" in the selection bar. Every part draws nothing while the media
// comments switch is off (features/review/flags.ts).
import type { SelectionBarItemSpec } from '../../../canvas/api/index.ts'
import { ImageBody } from '../image/ImageBody.tsx'
import { PdfBody } from '../pdf/PdfBody.tsx'
import { registerViewerSlot } from '../slots.ts'
import { VideoBody } from '../video/VideoBody.tsx'
import { reviewSelection, reviewTarget } from './open.ts'
import { ThreadsSlot } from './ThreadsSlot.tsx'
import './media-comments.css'

registerViewerSlot({ id: 'ws3.video', slot: 'body', kinds: ['video'], Component: VideoBody })
registerViewerSlot({ id: 'ws3.image', slot: 'body', kinds: ['image'], Component: ImageBody })
registerViewerSlot({ id: 'ws3.pdf', slot: 'body', kinds: ['pdf'], Component: PdfBody })
registerViewerSlot({
  id: 'ws3.threads',
  slot: 'threads',
  kinds: ['video', 'image', 'pdf'],
  Component: ThreadsSlot,
})

/** The selection bar's "Review": one video, PDF or image selected, the media comments switch on. */
export const reviewButton: SelectionBarItemSpec = {
  id: 'comments.review-media',
  order: 79,
  visible: (ctx, selection) => reviewTarget(ctx, selection) !== null,
  component: ({ ctx, selection }) => (
    <button
      type="button"
      className="dr-btn dr-btn--sm dr-btn--ghost"
      data-testid="review-media"
      title="Open the viewer to comment at a time, on a page or on a spot"
      onClick={() => reviewSelection(ctx, selection)}
    >
      Review
    </button>
  ),
}
