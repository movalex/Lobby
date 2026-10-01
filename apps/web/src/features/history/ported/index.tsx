// OWNER: 3h (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'history' feature on the Excalidraw board page
// (plan §4.6): one dock panel, `history`, as on the tldraw page (../index.tsx): named checkpoints (save,
// preview as a bitmap, restore as a new private board, owners delete), duplicate board, "Recently
// deleted" with restore, and the portable .json export. Name-only guests (a client on a review link, a
// workshop guest) never see History (DANA-05): the checkpoint names and who saved them are the team's;
// the api refuses them the list too.
import type { CanvasFeature } from '../../../canvas/api/index.ts'
import { knownUserKind } from '../../../invite/guest.tsx'
import '../history.css'
import { HistoryPanel } from './HistoryPanel.tsx'

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 3.5V8h4.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7.5V12l3 2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const feature: CanvasFeature = {
  id: 'history',
  panels: [
    {
      id: 'history',
      label: 'History',
      icon: HistoryIcon,
      // BOARD_FEATURES order: after comments, workshops and present (the dock sorts by `order`)
      order: 70,
      visible: (ctx) => knownUserKind(ctx.me.user.id) !== 'guest',
      component: HistoryPanel,
    },
  ],
}
