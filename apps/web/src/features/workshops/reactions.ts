// Reactions (FAC-08), client side: where a reaction's burst is shown and how many run at once. Pure,
// so it is unit-tested in Node; the component (ReactionBursts in Reactions.tsx) only renders it.
//
// A burst goes near the sender's cursor when this person can see that cursor (on this page, inside
// the view, cursors not hidden by the facilitator, not presenting); otherwise, and for this person's
// own reactions, it goes into a lane below the top bar, near the reactions button, with the sender's
// name. tldraw tracks the pointer over the whole page, so someone who clicks the reactions button has
// their cursor up at the top bar: mouse reactions mostly land in the lane, keyboard reactions made
// with the pointer resting on the canvas at the cursor. Nothing is stored: a burst lives for
// BURST_MS and is gone.

import { REACTION_RATE_MAX, REACTION_RATE_WINDOW_MS, type ReactionEmoji } from '@draftroom/contracts'

export const BURST_MS = 2_000
/** At most this many bursts on screen; older ones make room. */
export const MAX_BURSTS = 24
/** A cursor this close to the edge of the view counts as outside it (the burst would be cut off). */
const EDGE_PX = 24
/**
 * A burst at a cursor starts just above the pointer's tip (tldraw draws the arrow and the name label
 * below and to the right of it), then drifts up.
 */
export const CURSOR_BURST_OFFSET = { x: 4, y: -20 } as const
/**
 * A cursor this close to the top of the view is usually a pointer on its way to or from the top bar
 * (and a burst there would be cut off as it drifts up): such reactions use the lane.
 */
const TOP_EDGE_PX = 48

export interface Point {
  x: number
  y: number
}

export type BurstPlacement = { kind: 'cursor'; x: number; y: number } | { kind: 'top'; x: number; y: number }

export interface PlacementInput {
  mine: boolean
  /** The sender's cursor in viewport coordinates, if their presence is on this page. */
  cursor: Point | null
  viewport: { width: number; height: number }
  cursorsHidden: boolean
  presenting: boolean
  /** Horizontal centre of the lane (the reactions button's x in the viewport), if known. */
  laneX: number | null
  /** 0..1, spreads bursts in the lane so a flurry does not stack on one spot. */
  jitter: number
}

export function placeBurst(p: PlacementInput): BurstPlacement {
  const { width, height } = p.viewport
  const c = p.cursor
  if (
    !p.mine &&
    c &&
    !p.cursorsHidden &&
    !p.presenting &&
    c.x >= EDGE_PX &&
    c.y >= TOP_EDGE_PX &&
    c.x <= width - EDGE_PX &&
    c.y <= height - EDGE_PX
  )
    return {
      kind: 'cursor',
      x: Math.round(c.x + CURSOR_BURST_OFFSET.x),
      y: Math.round(c.y + CURSOR_BURST_OFFSET.y),
    }
  const center = p.laneX ?? width - 120
  const spread = 72
  const x = Math.round(Math.min(width - 28, Math.max(28, center + (p.jitter - 0.5) * spread)))
  return { kind: 'top', x, y: 18 }
}

/** K3-5: one copy of a reaction's emoji in its burst. */
export interface BurstCopy {
  /** sideways offset, px (the first copy, the reaction itself, is at 0) */
  dx: number
  /** how far it rises as it fades, px */
  rise: number
  /** when it starts, ms after the burst */
  delayMs: number
  scale: number
  /** a slight tilt, degrees */
  turn: number
}

/** K3-5: how many copies a burst has (the reaction and the ones that spring from it). */
export const BURST_COPIES = 5

/**
 * K3-5: a reaction was one emoji; now it bursts: BURST_COPIES copies, staggered in time and spread sideways
 * (`jitter`, 0..1, varies the spread), the first one the reaction itself. People who prefer reduced motion
 * get one copy that does not move (it only fades, workshops.css).
 */
export function burstCopies(reduced: boolean, jitter = 0.5): BurstCopy[] {
  if (reduced) return [{ dx: 0, rise: 0, delayMs: 0, scale: 1, turn: 0 }]
  const lean = (jitter - 0.5) * 8
  const out: BurstCopy[] = [{ dx: 0, rise: 0, delayMs: 0, scale: 1, turn: 0 }]
  for (let i = 1; i < BURST_COPIES; i++) {
    const side = i % 2 === 1 ? -1 : 1
    const step = Math.ceil(i / 2)
    out.push({
      dx: Math.round(side * (14 + step * 12) + lean),
      rise: -(28 + step * 14 + ((i * 7) % 9)),
      delayMs: i * 110,
      scale: Math.round((0.7 + ((i * 13) % 4) * 0.08) * 100) / 100,
      turn: side * (8 + step * 6),
    })
  }
  return out
}

export interface Burst {
  id: number
  userId: string
  name: string
  emoji: ReactionEmoji
  mine: boolean
  at: number
  placement: BurstPlacement
  /** K3-5: 0..1, how this burst's copies spread (burstCopies) */
  spread?: number
}

/** Adds a burst, dropping expired ones and the oldest beyond MAX_BURSTS. */
export function addBurst(list: readonly Burst[], burst: Burst, nowMs: number): Burst[] {
  const live = list.filter((b) => nowMs - b.at < BURST_MS)
  live.push(burst)
  return live.length > MAX_BURSTS ? live.slice(live.length - MAX_BURSTS) : live
}

/**
 * The server's limit, applied before sending (REACTION_RATE_MAX per REACTION_RATE_WINDOW_MS): a
 * flurry of clicks never becomes a flurry of 429s. The server still decides.
 */
export class ReactionThrottle {
  private sent: number[] = []
  private readonly max: number
  private readonly windowMs: number

  constructor(max = REACTION_RATE_MAX, windowMs = REACTION_RATE_WINDOW_MS) {
    this.max = max
    this.windowMs = windowMs
  }

  tryTake(nowMs: number): boolean {
    this.sent = this.sent.filter((t) => nowMs - t < this.windowMs)
    if (this.sent.length >= this.max) return false
    this.sent.push(nowMs)
    return true
  }
}
