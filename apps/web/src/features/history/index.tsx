// Feature module: history (docs/FEATURES-M2-CONTRACTS.md "history"; checklist REV-07, REV-08, DSH-02,
// PRS-06 export part). One dock panel, `history`: named checkpoints (save; restore as a new private
// board), duplicate board, "Recently deleted" with restore, and the portable .json export.
// The dashboard's import/duplicate buttons belong to dashboard-share and call the same API routes.

import type { BoardFeature } from '../types.ts'
import './history.css'
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

export const historyFeature: BoardFeature = {
  id: 'history',
  panels: [
    {
      id: 'history',
      label: 'History',
      icon: <HistoryIcon />,
      Component: HistoryPanel,
    },
  ],
}
