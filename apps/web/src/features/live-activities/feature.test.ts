// WS2 (wave V, V1): the 'live-activities' feature on a board page (an in-memory canvas and a fake api with the
// contracts' wire shapes). With its switch off it offers nothing and asks nothing; with the api's switch off (404) it
// offers nothing either; on, a facilitator gets the panel, the Facilitate entry, the command and the setup dialog; a
// participant is told when someone else starts one, sees the pill, answers in the panel; a tab that only receives the
// activity and its results writes nothing to the board. The pure pieces (the answer sheet's answer, the setup's input,
// the recap's lines, the entry's words) are checked here too.
import {
  type ActivityState,
  type ActivitySummary,
  activityPath,
  LIVE_ACTIVITY_EVENTS,
  type LiveActivity,
} from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoticeInput } from '../../board/board-context.ts'
import { LIVE_FLAG_KEYS, setLiveSwitches } from '../live/flags.ts'
import { workshopKit } from '../workshops/ported/ctx-kit.ts'
import { facilitateExtras, facilitatePillExtras } from '../workshops/ported/facilitate-entries.ts'
import { ActivityPanel } from './ActivityPanel.tsx'
import { answerOf } from './AnswerForm.tsx'
import { ActivityDialogsLayer, entryWords } from './Entry.tsx'
import { mountLiveActivities, panelVisible, START_COMMAND } from './index.tsx'
import { sectionOf } from './recap.ts'
import { setupInput, setupProblem } from './SetupDialog.tsx'
import { existingActivityStore } from './store.ts'
import { recapLine } from './words.ts'

const FAC = 'usr_facilitator0001'
const AID = 'act_0123456789abcdef'

const activity = (over: Partial<LiveActivity> = {}): LiveActivity =>
  ({
    id: AID,
    boardId: 'b-k3kit00001',
    kind: 'poll',
    prompt: 'Which day?',
    config: { options: ['Mon', 'Fri'], maxChoices: 1 },
    anonymous: true,
    resultsLive: false,
    status: 'open',
    createdBy: FAC,
    createdAt: '2026-10-18T10:00:00.000Z',
    endsAt: null,
    closedAt: null,
    revealedAt: null,
    placedAt: null,
    ...over,
  }) as LiveActivity

const stateOf = (over: Partial<ActivityState> = {}): ActivityState => ({
  activity: null,
  answered: 0,
  myAnswer: null,
  results: null,
  canManage: false,
  starterLeft: false,
  hiddenWords: [],
  serverNow: new Date().toISOString(),
  ...over,
})

/** The workshops kit with its api answering the activity routes from `serve` (404: the api's switch off). */
function laKit(opts: Parameters<typeof workshopKit>[0] = {}) {
  const kit = workshopKit(opts)
  const notices: NoticeInput[] = []
  const calls: { method: string; path: string; body?: unknown }[] = []
  let current: ActivityState | 404 = stateOf()
  const request = async (method: string, path: string, o: { body?: unknown; schema: unknown }) => {
    calls.push({ method, path, body: o.body })
    const schema = o.schema as { parse(v: unknown): unknown } | null
    if (current === 404) throw Object.assign(new Error('Not found.'), { status: 404, code: 'NOT_FOUND' })
    if (path === activityPath(kit.ctx.board.id) || method === 'POST') return schema?.parse(current)
    throw new Error(`unexpected ${method} ${path}`)
  }
  Object.assign(kit.ctx.api, { request })
  Object.assign(kit.ctx, { notify: (n: NoticeInput) => notices.push(n) })
  // every write this board page makes (a receiving tab makes none)
  const steps: string[] = []
  const canvas = kit.ctx.canvas
  const real = canvas.transact.bind(canvas)
  canvas.transact = ((label: string, fn: never, o?: never) => {
    steps.push(label)
    return real(label, fn, o)
  }) as typeof canvas.transact
  return {
    ...kit,
    notices,
    steps,
    calls,
    serve(s: ActivityState | 404) {
      current = s
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const switchOn = () => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => (k === LIVE_FLAG_KEYS.activities ? '1' : null) })
  setLiveSwitches({ activities: true, joinCodes: false, breakouts: false })
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.unstubAllGlobals()
  setLiveSwitches(undefined)
})

