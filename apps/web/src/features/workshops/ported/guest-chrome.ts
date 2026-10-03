// DANA-11 / F14 / PRI-18: what workshop chrome a name-only guest sees. A client or reviewer who joined
// through a link has no use for a "Timer" button, a Voting tab and a Private notes tab while nothing is
// going on, so for a guest they appear when a session is running (and go when it ends). People with an
// account keep them always: they are the ones who start a session. UI only: the api decides who may do
// what. Pure rules (this file) so they are tested without a browser; ./index.tsx and ./WorkshopBar.tsx
// apply them.
import type { WorkshopTimer } from '@draftroom/contracts'
import { timerDisplayPhase } from '../countdown.ts'

/** What is going on in the workshop right now, as far as this tab knows. */
export interface WorkshopActivity {
  /** a timer that is running, paused or showing "Time's up" */
  timer: boolean
  /** a vote is open, or its results are still to be seen */
  vote: boolean
  /** a private brainstorm is open or revealing */
  brainstorm: boolean
  /** someone's hand is up */
  hands: boolean
  /** a facilitator switched on "Hide note authors" or "Hide everyone's cursors" (the popover explains it) */
  settings: boolean
}

export function workshopActivity(input: {
  timer: WorkshopTimer | null
  vote: boolean
  brainstorm: boolean
  hands: number
  settings: { hideNoteAuthors: boolean; hideCursors: boolean }
  now: number
  offsetMs: number
}): WorkshopActivity {
  const phase = timerDisplayPhase(input.timer, input.now, input.offsetMs)
  return {
    timer: phase === 'running' || phase === 'paused' || phase === 'finished',
    vote: input.vote,
    brainstorm: input.brainstorm,
    hands: input.hands > 0,
    settings: input.settings.hideNoteAuthors || input.settings.hideCursors,
  }
}

const anything = (a: WorkshopActivity) => a.timer || a.vote || a.brainstorm || a.hands || a.settings

/** The top bar's Timer and workshop tools button. */
export const showTimerButton = (guest: boolean, a: WorkshopActivity) => !guest || anything(a)
/** The Voting dock tab. */
export const showVotingTab = (guest: boolean, a: WorkshopActivity) => !guest || a.vote
/** The Private notes dock tab. */
export const showPrivateNotesTab = (guest: boolean, a: WorkshopActivity) => !guest || a.brainstorm
