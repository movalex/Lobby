import type { WorkshopTimer } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  facilitateEntries,
  facilitatePill,
  pillText,
  showPrivateNotesTab,
  showTimerButton,
  showVotingTab,
  type WorkshopActivity,
  workshopActivity,
} from './guest-chrome.ts'

const NOW = Date.parse('2026-10-03T10:00:00Z')
const timer = (over: Partial<WorkshopTimer>): WorkshopTimer =>
  ({
    status: 'running',
    durationMs: 300_000,
    remainingMs: 120_000,
    endsAt: new Date(NOW + 120_000).toISOString(),
    startedBy: 'u',
    ...over,
  }) as WorkshopTimer
const quiet = {
  vote: false,
  brainstorm: false,
  hands: 0,
  settings: { hideNoteAuthors: false, hideCursors: false },
}
const activity = (over: Partial<Parameters<typeof workshopActivity>[0]> = {}): WorkshopActivity =>
  workshopActivity({ timer: null, ...quiet, now: NOW, offsetMs: 0, ...over })

describe('what workshop chrome a guest sees (DANA-11 / F14 / PRI-18)', () => {
  it('shows nothing to a guest while no session is running', () => {
    const a = activity()
    expect(showTimerButton(true, a)).toBe(false)
    expect(showVotingTab(true, a)).toBe(false)
    expect(showPrivateNotesTab(true, a)).toBe(false)
  })

  it('people with an account always see it: they are the ones who start a session', () => {
    const a = activity()
    expect(showTimerButton(false, a)).toBe(true)
    expect(showVotingTab(false, a)).toBe(true)
    expect(showPrivateNotesTab(false, a)).toBe(true)
  })

  it('a running, paused or just-finished timer brings the timer button, and only that', () => {
    for (const t of [
      timer({}),
      timer({ status: 'paused', endsAt: null }),
      timer({ status: 'finished', remainingMs: 0, endsAt: new Date(NOW - 2_000).toISOString() }),
    ]) {
      const a = activity({ timer: t })
      expect(showTimerButton(true, a), t.status).toBe(true)
      expect(showVotingTab(true, a)).toBe(false)
      expect(showPrivateNotesTab(true, a)).toBe(false)
    }
  })

  it('a stopped timer, and one whose "Time\'s up" alert is over, are not a session', () => {
    expect(showTimerButton(true, activity({ timer: timer({ status: 'stopped', endsAt: null }) }))).toBe(false)
    const over = timer({ status: 'finished', remainingMs: 0, endsAt: new Date(NOW - 60_000).toISOString() })
    expect(showTimerButton(true, activity({ timer: over }))).toBe(false)
  })

  it('a vote brings the Voting tab (and the tools, which hold its entry); a brainstorm the Private notes tab', () => {
    const vote = activity({ vote: true })
    expect(showVotingTab(true, vote)).toBe(true)
    expect(showTimerButton(true, vote)).toBe(true)
    expect(showPrivateNotesTab(true, vote)).toBe(false)
    const brainstorm = activity({ brainstorm: true })
    expect(showPrivateNotesTab(true, brainstorm)).toBe(true)
    expect(showVotingTab(true, brainstorm)).toBe(false)
  })

  it('a raised hand or a hidden-authors setting keeps the tools, which explain them', () => {
    expect(showTimerButton(true, activity({ hands: 2 }))).toBe(true)
    expect(showTimerButton(true, activity({ settings: { hideNoteAuthors: true, hideCursors: false } }))).toBe(
      true,
    )
    expect(showTimerButton(true, activity({ settings: { hideNoteAuthors: false, hideCursors: true } }))).toBe(
      true,
    )
  })
})

describe('K3-3: the Facilitate menu shows each person what the bar showed them before', () => {
  const entries = (
    guest: boolean,
    facilitator: boolean,
    over: Partial<Parameters<typeof workshopActivity>[0]> = {},
  ) => facilitateEntries({ guest, facilitator, activity: activity(over), vote: !!over.vote })

  it('a facilitator: Timer, Reactions and hands, and Voting (to start one), always', () => {
    expect(entries(false, true)).toEqual(['timer', 'reactions', 'voting'])
  })

  it('a viewer or commenter with an account: the timer and the reactions; voting while a vote exists', () => {
    expect(entries(false, false)).toEqual(['timer', 'reactions'])
    expect(entries(false, false, { vote: true })).toEqual(['timer', 'reactions', 'voting'])
  })

  it('a name-only guest while nothing runs: only the reactions (the bar showed them the reactions button)', () => {
    expect(entries(true, false)).toEqual(['reactions'])
  })

  it('a guest while a session runs: the timer, and what runs', () => {
    expect(entries(true, false, { timer: timer({}) })).toEqual(['timer', 'reactions'])
    expect(entries(true, false, { vote: true })).toEqual(['timer', 'reactions', 'voting'])
    expect(entries(true, false, { brainstorm: true })).toEqual(['timer', 'reactions', 'brainstorm'])
    expect(entries(true, false, { hands: 1 })).toEqual(['timer', 'reactions', 'hands'])
  })

  it('everyone sees the raised hands and the brainstorm while there is one, in this order', () => {
    expect(entries(false, true, { hands: 2, vote: true, brainstorm: true })).toEqual([
      'timer',
      'reactions',
      'hands',
      'voting',
      'brainstorm',
    ])
  })
})

describe('K3-3: the Facilitate pill shows only what is live', () => {
  const pill = (over: Partial<Parameters<typeof facilitatePill>[0]> = {}) =>
    pillText(
      facilitatePill({
        timer: 'idle',
        clock: '0:00',
        voteOpen: false,
        brainstormOpen: false,
        hands: 0,
        ...over,
      }),
    )

  it('nothing while idle (a stopped or long-finished timer is not live)', () => {
    expect(pill()).toBe('')
    expect(pill({ timer: 'stopped', clock: '5:00' })).toBe('')
    expect(pill({ timer: 'ended' })).toBe('')
  })

  it('"4:58 · Vote" while a timer runs and a vote is open', () => {
    expect(pill({ timer: 'running', clock: '4:58', voteOpen: true })).toBe('4:58 · Vote')
  })

  it('the timer alone, paused, or at zero (0:00 in red, the flash says "Time\'s up")', () => {
    expect(pill({ timer: 'running', clock: '1:05' })).toBe('1:05')
    expect(pill({ timer: 'paused', clock: '3:00' })).toBe('3:00')
    const finished = facilitatePill({
      timer: 'finished',
      clock: '0:00',
      voteOpen: false,
      brainstormOpen: false,
      hands: 0,
    })
    expect(finished).toEqual([{ kind: 'timer', text: '0:00', state: 'finished' }])
  })

  it('a brainstorm and raised hands too, in a fixed order', () => {
    expect(pill({ timer: 'running', clock: '2:00', voteOpen: true, brainstormOpen: true, hands: 2 })).toBe(
      '2:00 · Vote · Brainstorm · ✋ 2',
    )
    expect(pill({ hands: 1 })).toBe('✋ 1')
  })
})
