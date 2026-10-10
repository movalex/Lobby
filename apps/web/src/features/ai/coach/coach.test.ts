// Wave L (W2, L2-4): the session coach.
//  - next-step.ts: a state table over every transition (notes → themes → a vote → a reveal → action items →
//    Wrap up → nothing once a recap is on the board), a revealed brainstorm, a vote still open; viewers, guests
//    and followers get nothing.
//  - facts.ts: the board's facts (ungrouped team notes per frame, theme labels and their notes, action items, a
//    recap frame) and the workshop's state from the event stream; dismissals per board that stay dismissed, with
//    localStorage working or throwing.
//  - the chip writes nothing and requests nothing until it is clicked.
import { PRIVATE_NOTES_EVENTS, WORKSHOP_EVENTS } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadWorkshop, workshopKit } from '../../workshops/ported/ctx-kit.ts'
import { aiJob } from '../ported/runtime.ts'
import { AI_ON, aiKit, type El, note, renderIn } from '../ported/test-kit.ts'
import { CoachOverlay, refusedHint, sessionFactsOf } from './CoachChip.tsx'
import {
  applyWorkshopEvent,
  coachFacts,
  coachKey,
  coachWorkshop,
  dismissalDay,
  dismissedSteps,
  dismissStep,
  listenWorkshop,
  resetDismissals,
  seedWorkshop,
} from './facts.ts'
import {
  actionsLabel,
  COACH_THEMES_MIN_NOTES,
  COACH_TOP_N,
  type CoachFacts,
  type CoachRole,
  type CoachWorkshop,
  nextStep,
  runsSession,
  type SessionFacts,
  stepKey,
} from './next-step.ts'