describe('switch off', () => {
  it('offers nothing and asks nothing (the web switch ships off, and the api told nothing)', async () => {
    const k = laKit()
    cleanups.push(mountLiveActivities(k.ctx))
    await flush()
    for (const l of k.events.resync) l()
    await flush()
    expect(existingActivityStore(k.ctx.events)).toBeNull()
    expect(k.calls).toEqual([])
    expect(panelVisible(k.ctx)).toBe(false)
    expect(START_COMMAND.available?.(k.ctx)).toBe(false)
    expect(facilitateExtras({ ctx: k.ctx, guest: false, facilitator: true }).map((e) => e.id)).not.toContain(
      'activities',
    )
    expect(renderToStaticMarkup(createElement(ActivityDialogsLayer, { ctx: k.ctx }))).toBe('')
  })

  it('the web switch on but the api switch off: nothing either', async () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === LIVE_FLAG_KEYS.activities ? '1' : null) })
    const k = laKit()
    cleanups.push(mountLiveActivities(k.ctx))
    expect(existingActivityStore(k.ctx.events)).toBeNull()
    expect(START_COMMAND.available?.(k.ctx)).toBe(false)
  })

  it('an api that runs no live activities (404) makes the panel and the entry go', async () => {
    switchOn()
    const k = laKit()
    k.serve(404)
    cleanups.push(mountLiveActivities(k.ctx))
    for (const l of k.events.resync) l()
    await flush()
    expect(existingActivityStore(k.ctx.events)?.getSnapshot().absent).toBe(true)
    expect(panelVisible(k.ctx)).toBe(false)
    expect(facilitateExtras({ ctx: k.ctx, guest: false, facilitator: true }).map((e) => e.id)).not.toContain(
      'activities',
    )
  })
})

describe('switch on', () => {
  beforeEach(switchOn)

  it('a facilitator: the panel, the entry, the command and the setup dialog', async () => {
    const k = laKit()
    cleanups.push(mountLiveActivities(k.ctx))
    for (const l of k.events.resync) l()
    await flush()
    expect(k.calls).toEqual([{ method: 'GET', path: activityPath(k.ctx.board.id), body: undefined }])
    expect(panelVisible(k.ctx)).toBe(true)
    expect(START_COMMAND.available?.(k.ctx)).toBe(true)
    expect(START_COMMAND.disabledReason?.(k.ctx)).toBeNull()
    expect(facilitateExtras({ ctx: k.ctx, guest: false, facilitator: true }).map((e) => e.id)).toContain(
      'activities',
    )
    const panel = renderToStaticMarkup(createElement(ActivityPanel, { ctx: k.ctx, close: () => {} }))
    expect(panel).toContain('data-testid="la-start"')
    void START_COMMAND.run(k.ctx, 'palette')
    expect(existingActivityStore(k.ctx.events)?.getSnapshot().setupOpen).toBe(true)
    const layer = renderToStaticMarkup(createElement(ActivityDialogsLayer, { ctx: k.ctx }))
    expect(layer).toContain('data-testid="la-setup-dialog"')
    expect(layer).toContain('data-testid="la-anonymous"')
  })

  it('a viewer: no panel until there is an activity; the command says why it cannot', async () => {
    const k = laKit({ role: 'viewer', userId: 'usr_viewer00000001' })
    cleanups.push(mountLiveActivities(k.ctx))
    for (const l of k.events.resync) l()
    await flush()
    expect(panelVisible(k.ctx)).toBe(false)
    expect(START_COMMAND.disabledReason?.(k.ctx)).toMatch(/editors with an account/)
    k.serve(stateOf({ activity: activity() }))
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: activity(), answered: 0, results: null })
    await flush()
    expect(panelVisible(k.ctx)).toBe(true)
  })

  it('a participant is told, sees the pill, answers in the panel; receiving writes nothing to the board', async () => {
    const k = laKit({ role: 'editor', userId: 'usr_participant0001' })
    cleanups.push(mountLiveActivities(k.ctx))
    for (const l of k.events.resync) l()
    await flush()
    k.serve(stateOf({ activity: activity() }))
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: activity(), answered: 0, results: null })
    await flush()
    expect(k.notices.map((n) => n.testId)).toEqual(['la-start-toast'])
    expect(k.notices[0]?.text).toBe('Poll: Which day?')
    k.notices[0]?.action?.onClick()
    expect(k.panels).toContain('live-activity')
    expect(facilitatePillExtras(k.ctx.canvas).map((p) => [p.id, p.text])).toEqual([['activities', 'Poll']])
    const panel = renderToStaticMarkup(createElement(ActivityPanel, { ctx: k.ctx, close: () => {} }))
    expect(panel).toContain('data-testid="la-answer-form"')
    expect(panel).toContain('data-testid="la-choice-0"')
    expect(panel).toContain('Mon')
    expect(panel).not.toContain('data-testid="la-controls"')
    // revealed elsewhere: the results come in, the pill goes, the board is untouched
    const revealed = activity({ status: 'revealed', revealedAt: '2026-10-18T10:05:00.000Z' })
    const results = { kind: 'poll' as const, answered: 3, counts: [1, 2] }
    k.serve(stateOf({ activity: revealed, answered: 3, results }))
    k.events.emit(LIVE_ACTIVITY_EVENTS.activity, { activity: revealed, answered: 3, results })
    k.events.emit(LIVE_ACTIVITY_EVENTS.results, { activityId: AID, results })
    await flush()
    expect(k.notices.map((n) => n.testId)).toEqual(['la-start-toast', 'la-results-toast'])
    expect(facilitatePillExtras(k.ctx.canvas)).toEqual([])
    const after = renderToStaticMarkup(createElement(ActivityPanel, { ctx: k.ctx, close: () => {} }))
    expect(after).toContain('data-testid="la-poll-results"')
    // a receiving client pushes nothing: no transact on this board at all
    expect(k.steps).toEqual([])
  })

  it('a manager sees the controls and Results to board once revealed', async () => {
    const k = laKit()
    k.serve(
      stateOf({
        activity: activity(),
        canManage: true,
        results: { kind: 'poll', answered: 0, counts: [0, 0] },
      }),
    )
    cleanups.push(mountLiveActivities(k.ctx))
    for (const l of k.events.resync) l()
    await flush()
    const open = renderToStaticMarkup(createElement(ActivityPanel, { ctx: k.ctx, close: () => {} }))
    expect(open).toContain('data-testid="la-reveal"')
    expect(open).toContain('data-testid="la-close"')
    expect(open).not.toContain('data-testid="la-to-board"')
    k.serve(
      stateOf({
        activity: activity({ status: 'revealed' }),
        canManage: true,
        results: { kind: 'poll', answered: 2, counts: [1, 1] },
      }),
    )
    for (const l of k.events.resync) l()
    await flush()
    const done = renderToStaticMarkup(createElement(ActivityPanel, { ctx: k.ctx, close: () => {} }))
    expect(done).toContain('data-testid="la-to-board"')
    expect(done).not.toContain('data-testid="la-named"')
  })

  it('switches that arrive after the page mounted load at once', async () => {
    setLiveSwitches(undefined)
    const k = laKit()
    cleanups.push(mountLiveActivities(k.ctx))
    expect(k.calls).toEqual([])
    setLiveSwitches({ activities: true, joinCodes: false, breakouts: false })
    await flush()
    expect(k.calls.map((c) => c.path)).toEqual([activityPath(k.ctx.board.id)])
  })
})

