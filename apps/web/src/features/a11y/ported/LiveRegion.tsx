// OWNER: 3i. The `liveRegion` host slot (docs/EXCALIDRAW-CONTRACTS.md §3): tldraw's DefaultA11yAnnouncer on
// the Excalidraw board page. The board page renders the slot off screen (a 1 px clipped box) and keeps it in
// focus mode, so a screen reader still hears a presentation. Same roles as tldraw's: a status region that
// speaks at once (`aria-live="assertive"`), labelled "Status". Always rendered, so the first message is heard.
//
// The slot also holds the canvas's key description (CANVAS_HINT_ID), which the canvas the keyboard lands on
// points to with aria-describedby (./index.tsx `nameTheCanvas`).
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { announcerFor } from './announcer.ts'

/** The id of the canvas's key description. */
export const CANVAS_HINT_ID = 'dr-a11y-canvas-hint'

export function LiveRegion({ ctx }: { readonly ctx: CanvasFeatureContext }) {
  const announcer = announcerFor(ctx.canvas)
  const message = useValue(announcer.message)
  return (
    <>
      <div role="status" aria-live="assertive" aria-label="Status" data-testid="canvas-announcer">
        {message}
      </div>
      <p id={CANVAS_HINT_ID} data-testid="canvas-key-hint">
        Alt with the arrow keys moves between items. Enter edits the selected item. F6 comes back to the
        board.
      </p>
    </>
  )
}
