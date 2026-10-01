import { describe, expect, it } from 'vitest'
import { saveAnnouncement } from './SaveStatus.tsx'
import type { DisplayState } from './save-state.ts'

/** Runs a sequence of states through the announcer and collects what it would say. */
function spoken(states: DisplayState[], role?: string): string[] {
  const out: string[] = []
  let prev: DisplayState | null = null
  let trouble: DisplayState | null = null
  for (const s of states) {
    const a = saveAnnouncement(prev, s, trouble, role)
    prev = s
    trouble = a.trouble
    if (a.say) out.push(a.say)
  }
  return out
}

describe('A11Y-14: the save indicator speaks only problems and recoveries', () => {
  it('says nothing while editing normally (Saving… / Saved after every edit)', () => {
    expect(spoken(['connecting', 'saved', 'saving', 'saved', 'saving', 'saved', 'saving', 'saved'])).toEqual(
      [],
    )
    expect(spoken(['connecting', 'readonly'])).toEqual([])
    expect(spoken(['connecting', 'unsupported'])).toEqual([])
  })

  it('announces going offline, and coming back once everything is stored', () => {
    expect(spoken(['saved', 'offline', 'saved'])).toEqual(['Offline', 'Back online. All changes saved.'])
    expect(
      spoken(['saved', 'saving', 'offline-pending', 'connecting', 'saving', 'saved', 'saving', 'saved']),
    ).toEqual(['Offline — changes will sync', 'Back online. All changes saved.'])
    // Offline with nothing waiting, then an edit while offline: both are worth knowing.
    expect(spoken(['saved', 'offline', 'offline-pending'])).toEqual([
      'Offline',
      'Offline — changes will sync',
    ])
  })

  it('announces a refused change and the connection ending', () => {
    expect(spoken(['saved', 'saving', 'rejected', 'saving', 'saved'])).toEqual(['Change not saved', 'Saved.'])
    expect(spoken(['saved', 'error'])).toEqual(['Not saved — connection ended'])
    expect(spoken(['saved', 'error', 'connecting', 'saved'])).toEqual([
      'Not saved — connection ended',
      'Back online. All changes saved.',
    ])
  })

  it('a viewer back online hears it without a "saved" claim', () => {
    expect(spoken(['readonly', 'offline', 'readonly'])).toEqual(['Offline', 'Back online.'])
  })

  it('never repeats a problem that is still going on', () => {
    expect(spoken(['saved', 'offline', 'offline', 'offline'])).toEqual(['Offline'])
  })
})