describe('the pure pieces', () => {
  it('the answer sheet makes the contracts answer, or says what is missing', () => {
    const poll = activity({ config: { options: ['A', 'B', 'C'], maxChoices: 2 } } as Partial<LiveActivity>)
    expect(answerOf(poll, { choices: [], value: null, words: [] })).toEqual({
      problem: 'Pick an option first.',
    })
    expect(answerOf(poll, { choices: [2, 0], value: null, words: [] })).toEqual({
      answer: { kind: 'poll', choices: [0, 2] },
    })
    const words = activity({ kind: 'words', config: { maxWords: 3 } } as Partial<LiveActivity>)
    expect(answerOf(words, { choices: [], value: null, words: ['  ', ''] })).toEqual({
      problem: 'Type a word first.',
    })
    expect(answerOf(words, { choices: [], value: null, words: ['Agile', 'agile '] })).toEqual({
      problem: 'Each word once.',
    })
    expect(answerOf(words, { choices: [], value: null, words: ['x'.repeat(31)] })).toMatchObject({
      problem: expect.stringMatching(/at most 30/),
    })
    expect(answerOf(words, { choices: [], value: null, words: [' Agile  team ', ''] })).toEqual({
      answer: { kind: 'words', words: ['Agile team'] },
    })
    const scale = activity({
      kind: 'scale',
      config: { min: 1, max: 5, minLabel: null, maxLabel: null },
    } as Partial<LiveActivity>)
    expect(answerOf(scale, { choices: [], value: 4, words: [] })).toEqual({
      answer: { kind: 'scale', value: 4 },
    })
  })

  it('the setup sends what the contracts take, and refuses what they refuse, in their words', () => {
    const f = {
      kind: 'poll' as const,
      prompt: 'Which day?',
      options: ['Mon', ' ', 'Fri'],
      maxChoices: 3,
      range: 2,
      minLabel: '',
      maxLabel: '',
      maxWords: 3,
      durationMs: null,
      anonymous: true,
      resultsLive: false,
    }
    expect(setupInput(f)).toEqual({
      kind: 'poll',
      prompt: 'Which day?',
      config: { options: ['Mon', 'Fri'], maxChoices: 2 },
      anonymous: true,
      resultsLive: false,
      durationMs: null,
    })
    expect(setupProblem(setupInput(f))).toBeNull()
    expect(setupProblem(setupInput({ ...f, options: ['Mon', 'mon'] }))).toBe('Each option once.')
    expect(setupProblem(setupInput({ ...f, prompt: ' ' }))).toBe('Write a question for everyone.')
    expect(setupInput({ ...f, kind: 'scale', minLabel: 'Low' })).toMatchObject({
      config: { min: 0, max: 10, minLabel: 'Low', maxLabel: null },
    })
    expect(setupInput({ ...f, kind: 'words', durationMs: 60_000 })).toMatchObject({
      config: { maxWords: 3 },
      durationMs: 60_000,
    })
  })

  it('the recap: one line per activity of the window, oldest first, aggregates only', () => {
    const sum = (
      a: Partial<LiveActivity>,
      results: ActivitySummary['results'],
      answered = 4,
    ): ActivitySummary => ({
      activity: activity(a),
      answered,
      results,
    })
    const list: ActivitySummary[] = [
      sum(
        { id: 'act_bbbbbbbbbbbbbbbb', status: 'revealed', createdAt: '2026-10-18T11:00:00.000Z' },
        { kind: 'poll', answered: 4, counts: [1, 3] },
      ),
      sum(
        {
          id: 'act_aaaaaaaaaaaaaaaa',
          kind: 'scale',
          prompt: 'Confident?',
          config: { min: 1, max: 5, minLabel: null, maxLabel: null },
          status: 'revealed',
          createdAt: '2026-10-18T10:00:00.000Z',
        } as Partial<LiveActivity>,
        { kind: 'scale', answered: 4, counts: [0, 0, 2, 2, 0], mean: 3.5, median: 3.5 },
      ),
      sum({ id: 'act_cccccccccccccccc', status: 'cancelled' }, null),
      sum(
        {
          id: 'act_dddddddddddddddd',
          kind: 'words',
          prompt: 'One word?',
          config: { maxWords: 3 },
          status: 'revealed',
          createdAt: '2026-10-18T12:00:00.000Z',
        } as Partial<LiveActivity>,
        { kind: 'words', answered: 4, words: [{ text: 'Agile', count: 3 }], distinct: 1, hidden: 0 },
      ),
      sum({ id: 'act_eeeeeeeeeeeeeeee', status: 'closed', createdAt: '2026-10-18T09:00:00.000Z' }, null, 2),
    ]
    expect(sectionOf('activities', list, null)?.lines.map((l) => l.text)).toEqual([
      'Which day?: 2 answers (results not revealed).',
      'Confident?: 4 answers, average 3.5 · median 3.5 (1 to 5).',
      'Which day?: 4 answers. Fri 3, Mon 1.',
    ])
    expect(sectionOf('word-clouds', list, null)).toEqual({
      id: 'word-clouds',
      title: 'Word clouds',
      lines: [{ text: 'One word?: 4 answers. Top words: Agile 3.' }],
    })
    expect(sectionOf('activities', list, Date.parse('2026-10-18T10:30:00.000Z'))?.lines).toHaveLength(1)
    expect(sectionOf('word-clouds', [], null)).toBeNull()
    for (const s of list) expect(recapLine(s) ?? '').not.toMatch(/usr_/)
  })

  it('the entry says what is going on', () => {
    const snap = (over: Record<string, unknown>) =>
      ({ activity: activity(), status: 'open', answered: 3, myAnswer: null, ...over }) as never
    expect(entryWords(snap({ activity: null, status: null }), true)).toEqual({
      label: 'Poll or word cloud',
      meta: 'Start',
    })
    expect(entryWords(snap({}), false)).toEqual({ label: 'Answer the poll', meta: 'Open · 3 answers' })
    expect(entryWords(snap({}), true).label).toBe('Poll')
    expect(entryWords(snap({ status: 'revealed' }), false)).toEqual({ label: 'Poll results', meta: '' })
  })
})