const SID = 'vot_0123456789abcdefghij'
/** The kit's person (an editor) as the board's owner: who runs a session nobody else runs (M2-2). */
const owner = <K extends { ctx: unknown }>(k: K): K => {
  ;(k.ctx as { role: string }).role = 'owner'
  return k
}
const FACILITATOR: CoachRole = { facilitator: true, following: false, ai: true }
const NONE_WS: CoachWorkshop = { brainstorm: null, vote: null }
const ids = (n: number, p = 'n') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`)
const facts = (over: Partial<CoachFacts> = {}): CoachFacts => ({
  frames: [],
  themeLabels: 0,
  themeNotes: [],
  actionItems: 0,
  recap: false,
  ...over,
})

describe('next-step: the state table', () => {
  const rows: [string, CoachWorkshop, CoachFacts, string | null][] = [
    ['an empty board: nothing', NONE_WS, facts(), null],
    ['7 notes in a frame: not yet', NONE_WS, facts({ frames: [{ frameId: 'f1', ungrouped: ids(7) }] }), null],
    [
      '8 ungrouped team notes in a frame: themes',
      NONE_WS,
      facts({ frames: [{ frameId: 'f1', ungrouped: ids(COACH_THEMES_MIN_NOTES) }] }),
      'themes:Group these 8 notes into themes',
    ],
    [
      'a revealed brainstorm with 3 notes in its frame: themes',
      { brainstorm: { status: 'revealed', frameId: 'f2' }, vote: null },
      facts({ frames: [{ frameId: 'f2', ungrouped: ids(3) }] }),
      'themes:Group these 3 notes into themes',
    ],
    [
      'an open brainstorm: not yet',
      { brainstorm: { status: 'open', frameId: 'f2' }, vote: null },
      facts({ frames: [{ frameId: 'f2', ungrouped: ids(3) }] }),
      null,
    ],
    [
      'theme labels and no vote: a 3-dot vote',
      NONE_WS,
      facts({ themeLabels: 3, themeNotes: ids(8) }),
      'vote:Start a 3-dot vote on the themes',
    ],
    [
      'a vote is open: nothing (people are voting)',
      { brainstorm: null, vote: { sessionId: SID, status: 'open', top: [] } },
      facts({ themeLabels: 3, themeNotes: ids(8) }),
      null,
    ],
    [
      'closed, not revealed: nothing yet',
      { brainstorm: null, vote: { sessionId: SID, status: 'closed', top: [] } },
      facts({ themeLabels: 3, themeNotes: ids(8) }),
      null,
    ],
    [
      'a revealed vote: action items from the top 5',
      {
        brainstorm: null,
        vote: { sessionId: SID, status: 'revealed', top: ids(7).map((i) => `shape:${i}`) },
      },
      facts({ themeLabels: 3, themeNotes: ids(8) }),
      'actions:Turn the top 5 into action items',
    ],
    [
      'action items on the board: Wrap up',
      { brainstorm: null, vote: { sessionId: SID, status: 'revealed', top: [] } },
      facts({ themeLabels: 3, themeNotes: ids(8), actionItems: 3 }),
      'wrapup:Wrap up',
    ],
    [
      'a recap on the board: done, nothing',
      { brainstorm: null, vote: { sessionId: SID, status: 'revealed', top: [] } },
      facts({ actionItems: 3, recap: true }),
      null,
    ],
    [
      'a new brainstorm round comes before an old Wrap up',
      NONE_WS,
      facts({ frames: [{ frameId: 'f3', ungrouped: ids(9) }], actionItems: 3 }),
      'themes:Group these 9 notes into themes',
    ],
  ]
  for (const [name, ws, f, want] of rows)
    it(name, () => {
      const step = nextStep(ws, f, FACILITATOR)
      expect(step ? `${step.id}:${step.label}` : null).toBe(want)
    })

  it('the steps carry what their command needs: the notes, the theme refs, the vote and its top 5', () => {
    const themes = nextStep(NONE_WS, facts({ frames: [{ frameId: 'f1', ungrouped: ids(8) }] }), FACILITATOR)
    expect(themes).toMatchObject({ id: 'themes', notes: ids(8) })
    const vote = nextStep(NONE_WS, facts({ themeLabels: 2, themeNotes: ['a', 'b'] }), FACILITATOR)
    expect(vote).toMatchObject({ id: 'vote', refs: ['shape:a', 'shape:b'] })
    const top = ids(7).map((i) => `shape:${i}`)
    const actions = nextStep(
      { brainstorm: null, vote: { sessionId: SID, status: 'revealed', top } },
      facts({ themeLabels: 1, themeNotes: ['a'] }),
      FACILITATOR,
    )
    expect(actions).toMatchObject({ id: 'actions', voteSessionId: SID, refs: top.slice(0, 5) })
    if (!actions) throw new Error('no step')
    expect(stepKey(actions)).toBe(`actions:${SID}`)
  })

  it('viewers, guests and followers in present mode get nothing', () => {
    const f = facts({ frames: [{ frameId: 'f1', ungrouped: ids(10) }] })
    expect(nextStep(NONE_WS, f, { facilitator: false, following: false, ai: true })).toBeNull()
    expect(nextStep(NONE_WS, f, { facilitator: true, following: true, ai: true })).toBeNull()
  })

  it('AI off (or not usable here): no themes or action items chip; the vote and Wrap up stay', () => {
    const OFF: CoachRole = { ...FACILITATOR, ai: false }
    const crowded = facts({ frames: [{ frameId: 'f1', ungrouped: ids(9) }] })
    expect(nextStep(NONE_WS, crowded, OFF)).toBeNull()
    expect(
      nextStep(
        { brainstorm: { status: 'revealed', frameId: 'f1' }, vote: null },
        facts({ frames: [{ frameId: 'f1', ungrouped: ids(3) }] }),
        OFF,
      ),
    ).toBeNull()
    const revealed: CoachWorkshop = {
      brainstorm: null,
      vote: { sessionId: SID, status: 'revealed', top: ['shape:a'] },
    }
    expect(nextStep(revealed, facts({ themeLabels: 2, themeNotes: ['a', 'b'] }), OFF)).toBeNull()
    // what needs no AI is still offered
    expect(nextStep(NONE_WS, facts({ themeLabels: 2, themeNotes: ['a', 'b'] }), OFF)?.id).toBe('vote')
    expect(nextStep(revealed, facts({ actionItems: 2 }), OFF)?.id).toBe('wrapup')
    // the 8+ notes of a new round do not hide the vote behind an AI step that cannot run
    expect(nextStep(NONE_WS, facts({ ...crowded, themeLabels: 1, themeNotes: ['a'] }), OFF)?.id).toBe('vote')
  })
})

describe('facts: the board and the workshop', () => {
  const frame = (id: string, x: number): El => ({
    id,
    type: 'frame',
    x,
    y: 0,
    width: 2000,
    height: 1200,
    name: id,
  })
  const notesIn = (frameId: string, n: number, x0: number) =>
    Array.from({ length: n }, (_, i) =>
      note(`${frameId}-n${i}`, x0 + (i % 4) * 220, 100 + Math.floor(i / 4) * 220, `Idea ${i}`, { frameId }),
    ).flat()

  it('counts the team’s ungrouped notes per frame; a frame with AI theme labels holds the theme notes', () => {
    const k = aiKit([
      frame('f1', 0),
      ...notesIn('f1', 8, 40),
      frame('f2', 3000),
      ...notesIn('f2', 3, 3040),
      {
        id: 'lab',
        type: 'text',
        x: 3040,
        y: 60,
        width: 100,
        height: 30,
        frameId: 'f2',
        customData: { lobby: { ai: { by: 'usr_ana' }, kind: 'ai-theme-label' } },
      },
      ...note('act', 6000, 0, 'Book it', {
        customData: { lobby: { ai: { by: 'usr_ana' }, kind: 'ai-action-item' } },
      }),
    ])
    const f = coachFacts(k.canvas)
    expect(f.frames).toEqual([{ frameId: 'f1', ungrouped: ids(8).map((_, i) => `f1-n${i}`) }])
    expect(f.themeLabels).toBe(1)
    expect([...f.themeNotes].sort()).toEqual(['f2-n0', 'f2-n1', 'f2-n2'])
    expect(f.actionItems).toBe(1)
    expect(f.recap).toBe(false)
    expect(
      coachFacts(aiKit([{ ...frame('r', 0), customData: { lobby: { kind: 'recap' } } }]).canvas).recap,
    ).toBe(true)
  })

  it('follows the vote and the brainstorm on the event stream; garbage changes nothing', () => {
    let ws: CoachWorkshop = NONE_WS
    ws = applyWorkshopEvent(ws, WORKSHOP_EVENTS.vote, {
      sessionId: SID,
      status: 'open',
      totalVotesCast: 0,
      participantsDone: 0,
      participants: 2,
      endsAt: null,
    })
    expect(ws.vote).toEqual({ sessionId: SID, status: 'open', top: [], startedBy: null })
    ws = applyWorkshopEvent(ws, WORKSHOP_EVENTS.results, {
      sessionId: SID,
      results: [
        { shapeId: 'shape:b', count: 1, rank: 2 },
        { shapeId: 'shape:a', count: 3, rank: 1 },
      ],
      totalVotesCast: 4,
      participants: 2,
    })
    expect(ws.vote).toEqual({
      sessionId: SID,
      status: 'revealed',
      top: ['shape:a', 'shape:b'],
      startedBy: null,
    })
    expect(applyWorkshopEvent(ws, WORKSHOP_EVENTS.vote, { nope: 1 })).toBe(ws)
    const now = new Date().toISOString()
    ws = applyWorkshopEvent(ws, PRIVATE_NOTES_EVENTS.changed, {
      session: {
        id: 'pbs_0123456789abcdef',
        boardId: 'b-kit0000001',
        prompt: 'Ideas?',
        anonymous: false,
        frameId: 'shape:f2',
        status: 'revealed',
        createdBy: 'usr_ana0000001',
        createdAt: now,
        revealedAt: now,
        endedAt: null,
        placedCount: null,
      },
      counts: { notes: 3, people: 2 },
    })
    expect(ws.brainstorm).toEqual({ status: 'revealed', frameId: 'f2' })
    expect(applyWorkshopEvent(ws, 'workshop.reaction', {})).toBe(ws)
  })

  it('a vote revealed before the board opened: the coach takes it from the workshop store (W5’s lastRevealedResults)', async () => {
    const kit = workshopKit()
    const iso = new Date().toISOString()
    await loadWorkshop(kit, {
      timer: null,
      serverNow: iso,
      vote: {
        session: {
          id: SID,
          boardId: 'b-k3kit00001',
          title: 'Dot vote',
          votesPerPerson: 3,
          onePerObject: false,
          scope: 'board',
          frameId: null,
          shapeTypes: null,
          status: 'revealed',
          createdBy: 'usr_facilitator0001',
          createdAt: iso,
          endsAt: null,
          closedAt: iso,
          revealedAt: iso,
        },
        myVotes: {},
        myRemaining: 0,
        done: true,
        participantsDone: 2,
        participants: 2,
        totalVotesCast: 4,
        results: [
          { shapeId: 'shape:b', count: 1, rank: 2 },
          { shapeId: 'shape:a', count: 3, rank: 1 },
        ],
      },
    })
    const ctx = { canvas: kit.ctx.canvas, events: kit.ctx.events }
    seedWorkshop(ctx)
    expect(coachWorkshop(kit.ctx.canvas).get().vote).toEqual({
      sessionId: SID,
      status: 'revealed',
      top: ['shape:a', 'shape:b'],
      // M2-2: and who started it, which the stream never says
      startedBy: 'usr_facilitator0001',
    })
  })

  it('listenWorkshop keeps the coach’s state from the stream', () => {
    const k = aiKit()
    const stop = listenWorkshop(k.ctx)
    k.emit(WORKSHOP_EVENTS.results, {
      sessionId: SID,
      results: [{ shapeId: 'shape:a', count: 2, rank: 1 }],
      totalVotesCast: 2,
      participants: 1,
    })
    expect(coachWorkshop(k.canvas).get().vote?.status).toBe('revealed')
    stop()
  })
})

describe('dismissals and the chip', () => {
  beforeEach(() => resetDismissals())
  afterEach(() => vi.unstubAllGlobals())

  const memory = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      m,
    }
  }
  const throwing = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }

  it('a dismissed step stays dismissed for that board (stored), and only that step', () => {
    const s = memory()
    const now = Date.UTC(2026, 9, 8, 12, 0, 0)
    dismissStep('b-1', 'themes', s, now)
    resetDismissals() // a reload: only the storage is left
    expect(dismissedSteps('b-1', s, now + 3_600_000).has('themes')).toBe(true)
    expect(dismissedSteps('b-1', s, now).has('vote')).toBe(false)
    expect(dismissedSteps('b-2', s, now).has('themes')).toBe(false)
    expect(JSON.parse(s.m.get(coachKey('b-1')) ?? '[]')).toEqual([`themes@${dismissalDay(now)}`])
  })

  it('a dismissal holds for the day: the board’s next workshop (another day) offers the step again', () => {
    const s = memory()
    const now = Date.UTC(2026, 9, 8, 12, 0, 0)
    const nextWeek = now + 7 * 24 * 3_600_000
    dismissStep('b-4', 'themes', s, now)
    resetDismissals()
    expect(dismissedSteps('b-4', s, now).has('themes')).toBe(true)
    expect(dismissedSteps('b-4', s, nextWeek).has('themes')).toBe(false)
    // a dismissal that day keeps only that day's
    dismissStep('b-4', 'vote', s, nextWeek)
    expect(JSON.parse(s.m.get(coachKey('b-4')) ?? '[]')).toEqual([`vote@${dismissalDay(nextWeek)}`])
  })

  it('with localStorage throwing it still works: the page keeps the dismissal', () => {
    expect(() => dismissStep('b-3', 'vote', throwing)).not.toThrow()
    expect(dismissedSteps('b-3', throwing).has('vote')).toBe(true)
    expect(dismissedSteps('b-3', null).has('vote')).toBe(true)
  })

  it('the chip shows the step to a facilitator, nothing to a viewer, and writes or requests nothing', () => {
    vi.stubGlobal('document', { querySelector: () => null })
    const board = [
      { id: 'f1', type: 'frame', x: 0, y: 0, width: 2000, height: 1200, name: 'Ideas' } as El,
      ...Array.from({ length: 8 }, (_, i) =>
        note(`n${i}`, 40 + (i % 4) * 220, 100 + Math.floor(i / 4) * 220, `Idea ${i}`, { frameId: 'f1' }),
      ).flat(),
    ]
    const k = owner(aiKit(board))
    let html = renderIn(k, CoachOverlay)
    expect(html).toContain('data-testid="coach-chip"')
    expect(html).toContain('data-step="themes"')
    expect(html).toContain('Group these 8 notes into themes')
    const viewer = aiKit(board)
    ;(viewer.ctx as { role: string }).role = 'viewer'
    html = renderIn(viewer, CoachOverlay)
    expect(html).not.toContain('coach-chip')
    expect(k.pushes).toEqual([])
    expect(k.requests).toEqual([])
  })

  it('AI off on the board, not configured, the budget spent, no insert, or the status not read yet: no chip', () => {
    vi.stubGlobal('document', { querySelector: () => null })
    const board = [
      { id: 'f1', type: 'frame', x: 0, y: 0, width: 2000, height: 1200, name: 'Ideas' } as El,
      ...Array.from({ length: 9 }, (_, i) =>
        note(`n${i}`, 40 + (i % 4) * 220, 100 + Math.floor(i / 4) * 220, `Idea ${i}`, { frameId: 'f1' }),
      ).flat(),
    ]
    const spent = { usedPercent: 100, resetsAt: '2026-10-09T00:00:00.000Z' }
    for (const [why, status] of [
      ['board off', { ...AI_ON, enabled: false, reason: 'board-off' }],
      ['not configured', { ...AI_ON, enabled: false, reason: 'not-configured' }],
      ['budget spent', { ...AI_ON, budget: spent }],
      ['may not insert', { ...AI_ON, canInsert: false }],
      ['not read yet', null],
    ] as const) {
      const k = owner(aiKit(board, { status: status as never }))
      expect(renderIn(k, CoachOverlay), why).not.toContain('coach-chip')
      expect(k.requests, why).toEqual([])
    }
    // the same board with AI usable: the chip
    expect(renderIn(owner(aiKit(board)), CoachOverlay)).toContain('Group these 9 notes into themes')
  })

  it('a click that cannot run says why (never silent); Wrap up needs no AI and has no hint', () => {
    const k = aiKit([], { status: { ...AI_ON, enabled: false, reason: 'board-off' } })
    const themes = { id: 'themes', label: 'Group these 9 notes into themes', notes: ['n1'] } as const
    expect(refusedHint(k.ctx, themes)).toEqual({
      text: 'AI isn’t available on this board right now.',
      testId: 'ai-error',
      tone: 'error',
    })
    aiJob(k.canvas).set({ id: 1 } as never)
    expect(refusedHint(k.ctx, { id: 'actions', label: 'x', voteSessionId: SID, refs: [] })?.text).toContain(
      'still working',
    )
    aiJob(k.canvas).set(null)
    expect(refusedHint(k.ctx, { id: 'vote', label: 'x', refs: [] })?.testId).toBe('coach-vote-hint')
    expect(refusedHint(k.ctx, { id: 'wrapup', label: 'Wrap up' })).toBeNull()
  })
})

// ---- M2-2 (wave M, W2): the right count, and only for the person running the session ---------------------------

describe('M2-2: "Turn the top N" says how many results there are', () => {
  const revealed = (n: number): CoachWorkshop => ({
    brainstorm: null,
    vote: {
      sessionId: SID,
      status: 'revealed',
      top: ids(n, 'w').map((i) => `shape:${i}`),
      startedBy: null,
    },
  })
  const label = (n: number) => {
    const step = nextStep(revealed(n), facts({ themeLabels: 1, themeNotes: ['a'] }), FACILITATOR)
    return step?.id === 'actions' ? step.label : (step?.id ?? null)
  }

  it('3 results: the top 3 (it said 5 before)', () => {
    expect(label(3)).toBe('Turn the top 3 into action items')
  })

  it('1 result: the winner', () => {
    expect(label(1)).toBe('Turn the winner into an action item')
  })

  it('2, 4 and exactly 5 results say their number; more than 5 stop at 5', () => {
    expect(label(2)).toBe('Turn the top 2 into action items')
    expect(label(4)).toBe('Turn the top 4 into action items')
    expect(label(COACH_TOP_N)).toBe('Turn the top 5 into action items')
    expect(label(6)).toBe('Turn the top 5 into action items')
    expect(label(40)).toBe('Turn the top 5 into action items')
  })

  it('the step carries as many refs as the label counts', () => {
    for (const n of [1, 3, 5, 9]) {
      const step = nextStep(revealed(n), facts(), FACILITATOR)
      expect(step?.id === 'actions' && step.refs.length).toBe(Math.min(COACH_TOP_N, n))
    }
  })

  it('a revealed vote with no results offers no action items (there is nothing to turn)', () => {
    expect(nextStep(revealed(0), facts({ themeLabels: 1, themeNotes: ['a'] }), FACILITATOR)).toBeNull()
    // and Wrap up still follows action items that are there
    expect(nextStep(revealed(0), facts({ actionItems: 2 }), FACILITATOR)?.id).toBe('wrapup')
  })

  it('actionsLabel is the one place that words it', () => {
    expect(actionsLabel(1)).toBe('Turn the winner into an action item')
    expect(actionsLabel(2)).toBe('Turn the top 2 into action items')
  })
})

describe('M2-2: only the person running the session gets the chip', () => {
  const ME = 'usr_ana'
  const OTHER = 'usr_bob'
  const f = (over: Partial<SessionFacts> = {}): SessionFacts => ({
    me: ME,
    role: 'editor',
    voteStarter: null,
    presenter: null,
    ...over,
  })

  it('a vote’s starter runs it, whatever their role; nobody else does, owner included', () => {
    expect(runsSession(f({ voteStarter: ME }))).toBe(true)
    expect(runsSession(f({ voteStarter: ME, role: 'owner' }))).toBe(true)
    expect(runsSession(f({ voteStarter: OTHER }))).toBe(false)
    expect(runsSession(f({ voteStarter: OTHER, role: 'owner' }))).toBe(false)
    // a presenter does not take a vote away from its starter
    expect(runsSession(f({ voteStarter: OTHER, presenter: ME }))).toBe(false)
  })

  it('with no vote, the live presenter runs it; an owner does not while someone else presents', () => {
    expect(runsSession(f({ presenter: ME }))).toBe(true)
    expect(runsSession(f({ presenter: OTHER }))).toBe(false)
    expect(runsSession(f({ presenter: OTHER, role: 'owner' }))).toBe(false)
  })

  it('with no vote and nobody presenting, the board’s owner runs it and a plain editor does not', () => {
    expect(runsSession(f({ role: 'owner' }))).toBe(true)
    expect(runsSession(f({ role: 'editor' }))).toBe(false)
    expect(runsSession(f({ role: 'commenter' }))).toBe(false)
    expect(runsSession(f({ role: 'viewer' }))).toBe(false)
  })

  it('the vote’s starter is read from the coach’s state, else the workshop store; the presenter is passed in', () => {
    const k = aiKit()
    expect(sessionFactsOf(k.ctx, null)).toEqual({
      me: 'usr_ana',
      role: 'editor',
      voteStarter: null,
      presenter: null,
    })
    coachWorkshop(k.canvas).set({
      brainstorm: null,
      vote: { sessionId: SID, status: 'revealed', top: ['shape:a'], startedBy: 'usr_bob' },
    })
    expect(sessionFactsOf(k.ctx, 'usr_cy')).toMatchObject({ voteStarter: 'usr_bob', presenter: 'usr_cy' })
  })

  it('the chip on a plain editor’s screen: none; on the owner’s: the step; on the vote starter’s (an editor): the step', () => {
    vi.stubGlobal('document', { querySelector: () => null })
    try {
      const board = [
        { id: 'f1', type: 'frame', x: 0, y: 0, width: 2000, height: 1200, name: 'Ideas' } as El,
        ...Array.from({ length: 8 }, (_, i) =>
          note(`n${i}`, 40 + (i % 4) * 220, 100 + Math.floor(i / 4) * 220, `Idea ${i}`, { frameId: 'f1' }),
        ).flat(),
      ]
      // 8 notes, no vote, nobody presenting: the owner is the facilitator
      expect(renderIn(aiKit(board), CoachOverlay), 'a plain editor').not.toContain('coach-chip')
      expect(renderIn(owner(aiKit(board)), CoachOverlay), 'the owner').toContain(
        'Group these 8 notes into themes',
      )
      // a vote of someone else's: the owner is no longer the facilitator, its starter is
      const results = ['shape:n0', 'shape:n1', 'shape:n2']
      const withVote = (kit: ReturnType<typeof aiKit>, startedBy: string) => {
        coachWorkshop(kit.canvas).set({
          brainstorm: null,
          vote: { sessionId: SID, status: 'revealed', top: results, startedBy },
        })
        return kit
      }
      const few = [{ id: 'f1', type: 'frame', x: 0, y: 0, width: 2000, height: 1200, name: 'Ideas' } as El]
      expect(
        renderIn(withVote(owner(aiKit(few)), 'usr_bob'), CoachOverlay),
        'the owner, bob’s vote',
      ).not.toContain('coach-chip')
      expect(renderIn(withVote(aiKit(few), 'usr_bob'), CoachOverlay), 'an editor, bob’s vote').not.toContain(
        'coach-chip',
      )
      const mine = renderIn(withVote(aiKit(few, { me: 'usr_bob' }), 'usr_bob'), CoachOverlay)
      expect(mine, 'bob, his own vote').toContain('Turn the top 3 into action items')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
