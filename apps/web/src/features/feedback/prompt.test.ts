// Wave M (W2, M2-5, S6): the end-of-moment feedback prompt's rules (./prompt.ts), pure: who a moment belongs to, the
// 7-day throttle (with storage that works, that throws, that holds garbage, and none), the guest rule, "never while
// words are being typed", and a stale moment.
import {
  FEEDBACK_PROMPT_MOMENTS,
  type FeedbackPromptMoment,
  feedbackPromptGoodText,
  feedbackPromptIssuePrefill,
} from '@draftroom/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { sendsOnlyPrefill } from './model.ts'
import {
  decideFeedbackPrompt,
  holdsTextLease,
  lastPromptAt,
  notePromptShown,
  ownsMoment,
  PROMPT_INTERVAL_MS,
  PROMPT_MOMENT_TTL_MS,
  type PromptStorage,
  promptDue,
  promptGoodContext,
  promptKey,
  resetPromptForTests,
} from './prompt.ts'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0)
const ME = 'usr_me0000000001'
const OTHER = 'usr_other00000001'

const memory = () => {
  const m = new Map<string, string>()
  const s: PromptStorage = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  }
  return { s, m }
}
const throwing: PromptStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

beforeEach(() => resetPromptForTests())

describe('the throttle: at most once per person per 7 days', () => {
  it('a person never asked is due; once asked, not for 7 days, then due again', () => {
    const { s } = memory()
    expect(promptDue(ME, T0, s)).toBe(true)
    notePromptShown(ME, T0, s)
    resetPromptForTests() // a reload: only the storage is left
    expect(PROMPT_INTERVAL_MS).toBe(7 * DAY)
    expect(promptDue(ME, T0 + 1, s)).toBe(false)
    expect(promptDue(ME, T0 + 6 * DAY + 23 * 3_600_000, s)).toBe(false)
    expect(promptDue(ME, T0 + 7 * DAY, s)).toBe(true)
    expect(promptDue(ME, T0 + 30 * DAY, s)).toBe(true)
  })

  it('is per person: another person on the same browser is asked on their own account', () => {
    const { s } = memory()
    notePromptShown(ME, T0, s)
    resetPromptForTests()
    expect(promptDue(ME, T0 + DAY, s)).toBe(false)
    expect(promptDue(OTHER, T0 + DAY, s)).toBe(true)
  })

  it('storage holds the time as the key says, and only that', () => {
    const { s, m } = memory()
    notePromptShown(ME, T0, s)
    expect([...m.keys()]).toEqual([promptKey(ME)])
    expect(lastPromptAt(ME, s)).toBe(T0)
  })

  it('in one tab a person is asked once, whatever the storage says (a second reveal the same day)', () => {
    const { s } = memory()
    expect(promptDue(ME, T0, s)).toBe(true)
    notePromptShown(ME, T0, s)
    expect(promptDue(ME, T0 + 60_000, s)).toBe(false)
  })

  it('storage that throws: no error, and at most once per tab session', () => {
    expect(promptDue(ME, T0, throwing)).toBe(true) // nothing known: asked once
    expect(() => notePromptShown(ME, T0, throwing)).not.toThrow()
    expect(promptDue(ME, T0 + 8 * DAY, throwing)).toBe(false) // this tab remembers, whatever the days
    expect(promptDue(OTHER, T0 + 8 * DAY, throwing)).toBe(true)
    expect(lastPromptAt(ME, throwing)).toBeNull()
  })

  it('no storage at all (null): once per tab session too', () => {
    expect(promptDue(ME, T0, null)).toBe(true)
    notePromptShown(ME, T0, null)
    expect(promptDue(ME, T0 + 9 * DAY, null)).toBe(false)
  })

  it('what storage holds that is not a time is ignored (the person is asked)', () => {
    for (const garbage of ['', 'soon', 'NaN', '-5', '0', '[]']) {
      resetPromptForTests()
      const m = new Map([[promptKey(ME), garbage]])
      const s: PromptStorage = { getItem: (k) => m.get(k) ?? null, setItem: () => {} }
      expect(promptDue(ME, T0, s), garbage).toBe(true)
    }
  })

  it('a time in the future (a clock set back) is not yet: the week runs from it', () => {
    const { s, m } = memory()
    m.set(promptKey(ME), String(T0 + 3 * DAY))
    expect(promptDue(ME, T0, s)).toBe(false)
    expect(promptDue(ME, T0 + 10 * DAY, s)).toBe(true)
  })
})

