import type { WorkshopTimer } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
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
