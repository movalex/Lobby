// OWNER: 3f. Top-bar and canvas pieces for private brainstorming on the Excalidraw page (the tldraw
// board's private-notes/PrivateNotesBar.tsx), rendered by WorkshopBar and the workshops overlay: a chip
// while a session is active ("Private brainstorm · 7 notes from 4 people", opens the panel), the setup
// dialog, the start prompt and phone reminder on the canvas, and a section in the workshop tools popover
// (start one, or open the panel).

import { useEffect } from 'react'
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { TABLET_QUERY, useMediaQuery } from '../../../../ui/useMedia.ts'
import { chipCounts, describeCounts, PRIVATE_PANEL_ID, usePrivateNotes } from '../../private-notes/hooks.ts'
import { canEditBoard, useIsFacilitator } from '../../workshop-context.ts'
import { LockIcon } from './PrivateNotesPanel.tsx'
import { SetupDialog } from './SetupDialog.tsx'
import '../../private-notes/private-notes.css'

type Ctx = CanvasFeatureContext

export function PrivateNotesChip({ ctx }: { ctx: Ctx }) {
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
          onClick={() => {
            // Someone who can write goes straight to the note box (A11Y2-01).
            if (s.status === 'open' && canEditBoard(ctx)) store.requestComposeFocus()
            ctx.openPanel(PRIVATE_PANEL_ID)
          }}
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
export function PrivateNotesStartPrompt({ ctx }: { ctx: Ctx }) {
  const { store, snap } = usePrivateNotes(ctx)
  const s = snap.session
  const panelOpen = ctx.activePanel === PRIVATE_PANEL_ID
  const shown =
    !!s && s.status === 'open' && snap.startNews?.sessionId === s.id && canEditBoard(ctx) && !panelOpen
  useEffect(() => {
    if (panelOpen) store.dismissStartNews()
  }, [panelOpen, store])
  // Announced once as it appears (A11Y2-01): the card itself is not a live region (it has buttons).
  const announce = shown && s ? `Private brainstorm started: ${s.prompt}. Add your notes.` : ''
  const live = (
    <p className="dr-sr-only" aria-live="polite" data-testid="pn-start-announce">
      {announce}
    </p>
  )
  if (!shown || !s) return live
  return (
    <>
      {live}
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
              // The note box takes the keyboard, so typing goes into the note, never into the board's
              // tool shortcuts (A11Y2-01).
              store.requestComposeFocus()
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
    </>
  )
}

/**
 * Phones and small tablets (the top-bar chip is in the "⋯" menu there): while a brainstorm is open, a
 * small pill on the canvas reminds everyone who can write, whether or not they wrote already, and
 * after a reload too (final review R2-12). Not while the start card or the panel is up.
 */
export function PrivateNotesReminder({ ctx }: { ctx: Ctx }) {
  const { store, snap } = usePrivateNotes(ctx)
  const narrow = useMediaQuery(TABLET_QUERY)
  const s = snap.session
  const panelOpen = ctx.activePanel === PRIVATE_PANEL_ID
  const card = !!s && snap.startNews?.sessionId === s.id
  if (!narrow || !s || s.status !== 'open' || !canEditBoard(ctx) || panelOpen || card) return null
  const n = snap.myNotes.length
  return (
    <button
      type="button"
      className="dr-wk-chip dr-pn-chip dr-pn-reminder"
      data-testid="pn-reminder"
      onClick={() => {
        store.requestComposeFocus()
        ctx.openPanel(PRIVATE_PANEL_ID)
      }}
    >
      <LockIcon />
      <span>Private brainstorm · {n === 0 ? 'Add your notes' : `Your notes (${n})`}</span>
    </button>
  )
}

export function PrivateNotesSection({ ctx, onClose }: { ctx: Ctx; onClose(): void }) {
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