describe('who a moment belongs to: only the person who ran it is asked', () => {
  const facts = (
    over: Partial<{ me: string; voteStarter: string | null; presenter: string | null }> = {},
  ) => ({
    me: ME,
    voteStarter: null,
    presenter: null,
    ...over,
  })
  it('a vote reveal and "Results to board" are the vote starter’s, nobody else’s (an owner who only watched included)', () => {
    for (const m of ['vote-reveal', 'results-to-board'] as const) {
      expect(ownsMoment(m, facts({ voteStarter: ME })), m).toBe(true)
      expect(ownsMoment(m, facts({ voteStarter: OTHER })), m).toBe(false)
      expect(ownsMoment(m, facts({ voteStarter: OTHER, presenter: ME })), m).toBe(false)
      expect(ownsMoment(m, facts()), m).toBe(false)
    }
  })
  it('a presentation’s stop and the run of show’s end are the presenter’s', () => {
    for (const m of ['presentation-stop', 'run-of-show-end'] as const) {
      expect(ownsMoment(m, facts({ presenter: ME })), m).toBe(true)
      expect(ownsMoment(m, facts({ presenter: OTHER })), m).toBe(false)
      expect(ownsMoment(m, facts({ voteStarter: ME })), m).toBe(false)
      expect(ownsMoment(m, facts()), m).toBe(false)
    }
  })
  it('every moment of the contract has an owner rule (a new moment is a decision here)', () => {
    for (const m of FEEDBACK_PROMPT_MOMENTS)
      expect(typeof ownsMoment(m as FeedbackPromptMoment, facts({ voteStarter: ME, presenter: ME }))).toBe(
        'boolean',
      )
  })
})

describe('words in progress: never while this tab holds a text lease or has an editor open', () => {
  const holders = (...sids: string[]) => new Map(sids.map((sid, i) => [`el${i}`, { sid }]))
  it('an open editor, or a lease held by this tab’s own session, is typing', () => {
    expect(holdsTextLease({ editingId: 'n1', holders: null, mySid: 'a:1' })).toBe(true)
    expect(holdsTextLease({ editingId: null, holders: holders('b:1', 'a:1'), mySid: 'a:1' })).toBe(true)
  })
  it('other people’s leases, no leases, and an engine that is not there are not', () => {
    expect(holdsTextLease({ editingId: null, holders: holders('b:1', 'c:1'), mySid: 'a:1' })).toBe(false)
    expect(holdsTextLease({ editingId: null, holders: holders(), mySid: 'a:1' })).toBe(false)
    expect(holdsTextLease({ editingId: null, holders: null, mySid: null })).toBe(false)
    expect(holdsTextLease({ editingId: null, holders: holders('a:1'), mySid: null })).toBe(false)
  })
})

