// L8-2: the optional "Show scores" overlay's state. The scores of the last "Place with AI" on this canvas,
// kept in this tab's memory only: never written to the board, never sent to anyone, gone when the tab is.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

export interface ShownScore {
  readonly x: number
  readonly y: number
}

export interface ScoresState {
  /** note id → its two scores, as the last placement gave them */
  readonly scores: ReadonlyMap<string, ShownScore>
  /** the axes' names, to read the chips by */
  readonly axes: readonly [string, string]
  /** the overlay is on */
  readonly shown: boolean
}

const states = new WeakMap<LobbyCanvas, Atom<ScoresState | null>>()

/** The scores of this canvas' last placement, or null. */
export function scoresOf(canvas: LobbyCanvas): Atom<ScoresState | null> {
  let a = states.get(canvas)
  if (!a) {
    a = atom<ScoresState | null>('lobby-sort-scores', null)
    states.set(canvas, a)
  }
  return a
}

export function rememberScores(
  canvas: LobbyCanvas,
  scores: ReadonlyMap<string, ShownScore>,
  axes: readonly [string, string],
): void {
  scoresOf(canvas).set({ scores, axes, shown: false })
}

export function showScores(canvas: LobbyCanvas, shown: boolean): void {
  const a = scoresOf(canvas)
  const cur = a.get()
  if (cur) a.set({ ...cur, shown })
}

export function clearScores(canvas: LobbyCanvas): void {
  scoresOf(canvas).set(null)
}
