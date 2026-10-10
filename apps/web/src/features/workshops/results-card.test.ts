// Wave M (W2, M2-4): the "Results are in" card's dismissal state machine (./results-card.ts), pure. The store's side of
// it (a real vote revealed in front of a tab, the panel opening, Results to board) is in store.test.ts.
import { describe, expect, it } from 'vitest'
import { nextResultsNews, type ResultsCardEvent, type ResultsNews, resultsCardShown } from './results-card.ts'

const A: ResultsNews = { sessionId: 'vot_aaaaaaaaaaaaaaaaaaaa', seq: 1 }
const run = (start: ResultsNews | null, ...events: ResultsCardEvent[]) =>
  events.reduce<ResultsNews | null>((n, e) => nextResultsNews(n, e), start)

describe('the results card: what ends it', () => {
  it('results coming in make the card for that vote', () => {
    expect(run(null, { kind: 'results', sessionId: A.sessionId, seq: 1 })).toEqual(A)
  })

  it('opening the Voting panel ends it; any other panel does not', () => {
    expect(run(A, { kind: 'panel', panel: 'tags' })).toBe(A)
    expect(run(A, { kind: 'panel', panel: null })).toBe(A)
    expect(run(A, { kind: 'panel', panel: 'voting' })).toBeNull()
  })

  it('Results to board, See all results, the close button and the timeout each end it', () => {
    for (const kind of ['to-board', 'see-all', 'close', 'timeout'] as const)
      expect(run(A, { kind }), kind).toBeNull()
  })

  it('it does not come back: the panel closing, or the same vote being told again, makes no card', () => {
    expect(run(A, { kind: 'panel', panel: 'voting' }, { kind: 'panel', panel: null })).toBeNull()
    expect(run(A, { kind: 'to-board' }, { kind: 'vote', sessionId: A.sessionId })).toBeNull()
  })

  it('another vote starting ends the card of the old one; the same vote keeps it', () => {
    expect(run(A, { kind: 'vote', sessionId: A.sessionId })).toBe(A)
    expect(run(A, { kind: 'vote', sessionId: 'vot_bbbbbbbbbbbbbbbbbbbb' })).toBeNull()
    expect(run(A, { kind: 'vote', sessionId: null })).toBeNull()
  })

  it('only a newer reveal makes a new card, with a newer seq', () => {
    const b = run(A, { kind: 'close' }, { kind: 'results', sessionId: 'vot_bbbbbbbbbbbbbbbbbbbb', seq: 2 })
    expect(b).toEqual({ sessionId: 'vot_bbbbbbbbbbbbbbbbbbbb', seq: 2 })
  })

  it('nothing to end changes nothing (the same object, so a store does not render again)', () => {
    for (const e of [
      { kind: 'to-board' },
      { kind: 'see-all' },
      { kind: 'close' },
      { kind: 'timeout' },
      { kind: 'panel', panel: 'voting' },
      { kind: 'panel', panel: null },
      { kind: 'vote', sessionId: null },
    ] as const)
      expect(nextResultsNews(null, e), e.kind).toBeNull()
  })
})

describe('the results card: when it is drawn', () => {
  const base = { news: A, revealedWithResults: true, presenting: false, panel: null as string | null }
  it('news, a revealed vote with results, not presenting, the Voting panel not open', () => {
    expect(resultsCardShown(base)).toBe(true)
    expect(resultsCardShown({ ...base, panel: 'tags' })).toBe(true)
  })
  it('not without news, without results, while presenting, or with the Voting panel open', () => {
    expect(resultsCardShown({ ...base, news: null })).toBe(false)
    expect(resultsCardShown({ ...base, revealedWithResults: false })).toBe(false)
    expect(resultsCardShown({ ...base, presenting: true })).toBe(false)
    expect(resultsCardShown({ ...base, panel: 'voting' })).toBe(false)
  })
})
