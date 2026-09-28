// Private brainstorming (docs/WAVE3-CONTRACTS.md "private-notes"), part of the workshops feature:
// the dock panel, the top-bar pieces (PrivateNotesBar.tsx) and what happens on every open board when
// a session ends (a notice for everyone; the revealing tab fits the notes to their text and shows them).

import type { FeatureContext, FeaturePanel } from '../../types.ts'
import { isPresentingNow } from '../presenting.ts'
import {
  afterLayout,
  fitPlacedNotes,
  removeEmptyPrivateFrame,
  showPlacedNotes,
  zoomToSession,
} from './canvas.ts'
import { PRIVATE_PANEL_ID, privateStoreFor } from './hooks.ts'
import { PrivateNotesIcon, PrivateNotesPanel } from './PrivateNotesPanel.tsx'
import './private-notes.css'

export { PrivateNotesChip, PrivateNotesSection } from './PrivateNotesBar.tsx'

export const privateNotesPanel: FeaturePanel = {
  id: PRIVATE_PANEL_ID,
  label: 'Private notes',
  icon: <PrivateNotesIcon />,
  Component: PrivateNotesPanel,
}

const coarsePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches

export function mountPrivateNotes(ctx: FeatureContext): () => void {
  const store = privateStoreFor(ctx)
  const stops = new Set<() => void>()
  const off = store.onSessionEnded(({ session, revealedHere, endedHere }) => {
    // The person who ended it tidies up: a "Private ideas" frame made for a brainstorm that put no
    // notes in it goes away again (R2-01; an ordinary edit, so Ctrl+Z brings it back).
    if (endedHere && (session.status === 'cancelled' || (session.placedCount ?? 0) === 0))
      removeEmptyPrivateFrame(ctx.editor, session.frameId)
    if (session.status === 'cancelled') {
      ctx.notify({
        key: 'private-notes',
        text: 'The private brainstorm was cancelled. Its notes were discarded.',
        testId: 'pn-toast',
      })
      return
    }
    const n = session.placedCount ?? 0
    // The tab that revealed fits the notes to their text, then shows them where they landed (they may
    // be off screen, or tiny at the zoom the facilitator was at: round-2 F5).
    if (revealedHere && n > 0)
      stops.add(
        fitPlacedNotes(ctx.editor, session.id, n, undefined, (ids) =>
          // After the layout settles: on a phone the panel closes as the notes arrive (R2-03).
          afterLayout(ctx.editor, () => void showPlacedNotes(ctx.editor, ids, isPresentingNow())),
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
              onClick: () => void zoomToSession(ctx.editor, session.id, session.frameId),
            },
    })
  })
  return () => {
    off()
    for (const stop of stops) stop()
  }
}
