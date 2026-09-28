// Reactions and raise hand (FAC-08), UI: a reactions button in the top bar opens a small bar with
// the six reactions and the raise-hand toggle; every reaction on the board shows as a short burst
// near the sender's cursor (or below the top bar, see reactions.ts placeBurst) for everyone. Bursts
// only fade in and out for people who prefer reduced motion (workshops.css). Nothing is stored.

import { REACTION_EMOJIS, REACTION_LABELS, type ReactionEmoji } from '@draftroom/contracts'
import { useEffect, useId, useRef, useState } from 'react'
import type { FeatureContext } from '../types.ts'
import { HandIcon } from './Hands.tsx'
import { usePresenting } from './presenting.ts'
import { addBurst, BURST_MS, type Burst, placeBurst } from './reactions.ts'
import { readSessionSettings } from './session-settings.ts'
import type { WorkshopSnapshot, WorkshopStore } from './store.ts'

function SmileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="9" cy="10" r="1.2" fill="currentColor" />
      <circle cx="15" cy="10" r="1.2" fill="currentColor" />
    </svg>
  )
}

const HINT_MS = 1_800

/** The top-bar reactions button and its bar (six reactions + raise hand). */
export function ReactionControl({
  ctx,
  store,
  snap,
}: {
  ctx: FeatureContext
  store: WorkshopStore
  snap: WorkshopSnapshot
}) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const busy = useRef(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const barId = useId()
  const active = ctx.board.status === 'active'
  const raised = !!snap.myHand

  // Close on an outside press, and on Escape wherever the focus is inside the bar or dropped to the
  // page (a control can re-render under the keyboard); another dialog's Escape is left alone.
  useEffect(() => {
    if (!open) return
    bar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const inside = wrap.current?.contains(document.activeElement)
      if (!inside && document.activeElement !== document.body) return
      e.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(null), HINT_MS)
    return () => clearTimeout(t)
  }, [hint])

  const react = async (emoji: ReactionEmoji) => {
    const r = await store.react(emoji, ctx.me.user.name)
    if (r.ok) return
    if (r.code === 'RATE_LIMITED') setHint('Easy there: at most 5 reactions a second.')
    else
      ctx.notify({
        key: 'reaction',
        text: r.error ?? 'Your reaction was not sent.',
        testId: 'reaction-toast',
      })
  }

  // Not disabled while the request runs (that would drop the keyboard focus); a second press waits.
  const toggleHand = async () => {
    if (busy.current) return
    busy.current = true
    const r = await store.setHand(!raised)
    busy.current = false
    if (!r.ok)
      ctx.notify({
        key: 'hand',
        text: r.error ?? 'That did not work.',
        tone: 'error',
        testId: 'hand-error-toast',
      })
  }

  const label = raised ? 'Reactions. Your hand is raised' : 'Reactions and raise hand'
  return (
    <div className="dr-wk-react" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="dr-wk-iconbtn"
        data-testid="reactions-button"
        data-hand={raised ? 'up' : 'down'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? barId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {raised ? <HandIcon /> : <SmileIcon />}
      </button>
      {open && (
        <div
          id={barId}
          ref={bar}
          role="dialog"
          aria-label="Reactions"
          className="dr-wk-reactbar"
          data-testid="reaction-bar"
          onKeyDown={(e) => {
            e.stopPropagation() // no board shortcuts from inside the bar (Escape is handled above)
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              const items = [
                ...(bar.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
              ]
              const at = items.indexOf(document.activeElement as HTMLButtonElement)
              const next = items[(at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]
              next?.focus()
              e.preventDefault()
            }
          }}
        >
          <div className="dr-wk-reactbar__row">
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="dr-wk-reactbar__emoji"
                data-testid="reaction-option"
                data-emoji={emoji}
                aria-label={REACTION_LABELS[emoji]}
                title={REACTION_LABELS[emoji]}
                disabled={!active}
                onClick={() => void react(emoji)}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
            <span className="dr-wk-reactbar__sep" aria-hidden="true" />
            <button
              type="button"
              className="dr-wk-reactbar__hand"
              data-testid="hand-toggle"
              aria-pressed={raised}
              disabled={!active && !raised}
              onClick={() => void toggleHand()}
            >
              <HandIcon size={16} />
              {raised ? 'Lower hand' : 'Raise hand'}
            </button>
          </div>
          <p className="dr-wk-reactbar__hint" aria-live="polite" data-testid="reaction-hint">
            {hint ??
              (active
                ? 'Everyone on the board sees reactions for a moment. Nothing is saved.'
                : 'Reactions and raised hands are off while the board is archived.')}
          </p>
        </div>
      )}
    </div>
  )
}

// ---- bursts ---------------------------------------------------------------------------------------------

const bare = (id: string) => (id.startsWith('user:') ? id.slice('user:'.length) : id)

/** The sender's cursor on this page, in viewport coordinates (their most recently active tab). */
function cursorOf(ctx: FeatureContext, userId: string): { x: number; y: number } | null {
  const { editor } = ctx
  let best: { x: number; y: number; t: number } | null = null
  for (const c of editor.getCollaboratorsOnCurrentPage()) {
    if (bare(c.userId) !== userId || !c.cursor) continue
    const t = c.lastActivityTimestamp ?? 0
    if (!best || t > best.t) best = { x: c.cursor.x, y: c.cursor.y, t }
  }
  if (!best) return null
  const p = editor.pageToViewport({ x: best.x, y: best.y })
  return { x: p.x, y: p.y }
}

/** The reactions button's centre, relative to the canvas container (null when it is not on screen). */
function laneX(ctx: FeatureContext): number | null {
  const btn = document.querySelector<HTMLElement>('[data-testid="reactions-button"]')
  const container = ctx.editor.getContainer()
  if (!btn || !container) return null
  const b = btn.getBoundingClientRect()
  if (b.width === 0) return null
  return b.left + b.width / 2 - container.getBoundingClientRect().left
}

let burstIds = 0

/** Every reaction on the board, as a short burst (above the presentation too). */
export function ReactionBursts({ ctx, store }: { ctx: FeatureContext; store: WorkshopStore }) {
  const [bursts, setBursts] = useState<Burst[]>([])
  const presenting = usePresenting()
  const live = useRef({ ctx, presenting })
  live.current = { ctx, presenting }

  useEffect(
    () =>
      store.onReaction((r) => {
        const { ctx: c, presenting: p } = live.current
        const bounds = c.editor.getViewportScreenBounds()
        const placement = placeBurst({
          mine: r.mine,
          cursor: r.mine ? null : cursorOf(c, r.userId),
          viewport: { width: bounds.w, height: bounds.h },
          cursorsHidden: readSessionSettings(c.editor).hideCursors,
          presenting: p,
          laneX: laneX(c),
          jitter: Math.random(),
        })
        const burst: Burst = { ...r, id: ++burstIds, at: Date.now(), placement }
        setBursts((list) => addBurst(list, burst, burst.at))
      }),
    [store],
  )

  // Drop bursts as they finish (one timer for the oldest).
  useEffect(() => {
    const first = bursts[0]
    if (!first) return
    const t = setTimeout(
      () => setBursts((list) => list.filter((b) => Date.now() - b.at < BURST_MS)),
      Math.max(0, first.at + BURST_MS - Date.now()) + 20,
    )
    return () => clearTimeout(t)
  }, [bursts])

  if (bursts.length === 0) return null
  return (
    <div className="dr-wk-bursts" aria-hidden="true">
      {bursts.map((b) => (
        <div
          key={b.id}
          className="dr-wk-burst"
          data-testid="reaction-burst"
          data-emoji={b.emoji}
          data-user-id={b.userId}
          data-mine={b.mine ? 'true' : 'false'}
          data-placement={b.placement.kind}
          style={{ left: b.placement.x, top: b.placement.y }}
        >
          <span className="dr-wk-burst__emoji">{b.emoji}</span>
          {b.placement.kind === 'top' && !b.mine && <span className="dr-wk-burst__name">{b.name}</span>}
        </div>
      ))}
    </div>
  )
}
