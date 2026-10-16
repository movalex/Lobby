// OWNER: WS4 (wave S, the client review page; registered in features/canvas-registry.ts). One screen overlay: the
// `?view=review` page (./ReviewPageHost.tsx). It contributes nothing else (no panel, command or menu entry) and renders
// nothing while the review page switch (features/review/flags.ts `reviewPage`) is off or the address does not ask for it.
import type { CanvasFeature } from '../../canvas/api/index.ts'
import { ReviewPageHost } from './ReviewPageHost.tsx'

export { isReviewView } from './ReviewPageHost.tsx'

export const feature: CanvasFeature = {
  id: 'review-page',
  overlays: [
    // the dialog is portalled to <body> (the top layer); this layer only hosts it
    {
      id: 'review-page',
      layer: 'screen',
      order: 1100,
      pointer: 'none',
      focusMode: 'show',
      component: ReviewPageHost,
    },
  ],
}
