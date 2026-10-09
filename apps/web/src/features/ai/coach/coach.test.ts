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
import { aiKit, type El, note, renderIn } from '../ported/test-kit.ts'
import { CoachOverlay } from './CoachChip.tsx'
import {
  applyWorkshopEvent,
  coachFacts,
  coachKey,
  coachWorkshop,
  dismissedSteps,
  dismissStep,
  listenWorkshop,
  resetDismissals,
} from './facts.ts'
import {
  COACH_THEMES_MIN_NOTES,
  type CoachFacts,
  type CoachRole,
  type CoachWorkshop,
  nextStep,
  stepKey,
} from './next-step.ts'

const SID = 'vot_0123456789abcdefghij'
const FACILITATOR: CoachRole = { facilitator: true, following: false }
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
    expect(nextStep(NONE_WS, f, { facilitator: false, following: false })).toBeNull()
    expect(nextStep(NONE_WS, f, { facilitator: true, following: true })).toBeNull()
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
    expect(ws.vote).toEqual({ sessionId: SID, status: 'open', top: [] })
    ws = applyWorkshopEvent(ws, WORKSHOP_EVENTS.results, {
      sessionId: SID,
      results: [
        { shapeId: 'shape:b', count: 1, rank: 2 },
        { shapeId: 'shape:a', count: 3, rank: 1 },
      ],
      totalVotesCast: 4,
      participants: 2,
    })
    expect(ws.vote).toEqual({ sessionId: SID, status: 'revealed', top: ['shape:a', 'shape:b'] })
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
    dismissStep('b-1', 'themes', s)
    resetDismissals() // a reload: only the storage is left
    expect(dismissedSteps('b-1', s).has('themes')).toBe(true)
    expect(dismissedSteps('b-1', s).has('vote')).toBe(false)
    expect(dismissedSteps('b-2', s).has('themes')).toBe(false)
    expect(JSON.parse(s.m.get(coachKey('b-1')) ?? '[]')).toEqual(['themes'])
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
    const k = aiKit(board)
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
})
