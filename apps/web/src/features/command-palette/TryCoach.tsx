// OWNER: W3 (wave M, M3-3). The coach mark a "Try it" from the What's new card leaves on the board it opens
// (./try-hints.ts): a small note under the thing it is about (the palette button, the Facilitate button), with "Got it".
// It goes with "Got it", Escape, a press on the thing it points at, or after BUBBLE_MS. One at a time, and never stored:
// the hint's parameter is already out of the address bar, so a reload shows nothing. When the thing is a line of the
// palette (Ask this board…), the palette itself marks that line (./Palette.tsx `coach`) and this note is not used.
import { useEffect, useLayoutEffect, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'

export interface CoachBubble {
  readonly key: number
  readonly text: string
  /** `data-testid`s of the elements it points at: the first that is on the page and shown */
  readonly anchors: readonly string[]
}

export const BUBBLE_MS = 20_000

const states = new WeakMap<LobbyCanvas, Atom<CoachBubble | null>>()
let shown = 0

/** The bubble of one board page (null: none). */
export function coachBubble(canvas: LobbyCanvas): Atom<CoachBubble | null> {
  let a = states.get(canvas)
  if (!a) {
    a = atom<CoachBubble | null>('command-palette.coach', null)
    states.set(canvas, a)
  }
  return a
}

/** Shows a bubble (a new one replaces the one before). */
export function showCoachBubble(canvas: LobbyCanvas, text: string, anchors: readonly string[]): void {
  coachBubble(canvas).set({ key: ++shown, text, anchors })
}

const WIDTH = 300
const MARGIN = 8

function anchorOf(testIds: readonly string[]): HTMLElement | null {
  for (const id of testIds) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="${CSS.escape(id)}"]`)) {
      if (el.getClientRects().length > 0 && !el.closest('[hidden], [inert]')) return el
    }
  }
  return null
}

/** Where the bubble goes: under its anchor, kept on the screen; at the top middle when there is no anchor. */
export function placeBubble(
  anchor: { left: number; right: number; bottom: number } | null,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const width = Math.min(WIDTH, viewport.width - 2 * MARGIN)
  if (!anchor) return { top: 64, left: Math.max(MARGIN, (viewport.width - width) / 2) }
  const centre = (anchor.left + anchor.right) / 2
  const left = Math.min(Math.max(MARGIN, centre - width / 2), viewport.width - width - MARGIN)
  return { top: Math.min(anchor.bottom + MARGIN, viewport.height - 96), left }
}

function Bubble({ bubble, canvas }: { bubble: CoachBubble; canvas: LobbyCanvas }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const el = anchorOf(bubble.anchors)
      const r = el?.getBoundingClientRect()
      setAt(placeBubble(r ?? null, { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [bubble])

  useEffect(() => {
    const close = () => coachBubble(canvas).set(null)
    const timer = setTimeout(close, BUBBLE_MS)
    // Escape and a press on the thing it points at are the person getting on with it
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDown = (e: PointerEvent) => {
      const el = anchorOf(bubble.anchors)
      if (el?.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [bubble, canvas])

  if (!at) return null
  return (
    <div
      className="dr-try-coach"
      data-testid="try-coach"
      role="status"
      style={{ top: at.top, left: at.left, width: Math.min(WIDTH, window.innerWidth - 2 * MARGIN) }}
    >
      <p className="dr-try-coach__text">{bubble.text}</p>
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid="try-coach-ok"
        onClick={() => coachBubble(canvas).set(null)}
      >
        Got it
      </button>
    </div>
  )
}

/** The screen-layer overlay. */
export function TryCoach({ ctx }: { ctx: CanvasFeatureContext }) {
  const bubble = useValue('command-palette.coach.state', () => coachBubble(ctx.canvas).get(), [ctx.canvas])
  if (!bubble) return null
  return <Bubble key={bubble.key} bubble={bubble} canvas={ctx.canvas} />
}
