// OWNER: 3f. Private brainstorming (docs/WAVE3-CONTRACTS.md "private-notes") on the Excalidraw page, part
// of the workshops feature: the dock panel, and what happens on every open board when a session ends (a
// notice for everyone; the revealing tab shows the notes where they landed). The tldraw board's
// private-notes/index.tsx.
import type { CanvasFeatureContext, CanvasPanelSpec } from '../../../../canvas/api/index.ts'
import { PRIVATE_PANEL_ID, privateStoreFor } from '../../private-notes/hooks.ts'
import { isPresentingHere } from '../presenting.ts'
import {
  afterLayout,
  removeEmptyPrivateFrame,
  showPlacedNotes,
  waitForPlacedNotes,
  zoomToSession,
} from './canvas.ts'
import { PrivateNotesIcon, PrivateNotesPanel } from './PrivateNotesPanel.tsx'

export const privateNotesPanel: CanvasPanelSpec = {
  id: PRIVATE_PANEL_ID,
  label: 'Private notes',
  icon: PrivateNotesIcon,
  order: 210,
  component: PrivateNotesPanel,
}

const coarsePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches

export function mountPrivateNotes(ctx: CanvasFeatureContext): () => void {
  const store = privateStoreFor(ctx)
  const canvas = ctx.canvas
  const stops = new Set<() => void>()
  const off = store.onSessionEnded(({ session, revealedHere, endedHere }) => {
    // The person who ended it tidies up: a "Private ideas" frame made for a brainstorm that put no
    // notes in it goes away again (R2-01; an ordinary edit, so Ctrl+Z brings it back).
    if (endedHere && (session.status === 'cancelled' || (session.placedCount ?? 0) === 0))
      removeEmptyPrivateFrame(canvas, session.frameId)
    if (session.status === 'cancelled') {
      ctx.notify({
        key: 'private-notes',
        text: 'The private brainstorm was cancelled. Its notes were discarded.',
        testId: 'pn-toast',
      })
      return
    }
    const n = session.placedCount ?? 0
    // The tab that revealed shows the notes where they landed once they arrive (they may be off
    // screen, or tiny at the zoom the facilitator was at: round-2 F5). The server laid them out.
    if (revealedHere && n > 0)
      stops.add(
        waitForPlacedNotes(canvas, session.id, n, (ids) =>
          // After the layout settles: on a phone the panel closes as the notes arrive (R2-03).
          afterLayout(canvas, () => void showPlacedNotes(canvas, ids, isPresentingHere(canvas))),
        ),
      )
    ctx.notify({
      key: 'private-notes',
      text:
        n === 0
          ? 'The private brainstorm ended with no notes.'
          : `${n} note${n === 1 ? '' : 's'} from the private brainstorm ${n === 1 ? 'is' : 'are'} now on the board.`,
      testId: 'pn-toast',
      // A phone user may be busy with the panel: "Show me" stays until they have had time to see it.
      timeoutMs: n > 0 && coarsePointer() ? 20_000 : undefined,
      action:
        n === 0
          ? undefined
          : {
              label: 'Show me',
              testId: 'pn-toast-show',
              onClick: () => void zoomToSession(canvas, session.id, session.frameId),
            },
    })
  })
  return () => {
    off()
    for (const stop of stops) stop()
  }
}