describe('the decision', () => {
  const ok: Parameters<typeof decideFeedbackPrompt>[0] = {
    guest: false,
    typing: false,
    due: true,
    noted: T0,
    now: T0 + 1_000,
  }
  it('shows for an account that is due, not typing, with a fresh moment', () => {
    expect(decideFeedbackPrompt(ok)).toBe('show')
  })
  it('never for a name-only guest, whatever else is true', () => {
    expect(decideFeedbackPrompt({ ...ok, guest: true })).toBe('drop')
    expect(decideFeedbackPrompt({ ...ok, guest: true, typing: true })).toBe('drop')
  })
  it('not again within the week: the moment is let go, not kept', () => {
    expect(decideFeedbackPrompt({ ...ok, due: false })).toBe('drop')
  })
  it('waits (keeps the moment) while words are in progress, and shows once they are done', () => {
    expect(decideFeedbackPrompt({ ...ok, typing: true })).toBe('wait')
    expect(decideFeedbackPrompt({ ...ok, typing: false })).toBe('show')
  })
  it('N1 (wave M follow-up 2): a person whose kind is not known yet is waited for, not dropped; a guest still is', () => {
    // /api/me has not answered: the moment is kept (and asked again when the kind arrives)
    expect(decideFeedbackPrompt({ ...ok, guest: null })).toBe('wait')
    expect(decideFeedbackPrompt({ ...ok, guest: null, typing: true })).toBe('wait')
    // ...but not for ever, and not when it could never show anyway
    expect(decideFeedbackPrompt({ ...ok, guest: null, now: T0 + PROMPT_MOMENT_TTL_MS + 1 })).toBe('drop')
    expect(decideFeedbackPrompt({ ...ok, guest: null, due: false })).toBe('drop')
    // known: an account shows, a guest drops
    expect(decideFeedbackPrompt({ ...ok, guest: false })).toBe('show')
    expect(decideFeedbackPrompt({ ...ok, guest: true })).toBe('drop')
  })
  it('a moment older than a few minutes is stale: dropped, even when typing or not due', () => {
    const late = { ...ok, now: T0 + PROMPT_MOMENT_TTL_MS + 1 }
    expect(decideFeedbackPrompt(late)).toBe('drop')
    expect(decideFeedbackPrompt({ ...late, typing: true })).toBe('drop')
    expect(decideFeedbackPrompt({ ...ok, now: T0 + PROMPT_MOMENT_TTL_MS })).toBe('show')
  })
})

describe('N1 (wave M follow-up 2): what a one-click Good sends is only what the person has seen', () => {
  const sources = {
    pathname: '/b/board-1?token=secret#frag',
    userAgent: 'UA',
    width: 1280.4,
    height: 720,
    build: 'abc123',
    now: new Date('2026-10-10T12:00:00Z'),
  }
  it('names the board by its id and never by its title (the title is a private word of the board)', () => {
    const c = promptGoodContext({ ...sources, boardId: 'board-1' })
    expect(c.boardId).toBe('board-1')
    expect(c.boardTitle).toBeNull()
    // the rest is the dialog's own block: no query or fragment, a rounded window, the build and the time
    expect(c).toMatchObject({
      path: '/b/board-1',
      userAgent: 'UA',
      viewport: { width: 1280, height: 720 },
      build: 'abc123',
      at: '2026-10-10T12:00:00.000Z',
    })
    expect(JSON.stringify(c)).not.toMatch(/secret|frag/)
  })
})

describe('what is sent: the contract’s own words', () => {
  it('Good sends "Good (after <moment>)" and the issue dialog opens with "After <moment>: "', () => {
    expect(feedbackPromptGoodText('vote-reveal')).toBe('Good (after a vote reveal)')
    expect(feedbackPromptIssuePrefill('vote-reveal')).toBe('After a vote reveal: ')
    expect(feedbackPromptGoodText('presentation-stop')).toBe('Good (after a presentation)')
    expect(feedbackPromptIssuePrefill('run-of-show-end')).toBe('After the run of show: ')
  })
  it('a dialog opened with a sentence sends nothing until the person adds to it', () => {
    const prefill = feedbackPromptIssuePrefill('vote-reveal')
    expect(sendsOnlyPrefill(prefill, prefill)).toBe(true)
    expect(sendsOnlyPrefill(`${prefill}  `, prefill)).toBe(true)
    expect(sendsOnlyPrefill(`${prefill}the timer jumped`, prefill)).toBe(false)
    expect(sendsOnlyPrefill('', prefill)).toBe(false)
    // no prefill: any text is the person's own
    expect(sendsOnlyPrefill('hello', null)).toBe(false)
    expect(sendsOnlyPrefill('hello', undefined)).toBe(false)
  })
})
