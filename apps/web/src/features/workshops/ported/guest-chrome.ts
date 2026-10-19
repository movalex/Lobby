// DANA-11 / F14 / PRI-18: what workshop chrome a name-only guest sees. A client or reviewer who joined
// through a link has no use for a "Timer" button, a Voting tab and a Private notes tab while nothing is
// going on, so for a guest they appear when a session is running (and go when it ends). People with an
// account keep them always: they are the ones who start a session. UI only: the api decides who may do
// what. Pure rules (this file) so they are tested without a browser; ./index.tsx and ./WorkshopBar.tsx
// apply them.
import type { WorkshopTimer } from '@draftroom/contracts'
import { type TimerDisplay, timerDisplayPhase } from '../countdown.ts'

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

/** The top bar's Timer and workshop tools button (since K3-3, the Facilitate menu's Timer entry). */
export const showTimerButton = (guest: boolean, a: WorkshopActivity) => !guest || anything(a)
/** The Voting dock tab. */
export const showVotingTab = (guest: boolean, a: WorkshopActivity) => !guest || a.vote
/** The Private notes dock tab. */
export const showPrivateNotesTab = (guest: boolean, a: WorkshopActivity) => !guest || a.brainstorm

// ---- K3-3: one Facilitate button ---------------------------------------------------------------------
//
// The top bar showed the timer pill, the voting chip, the brainstorm chip, the raised-hands chip and the
// reactions button side by side (UXD-01). They are one button now, whose menu holds the same entries with
// the same test ids, and whose pill shows only what is live ("4:58 · Vote"). Each entry shows to the
// people it showed to before, under the same rules: the timer by `showTimerButton`, the reactions to
// everyone, the hands queue and the brainstorm while there is one, voting to facilitators (who start
// votes) and to everyone else while a vote exists (open, or the last one with its results).

/** The Facilitate menu's entries, in order. */
export type FacilitateEntry = 'timer' | 'reactions' | 'hands' | 'voting' | 'brainstorm' | 'spotlight'

export function facilitateEntries(input: {
  guest: boolean
  facilitator: boolean
  activity: WorkshopActivity
  /** a vote exists on the board (open, ended or revealed: the last one) */
  vote: boolean
  /** L5-2: the entry for the spotlight (facilitators; nothing when left out, as before wave L) */
  spotlight?: boolean
}): FacilitateEntry[] {
  const out: FacilitateEntry[] = []
  if (showTimerButton(input.guest, input.activity)) out.push('timer')
  out.push('reactions')
  if (input.activity.hands) out.push('hands')
  if (input.facilitator || input.vote) out.push('voting')
  if (input.activity.brainstorm) out.push('brainstorm')
  if (input.spotlight) out.push('spotlight')
  return out
}

/** One live part of the Facilitate pill. */
export type PillPart =
  | { kind: 'timer'; text: string; state: 'running' | 'paused' | 'finished' }
  | { kind: 'vote'; text: 'Vote' }
  | { kind: 'brainstorm'; text: 'Brainstorm' }
  | { kind: 'hands'; text: string; count: number }
  /** wave V: a registered entry's live part (./facilitate-entries.ts setFacilitatePill), after the built-in ones */
  | { kind: 'extra'; id: string; text: string; spoken: string }

/**
 * What the Facilitate button's pill says: only what is live, in this order. Nothing when idle; "4:58 · Vote"
 * while a timer runs and a vote is open. `clock` is the timer as the pill shows it ("4:58").
 */
export function facilitatePill(input: {
  timer: TimerDisplay
  clock: string
  voteOpen: boolean
  brainstormOpen: boolean
  hands: number
  /** wave V: the registered entries' live parts, in their order (./facilitate-entries.ts); none when left out */
  extras?: readonly { id: string; text: string; spoken: string }[]
}): PillPart[] {
  const out: PillPart[] = []
  // a finished timer reads 0:00 in red for its alert (the canvas flash says "Time's up": RETRO-23a, one message)
  if (input.timer === 'running' || input.timer === 'paused' || input.timer === 'finished')
    out.push({ kind: 'timer', text: input.clock, state: input.timer })
  if (input.voteOpen) out.push({ kind: 'vote', text: 'Vote' })
  if (input.brainstormOpen) out.push({ kind: 'brainstorm', text: 'Brainstorm' })
  if (input.hands > 0) out.push({ kind: 'hands', text: `✋ ${input.hands}`, count: input.hands })
  for (const e of input.extras ?? []) if (e.text) out.push({ kind: 'extra', id: e.id, text: e.text, spoken: e.spoken })
  return out
}

/** The pill as one line ("4:58 · Vote"), '' when idle. */
export const pillText = (parts: readonly PillPart[]) => parts.map((p) => p.text).join(' · ')
