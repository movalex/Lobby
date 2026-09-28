// Top-bar pieces for private brainstorming, rendered by WorkshopBar: a chip while a session is active
// ("Private brainstorm · 7 notes from 4 people", opens the panel), the setup dialog, and a section in
// the workshop tools popover (start one, or open the panel).

import { useEffect } from 'react'
import type { FeatureContext } from '../../types.ts'
import { canEditBoard, useIsFacilitator } from '../hooks.ts'
import { chipCounts, describeCounts, PRIVATE_PANEL_ID, usePrivateNotes } from './hooks.ts'
import { LockIcon } from './PrivateNotesPanel.tsx'
import { SetupDialog } from './SetupDialog.tsx'
import './private-notes.css'

export function PrivateNotesChip({ ctx }: { ctx: FeatureContext }) {
  const { store, snap } = usePrivateNotes(ctx)
  const s = snap.session
  const counts = describeCounts(snap.counts)
  // Someone who can write and has not yet is asked to (R4); whoever can reveal keeps the counts.
  const invite = canEditBoard(ctx) && !snap.canReveal && snap.myNotes.length === 0
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
            {chipCounts(s.status, snap.counts, invite)}
          </span>
        </button>
      )}
      {snap.setupOpen && <SetupDialog ctx={ctx} store={store} onClose={() => store.setSetupOpen(false)} />}
    </>
  )
}

/**
 * On the canvas when someone else starts a private brainstorm (final review R2/R4), for everyone who
 * can write, on every screen size (on phones the top-bar chip sits in the "⋯" menu): the prompt and
 * one button that opens their Private notes panel. Gone once they answer it or open the panel; never
 * for the starter, nor for someone who already wrote in the session.
 */
export function PrivateNotesStartPrompt({ ctx }: { ctx: FeatureContext }) {
  const { store, snap } = usePrivateNotes(ctx)
  const s = snap.session
  const panelOpen = ctx.activePanel === PRIVATE_PANEL_ID
  const shown =
    !!s && s.status === 'open' && snap.startNews?.sessionId === s.id && canEditBoard(ctx) && !panelOpen
  useEffect(() => {
    if (panelOpen) store.dismissStartNews()
  }, [panelOpen, store])
  if (!shown || !s) return null
  return (
    <section
      className="dr-wk-prompt dr-pn-start"
      aria-label="Private brainstorm started"
      data-testid="pn-start-prompt"
    >
      <p className="dr-pn-start__title">
        <LockIcon />
        <span>
          <strong>Private brainstorm:</strong> <span data-testid="pn-start-prompt-text">{s.prompt}</span>
        </span>
      </p>
      <p className="dr-wk-hint">
        Only you see your notes until they're revealed
        {s.anonymous ? ', and your name is never shown with them.' : ', under your name.'}
      </p>
      <div className="dr-wk-row">
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="pn-start-prompt-write"
          onClick={() => {
            store.dismissStartNews()
            ctx.openPanel(PRIVATE_PANEL_ID)
          }}
        >
          Add your notes
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="pn-start-prompt-later"
          onClick={() => store.dismissStartNews()}
        >
          Later
        </button>
      </div>
    </section>
  )
}

export function PrivateNotesSection({ ctx, onClose }: { ctx: FeatureContext; onClose(): void }) {
  const { store, snap } = usePrivateNotes(ctx)
  const facilitator = useIsFacilitator(ctx)
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
