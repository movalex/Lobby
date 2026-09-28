// Top-bar pieces for private brainstorming, rendered by WorkshopBar: a chip while a session is active
// ("Private brainstorm · 7 notes from 4 people", opens the panel), the setup dialog, and a section in
// the workshop tools popover (start one, or open the panel).

import type { FeatureContext } from '../../types.ts'
import { isFacilitator } from '../hooks.ts'
import { chipCounts, describeCounts, PRIVATE_PANEL_ID, usePrivateNotes } from './hooks.ts'
import { LockIcon } from './PrivateNotesPanel.tsx'
import { SetupDialog } from './SetupDialog.tsx'
import './private-notes.css'

export function PrivateNotesChip({ ctx }: { ctx: FeatureContext }) {
  const { store, snap } = usePrivateNotes(ctx)
  const s = snap.session
  const counts = describeCounts(snap.counts)
  return (
    <>
      {s && (
        <button
          type="button"
          className="dr-wk-chip dr-pn-chip"
          data-testid="pn-chip"
          data-state={s.status}
          aria-label={`Private brainstorm: ${counts}. Open private notes`}
          title="Open private notes"
          onClick={() => ctx.openPanel(PRIVATE_PANEL_ID)}
        >
          <LockIcon />
          <span className="dr-pn-chip__label">Private brainstorm</span>
          <span className="dr-pn-chip__counts" data-testid="pn-chip-counts">
            {chipCounts(s.status, snap.counts)}
          </span>
        </button>
      )}
      {snap.setupOpen && <SetupDialog ctx={ctx} store={store} onClose={() => store.setSetupOpen(false)} />}
    </>
  )
}

export function PrivateNotesSection({ ctx, onClose }: { ctx: FeatureContext; onClose(): void }) {
  const { store, snap } = usePrivateNotes(ctx)
  const facilitator = isFacilitator(ctx)
  if (!snap.session && !facilitator) return null
  return (
    <section className="dr-wk-pop__section" aria-label="Private brainstorm">
      <h3>Private brainstorm</h3>
      {snap.session ? (
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-wk-wide"
          data-testid="pn-open-panel"
          onClick={() => {
            onClose()
            ctx.openPanel(PRIVATE_PANEL_ID)
          }}
        >
          Open private notes ({describeCounts(snap.counts).toLowerCase()})
        </button>
      ) : (
        <>
          <p className="dr-wk-hint">
            Everyone writes notes nobody else sees, then you reveal them all at once.
          </p>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-wk-wide"
            data-testid="pn-start"
            onClick={() => {
              onClose()
              store.setSetupOpen(true)
            }}
          >
            Start a private brainstorm…
          </button>
        </>
      )}
    </section>
  )
}
