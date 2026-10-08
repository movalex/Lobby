// OWNER: 3f. Reactions and raise hand (FAC-08) on the Excalidraw page (the tldraw board's Reactions.tsx):
// the Facilitate menu's "Reactions and raise hand" (K3-3) opens a small bar with the six reactions and the
// raise-hand toggle;
// every reaction on the board shows as a short burst near the sender's cursor (or below the top bar, see
// ../reactions.ts placeBurst) for everyone. Bursts only fade in and out for people who prefer reduced
// motion (workshops.css). Nothing is stored.
import { REACTION_EMOJIS, REACTION_LABELS, type ReactionEmoji } from '@draftroom/contracts'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useMediaQuery } from '../../../ui/useMedia.ts'
import { HandIcon } from '../Hands.tsx'
import { addBurst, BURST_MS, type Burst, burstCopies, placeBurst } from '../reactions.ts'
import type { WorkshopSnapshot, WorkshopStore } from '../store.ts'
import { isPresentingHere, usePresentingHere } from './presenting.ts'
import { workshopSettingsOf } from './session-settings.ts'

type Ctx = CanvasFeatureContext

export function SmileIcon() {
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

/**
 * The reactions bar (six reactions + raise hand), opened from the Facilitate menu's "Reactions and raise
 * hand" entry (K3-3; it had its own top-bar button). The bar takes the keyboard when it opens; Escape, an
 * outside press and Tab past it close it (./WorkshopBar.tsx, which owns what is open).
 */
export function ReactionBar({
  ctx,
  store,
  snap,
  id,
}: {
  ctx: Ctx
  store: WorkshopStore
  snap: WorkshopSnapshot
  id: string
}) {
  const [hint, setHint] = useState<string | null>(null)
  const busy = useRef(false)
  const bar = useRef<HTMLDivElement>(null)
  const active = ctx.board.status === 'active'
  const raised = !!snap.myHand

  useEffect(() => {
    bar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [])

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

  return (
    <div
      id={id}
      ref={bar}
      role="dialog"
      aria-label="Reactions"
      className="dr-wk-reactbar"
      data-testid="reaction-bar"
      onKeyDown={(e) => {
        if (e.key === 'Escape') return // ./WorkshopBar.tsx closes it and gives the keyboard back
        e.stopPropagation() // no board shortcuts from inside the bar
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const items = [...(bar.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
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
  )
}

// ---- bursts ---------------------------------------------------------------------------------------------

/**
 * The sender's cursor on this page, in overlay coordinates (a tab of theirs that is not idle first), or
 * null when no cursor of theirs is over the canvas here.
 */
function cursorOf(ctx: Ctx, userId: string): { x: number; y: number } | null {
  const { canvas } = ctx
  let best: { x: number; y: number; idle: boolean } | null = null
  for (const p of canvas.presence.peers()) {
    if (p.uid !== userId || !p.point) continue
    if (!best || (best.idle && !p.idle)) best = { x: p.point.x, y: p.point.y, idle: p.idle }
  }
  if (!best) return null
  const at = canvas.sceneToOverlay({ x: best.x, y: best.y })
  return { x: at.x, y: at.y }
}

/** The Facilitate button's centre (the reactions live in its menu), relative to the canvas region (null when it is not on screen). */
function laneX(ctx: Ctx): number | null {
  const btn = document.querySelector<HTMLElement>('[data-testid="facilitate-button"]')
  const container = ctx.canvas.container()
  if (!btn || !container) return null
  const b = btn.getBoundingClientRect()
  if (b.width === 0) return null
  return b.left + b.width / 2 - container.getBoundingClientRect().left
}

/** The canvas region's size on screen. */
function viewSize(ctx: Ctx): { width: number; height: number } {
  try {
    const r = ctx.canvas.viewport.screenRect()
    if (r.width > 0) return { width: r.width, height: r.height }
  } catch {
    // no board handles
  }
  const r = ctx.canvas.container()?.getBoundingClientRect()
  return { width: r?.width ?? 0, height: r?.height ?? 0 }
}

let burstIds = 0

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * K3-5: a reaction's face: BURST_COPIES copies of the emoji springing from it, staggered (../reactions.ts
 * burstCopies), or the one emoji, still, for people who prefer reduced motion.
 */
export function BurstFace({
  emoji,
  reduced,
  spread = 0.5,
}: {
  emoji: string
  reduced: boolean
  spread?: number
}) {
  const copies = burstCopies(reduced, spread)
  return (
    <span className="dr-wk-burst__copies" data-copies={copies.length}>
      {copies.map((c, i) => (
        <span
          // the copies of one burst never change: their index is their identity
          key={i}
          className="dr-wk-burst__emoji"
          data-copy={i === 0 ? 'main' : 'spark'}
          style={
            i === 0
              ? undefined
              : ({
                  '--dx': `${c.dx}px`,
                  '--rise': `${c.rise}px`,
                  '--delay': `${c.delayMs}ms`,
                  '--scale': String(c.scale),
                  '--turn': `${c.turn}deg`,
                } as CSSProperties)
          }
        >
          {emoji}
        </span>
      ))}
    </span>
  )
}

/** Every reaction on the board, as a short burst (above the presentation too). */
export function ReactionBursts({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const [bursts, setBursts] = useState<Burst[]>([])
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY)
  const presenting = usePresentingHere(ctx.canvas)
  const live = useRef({ ctx, presenting })
  live.current = { ctx, presenting }

  useEffect(
    () =>
      store.onReaction((r) => {
        const { ctx: c, presenting: p } = live.current
        const placement = placeBurst({
          mine: r.mine,
          cursor: r.mine ? null : cursorOf(c, r.userId),
          viewport: viewSize(c),
          cursorsHidden: workshopSettingsOf(c.canvas).hideCursors,
          presenting: p || isPresentingHere(c.canvas),
          laneX: laneX(c),
          jitter: Math.random(),
        })
        const burst: Burst = { ...r, id: ++burstIds, at: Date.now(), placement, spread: Math.random() }
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
          <BurstFace emoji={b.emoji} reduced={reduced} spread={b.spread} />
          {b.placement.kind === 'top' && !b.mine && <span className="dr-wk-burst__name">{b.name}</span>}
        </div>
      ))}
    </div>
  )
}
