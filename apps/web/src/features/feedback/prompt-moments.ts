// Wave M (W2, M2-5): the facilitated moments the feedback prompt may follow, as the board's features note them (a
// presentation stopped by its presenter, a vote revealed or put on the board by its starter, the run of show's last
// section over). One pending moment per board page (keyed by its LobbyCanvas); the latest wins. The prompt's layer
// (./FeedbackPrompt.tsx) decides whether to ask (./prompt.ts) and takes it. Nothing here is stored or sent.

import type { FeedbackPromptMoment } from '@draftroom/contracts'

export interface PendingMoment {
  readonly moment: FeedbackPromptMoment
  /** when it was noted (ms since the epoch) */
  readonly at: number
}

class Moments {
  private pending: PendingMoment | null = null
  private readonly listeners = new Set<() => void>()
  readonly get = (): PendingMoment | null => this.pending
  readonly subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  note(moment: FeedbackPromptMoment, at: number) {
    this.pending = { moment, at }
    for (const l of [...this.listeners]) l()
  }
  clear() {
    if (!this.pending) return
    this.pending = null
    for (const l of [...this.listeners]) l()
  }
}

const buses = new WeakMap<object, Moments>()

/** The moments of the board page whose canvas is `key`. */
export function momentsFor(key: object): Moments {
  let m = buses.get(key)
  if (!m) {
    m = new Moments()
    buses.set(key, m)
  }
  return m
}

/** A facilitated moment just ended on the board of `key` (the caller has checked it was this person's: `ownsMoment`). */
export function noteFeedbackMoment(key: object, moment: FeedbackPromptMoment, at: number = Date.now()): void {
  momentsFor(key).note(moment, at)
}
