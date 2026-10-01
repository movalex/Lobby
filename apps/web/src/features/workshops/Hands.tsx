// Raise hand (FAC-08), UI: the top-bar chip that shows how many hands are up (everyone sees it), the
// queue inside the workshop tools popover (facilitators lower hands there; everyone else sees who is
// waiting and can lower their own), and the toasts that tell a facilitator a hand went up and tell
// a person their hand was lowered. Raising is in the reaction bar (Reactions.tsx). The API keeps the
// queue in memory and enforces who may lower whom.

import { HAND_AUTO_LOWER_MS, type RaisedHand } from '@draftroom/contracts'
import { type Ref, useEffect, useRef, useState } from 'react'
import { ownName, ownNameParts, splitGuestMarker } from '../../invite/model.ts'
import { handNotice, waitedFor } from './hand-notices.ts'
import type { WorkshopSnapshot, WorkshopStore } from './store.ts'
import { useIsFacilitator, useNow, type WorkshopContext } from './workshop-context.ts'

export function HandIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d="M8 11V5.5a1.5 1.5 0 0 1 3 0V10m0-5.5V4a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.2 16a1.6 1.6 0 0 1 2.4-2.1L8 16V11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Top-bar chip while any hand is up: "✋ 2". Opens the queue in the workshop tools. */
export function HandsChip({ snap, onOpen }: { snap: WorkshopSnapshot; onOpen(): void }) {
  const n = snap.hands.length
  if (n === 0) return null
  const mine = snap.myHand
  const position = mine ? snap.hands.findIndex((h) => h.userId === mine.userId) + 1 : 0
  const label = `${n} raised hand${n === 1 ? '' : 's'}${mine ? `, yours is number ${position}` : ''}. Show the queue`
  return (
    <button
      type="button"
      className="dr-wk-hands-chip"
      data-testid="hands-chip"
      data-count={n}
      data-mine={mine ? 'true' : 'false'}
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <HandIcon size={14} />
      <span>{n}</span>
    </button>
  )
}

/**
 * A person's name where space is short: a long name is cut with an ellipsis, never the "(guest)"
 * marker after it (round-2 G-R9; the member-row pattern of the share dialog).
 */
export function PersonName({
  name,
  suffix,
  className,
}: {
  name: string
  /** Shown after the marker, never cut either (" (you)"). */
  suffix?: string
  className?: string
}) {
  const [base, marker] = splitGuestMarker(name)
  // F14: a guest's own name reads "Kai (guest, you)", not "Kai (guest) (you)".
  const own = marker !== null && suffix === ' (you)'
  return (
    <span className={`dr-wk-person${className ? ` ${className}` : ''}`}>
      <span className="dr-wk-person__name">{base}</span>
      {marker && (
        <span className="dr-wk-person__keep" data-testid="guest-marker">
          {own ? ownNameParts(name)[1] : marker}
        </span>
      )}
      {suffix && !own && <span className="dr-wk-person__keep">{suffix}</span>}
    </span>
  )
}

/**
 * While presenting, the top bar (and its chip) and the toasts are hidden: the presenter still sees
 * that hands are up, and whose, in the corner of the slides (next to the floating timer). Kept on
 * purpose (FAC-08; round-2 F17 asked): whoever presents is the one who calls on people.
 */
export function PresentingHands({ snap }: { snap: WorkshopSnapshot }) {
  const n = snap.hands.length
  if (n === 0) return null
  const names = snap.hands.map((h) => h.name)
  const shown = snap.hands.slice(0, 2)
  return (
    <div
      className="dr-wk-floating dr-wk-floating--hands"
      data-testid="hands-floating"
      data-count={n}
      role="status"
      title={names.join(', ')}
    >
      <HandIcon size={18} />
      <span className="dr-wk-floating__n">{n}</span>
      <span className="dr-wk-floating__names">
        {shown.map((h, i) => (
          <PersonName key={h.userId} name={h.name} suffix={i < shown.length - 1 ? ', ' : undefined} />
        ))}
        {n > 2 && <span className="dr-wk-floating__more">{` +${n - 2}`}</span>}
      </span>
    </div>
  )
}

