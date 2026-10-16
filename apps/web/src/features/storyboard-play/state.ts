// OWNER: WS3 (wave T). Which storyboard the animatic player shows on a canvas (one player per canvas), and the opener
// the focus goes back to when it closes.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

export interface PlayerRequest {
  /** the storyboard (its head's element id) */
  readonly id: string
  readonly seq: number
  /** the element that had the focus when it opened */
  readonly opener: HTMLElement | null
}

const players = new WeakMap<LobbyCanvas, Atom<PlayerRequest | null>>()
let seq = 0

export function playerOf(canvas: LobbyCanvas): Atom<PlayerRequest | null> {
  let a = players.get(canvas)
  if (!a) {
    a = atom<PlayerRequest | null>('lobby-animatic-player', null)
    players.set(canvas, a)
  }
  return a
}

export function openPlayer(canvas: LobbyCanvas, id: string): void {
  const active = typeof document === 'undefined' ? null : document.activeElement
  playerOf(canvas).set({ id, seq: ++seq, opener: active instanceof HTMLElement ? active : null })
}

export function closePlayer(canvas: LobbyCanvas): void {
  playerOf(canvas).set(null)
}

export const isPlayerOpen = (canvas: LobbyCanvas): boolean => playerOf(canvas).get() !== null