/** The raised-hands queue, a section of the workshop tools popover. */
export function HandsSection({
  ctx,
  store,
  snap,
  sectionRef,
}: {
  ctx: WorkshopContext
  store: WorkshopStore
  snap: WorkshopSnapshot
  sectionRef?: Ref<HTMLElement>
}) {
  const facilitator = useIsFacilitator(ctx)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hands = snap.hands
  const now = useNow(hands.length > 0, 15_000)
  if (!facilitator && hands.length === 0) return null
  const offset = store.serverOffsetMs()
  const me = ctx.me.user.id

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'That did not work.')
  }

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="dr-wk-pop__section"
      aria-label="Raised hands"
      data-testid="hands-queue"
      data-count={hands.length}
    >
      <div className="dr-wk-pop__head">
        <h3>Raised hands</h3>
        {hands.length > 1 && facilitator && (
          <button
            type="button"
            className="dr-linkbtn"
            data-testid="hands-clear"
            disabled={busy}
            onClick={() => void act(() => store.clearHands())}
          >
            Lower all
          </button>
        )}
      </div>
      {hands.length === 0 ? (
        <p className="dr-wk-hint">No hands are up. People raise theirs from the reactions button.</p>
      ) : (
        <ol className="dr-wk-hands">
          {hands.map((h: RaisedHand, i) => {
            const mine = h.userId === me
            return (
              <li key={h.userId} data-testid="hand-row" data-user-id={h.userId} data-position={i + 1}>
                <span className="dr-wk-hands__pos" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="dr-wk-hands__name" title={mine ? ownName(h.name) : h.name}>
                  <PersonName name={h.name} suffix={mine ? ' (you)' : undefined} />
                  <span className="dr-wk-hands__when">{waitedFor(h.raisedAt, now, offset)}</span>
                </span>
                {(facilitator || mine) && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="hand-lower"
                    disabled={busy}
                    aria-label={mine ? 'Lower your hand' : `Lower ${h.name}’s hand`}
                    onClick={() => void act(() => (mine ? store.setHand(false) : store.lowerHand(h.userId)))}
                  >
                    Lower
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <p className="dr-wk-hint">
        {facilitator
          ? `Hands go down on their own after ${HAND_AUTO_LOWER_MS / 60_000} minutes, or when someone leaves the board.`
          : 'Facilitators see this queue and lower hands when it is your turn.'}
      </p>
      {error && (
        <p className="dr-field-error" role="alert" data-testid="hands-error">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * Toasts for hand changes (rendered in the overlay, which is always mounted, with the live ctx: the
 * role can change during a session).
 */
export function HandToasts({ ctx, store }: { ctx: WorkshopContext; store: WorkshopStore }) {
  const live = useRef(ctx)
  live.current = ctx
  const facilitating = useRef(false)
  facilitating.current = useIsFacilitator(ctx)
  useEffect(
    () =>
      store.onHandChanges((changes) => {
        const c = live.current
        const facilitator = facilitating.current
        const raisedCount = store.getSnapshot().hands.length
        for (const change of changes) {
          const n = handNotice(change, { selfUserId: c.me.user.id, facilitator, raisedCount })
          if (!n) continue
          // R2-07: with the queue already open, it shows the new hand; a toast would only cover it.
          if (n.openQueue && document.querySelector('[data-testid="hands-queue"]')) continue
          // The queue lives in the top-bar popover; on narrow screens the bar is in the "⋯" menu.
          const canOpen = n.openQueue && !!document.querySelector('[data-testid="timer-pill"]')
          c.notify({
            key: n.key,
            text: n.text,
            testId: n.testId,
            timeoutMs: 6_000,
            ...(canOpen
              ? {
                  action: {
                    label: 'Show queue',
                    testId: 'hand-toast-open',
                    onClick: () => store.requestTools('hands'),
                  },
                }
              : {}),
          })
        }
      }),
    [store],
  )
  return null
}
