// Wave L (W2, L2-3): Wrap up and Catch me up on the in-memory board of ../ported/test-kit.ts.
//  - With AI off the recap has no AI sections and makes no /ai request; with AI on it is one 'recap' run (panel).
//  - "Add as Recap frame" is one transact (the notes' frame membership folded into the same undo step), and one
//    undo removes the frame and everything in it; the AI parts carry the run, the room's results do not.
//  - A citation click only moves this tab's camera: the push counter stays at 0.
//  - The Markdown matches the golden file (recap.golden.md) and is bounded at 20 KB.
//  - Catch me up's window: the previous visit on this device, else 24 h, also when localStorage throws.
//  - Wave V (WS5): with the summary's switch on, the registered sources' sections (./sources.ts) are asked beside
//    the AI call, never through it (AI off: still no /ai request), and are in the panel, the Markdown (the golden
//    file) and the Recap frame with no AI provenance; with it off no source is asked.
import { readFileSync } from 'node:fs'
import { AI_RECAP_MAX_WINDOW_MS } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportGate } from '../../canvas-ux/ported/export-gate.ts'
import { LIVE_FLAG_KEYS } from '../../live/index.ts'
import { aiAnswer, askBoard, showSources, WHOLE_BOARD } from '../ported/ask.ts'
import { aiKindWord, aiOf } from '../ported/provenance.ts'
import {
  applyRemoval,
  noteCreated,
  recordedRunOf,
  removalPlan,
  removedText,
  settleRecords,
} from '../ported/remove.ts'
import { aiPanel } from '../ported/runtime.ts'
import { AI_ON, aiKit, note, renderIn } from '../ported/test-kit.ts'
import { revealResult } from '../reveal.ts'
import { applyRecap } from './apply.ts'
import { mdText, RECAP_MARKDOWN_MAX_BYTES, recapMarkdown } from './markdown.ts'
import {
  RECAP_SECTION_LINE_MAX,
  type RecapPlan,
  recapIsEmpty,
  recapPlan,
  recapSourceSections,
  recapWhen,
} from './plan.ts'
import { AiRecapOverlay } from './RecapPanel.tsx'
import { aiRecap, inSelection, runRecap } from './recap.ts'
import { type RecapSourceInput, type RecapSourceSpec, registerRecapSource } from './sources.ts'
import {
  catchUpSince,
  DAY_MS,
  firstEditToday,
  lastVisitKey,
  noteVisit,
  readLastVisit,
  resetVisits,
  sessionSince,
  writeLastVisit,
} from './window.ts'

const RUN = 'air_0123456789ABCDEFabcd'
/** the test kit's board id */
const BOARD_ID = 'b-kit0000001'
const NOW = Date.UTC(2026, 9, 8, 16, 0, 0)

const recapAnswer = {
  action: 'recap',
  title: 'Launch workshop',
  summary: 'We picked the summer beach screenings and agreed who does what.',
  decisions: [{ text: 'Lead with the beach screenings', ids: ['shape:n1'] }],
  actions: [
    { task: 'Book the beach venue', owner: 'Sam', ids: ['shape:n1'] },
    { task: 'Draft the trailer brief', owner: null, ids: ['shape:n2'] },
  ],
  questions: [{ text: 'Who signs off the budget?', ids: ['shape:n3'] }],
  topVoted: [
    { id: 'shape:n1', votes: 3, rank: 1 },
    { id: 'shape:n2', votes: 1, rank: 2 },
  ],
  windowFrom: NOW - 3_600_000,
  truncated: false,
  budget: null,
  runId: RUN,
}

const board = () => [
  ...note('n1', 0, 0, 'Summer beach screenings'),
  ...note('n2', 300, 0, 'Solstice trailer drop'),
  ...note('n3', 600, 0, 'Budget sign-off'),
]

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  resetVisits()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Wrap up', () => {
  it('with AI off the recap is the non-AI sections only, says so, and makes no /ai request', async () => {
    const k = aiKit(board(), {
      status: { ...AI_ON, enabled: false, reason: 'board-off', canSummarize: false },
    })
    const state = await runRecap(k.ctx, 'session', NOW)
    expect(k.requests).toEqual([])
    expect(state?.plan?.ai).toBe(false)
    expect(state?.plan?.aiNote).toBe('Without AI: AI is off on this board.')
    expect(state?.plan?.headline).toBeNull()
    expect(state?.plan?.decisions).toEqual([])
    expect(state?.plan?.actions).toEqual([])
    expect(state?.plan?.questions).toEqual([])
    expect(k.pushes).toEqual([])
  })

  it('with AI on it is one recap run (panel, since the session began) and the plan joins the room’s results', async () => {
    const k = aiKit(board())
    k.answer(recapAnswer)
    const state = await runRecap(k.ctx, 'session', NOW)
    expect(k.requests).toHaveLength(1)
    expect(k.requests[0]?.body).toMatchObject({ action: 'recap', mode: 'panel', scope: { kind: 'since' } })
    const plan = state?.plan
    expect(plan?.ai).toBe(true)
    expect(plan?.headline).toContain('beach screenings')
    expect(plan?.topVoted).toEqual([
      { ref: 'shape:n1', label: 'Summer beach screenings', votes: 3, rank: 1 },
      { ref: 'shape:n2', label: 'Solstice trailer drop', votes: 1, rank: 2 },
    ])
    expect(aiRecap(k.canvas).get()?.status).toBe('done')
    expect(k.pushes).toEqual([])
  })

  it('a citation click selects its notes and moves only this tab’s camera: the push counter stays at 0', async () => {
    const k = aiKit(board())
    k.answer(recapAnswer)
    const plan = (await runRecap(k.ctx, 'session', NOW))?.plan
    expect(showSources(k.canvas, plan?.questions[0]?.refs ?? [])).toBe(true)
    expect(k.canvas.selection).toEqual(['n3'])
    expect(k.canvas.viewport.zoomTo).toHaveBeenCalled()
    expect(k.pushes).toEqual([])
  })

  it('“Add as Recap frame” is one transact, and one undo removes the frame and everything in it', async () => {
    const k = aiKit(board())
    k.answer(recapAnswer)
    const plan: RecapPlan = {
      ...((await runRecap(k.ctx, 'session', NOW))?.plan as RecapPlan),
      // the run of show (W5 agendaActuals) as the presenter's tab recorded it
      plannedVsActual: [
        { name: 'Warm-up', plannedMin: 10, actualMin: 12 },
        { name: 'Brainstorm', plannedMin: 20, actualMin: 25 },
      ],
    }
    const before = JSON.stringify(k.live())
    const steps = k.steps()
    const made = applyRecap(k.canvas, plan, 'usr_ana')
    // one step: one transact, plus the notes' frame membership folded into it
    expect(k.pushes.filter((p) => !p.joined)).toHaveLength(1)
    expect(k.pushes.filter((p) => p.joined)).toHaveLength(1)
    expect(k.steps()).toBe(steps + 1)
    const frame = k.els.get(made.frameId)
    expect(frame?.type).toBe('frame')
    expect(frame?.name).toBe(plan.title)
    const inside = made.ids.slice(1).map((id) => k.els.get(id))
    for (const e of inside) expect(e?.frameId, String(e?.id)).toBe(made.frameId)
    const kinds = inside.map((e) => String((e?.customData as { lobby?: { kind?: string } })?.lobby?.kind))
    expect(kinds).toContain('ai-recap-heading')
    expect(kinds).toContain('ai-recap-item')
    // planned vs actual: a header row and two rows, each a rectangle with three cells, none of them AI
    expect(kinds.filter((x) => x === 'recap-table')).toHaveLength(1 + 3 * (1 + 3))
    const cells = inside.filter(
      (e) => String((e?.customData as { lobby?: { kind?: string } })?.lobby?.kind) === 'recap-table',
    )
    expect(cells.filter((e) => e?.type === 'rectangle')).toHaveLength(3)
    expect(cells.map((e) => e?.originalText).filter(Boolean)).toEqual(
      expect.arrayContaining([
        'Planned vs actual',
        'Warm-up',
        '10 min',
        '12 min',
        'Brainstorm',
        '20 min',
        '25 min',
      ]),
    )
    for (const e of cells) expect(aiOf(e as never)).toBeNull()
    // the room's own results carry no AI provenance
    const vote = inside.find((e) => String(e?.originalText ?? '').startsWith('1. Summer beach screenings'))
    expect(aiOf(vote as never)).toBeNull()
    expect(String((vote?.customData as { lobby?: { kind?: string } })?.lobby?.kind)).toBe('recap-item')
    // the action items are notes stamped with the run
    const notes = inside.filter((e) => e?.type === 'stickynote')
    expect(notes).toHaveLength(2)
    for (const n of notes) {
      expect(aiOf(n as never)).toEqual({ by: 'usr_ana', run: RUN })
      expect(aiKindWord(n as never)).toBe('recap-item')
    }
    expect(k.canvas.text.of(notes[0]?.id as string)).toBe('Book the beach venue\nOwner: Sam')
    k.undo()
    expect(JSON.stringify(k.live())).toBe(before)
  })

  it('on a board wider than the view the Recap frame lands where the person looks, clear of the notes, and is shown', async () => {
    // notes to x ≈ 9900; the view is the left end (x -1000..1000)
    const wide = [
      ...board(),
      ...note('far1', 5_000, 0, 'Far idea'),
      ...note('far2', 9_700, 300, 'Farther idea'),
    ]
    const k = aiKit(wide)
    k.answer(recapAnswer)
    const plan = (await runRecap(k.ctx, 'session', NOW))?.plan as RecapPlan
    const v = { ...k.canvas.viewport.get() }
    const made = applyRecap(k.canvas, plan, 'usr_ana')
    const f = k.els.get(made.frameId) as { x: number; y: number; width: number; height: number }
    const overlaps = (a: typeof f, b: typeof f) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    // in the view the person was looking at, not 240 units past the board's right end
    expect(overlaps(f, v)).toBe(true)
    expect(f.x).toBeLessThan(5_000)
    // clear of what was there
    for (const e of wide.filter((x) => x.type === 'stickynote'))
      expect(overlaps(f, e as typeof f), String(e.id)).toBe(false)
    // and wholly shown (M4-4: the panel reveals it once it has folded): in the view already, or this tab's camera
    // goes to it (never a write)
    const pushes = k.pushes.length
    const moved = await revealResult(k.canvas, [made.frameId], { now: true })
    const inside =
      f.x >= v.x && f.y >= v.y && f.x + f.width <= v.x + v.width && f.y + f.height <= v.y + v.height
    expect(moved).toBe(!inside)
    expect(k.pushes).toHaveLength(pushes)
    expect(k.pushes.filter((p) => !p.joined)).toHaveLength(1)
  })

  it('the camera goes to a Recap frame that is not wholly in view; a selection recap goes beside its frames', async () => {
    const frameEl = { id: 'fr', type: 'frame', x: 3_000, y: 2_000, width: 1_400, height: 900, name: 'Ideas' }
    const k = aiKit([frameEl as never, ...note('in1', 3_100, 2_100, 'Inside idea', { frameId: 'fr' })])
    k.canvas.select(['fr'])
    k.answer({ ...recapAnswer, windowFrom: null, topVoted: [] })
    const state = await runRecap(k.ctx, 'selection', NOW)
    expect(state?.about).toEqual(['fr'])
    const made = applyRecap(k.canvas, state?.plan as RecapPlan, 'usr_ana', state?.about)
    const f = k.els.get(made.frameId) as { x: number; y: number; width: number; height: number }
    // beside the frame it recaps (right of or below it), not inside it and not over it
    expect(k.els.get(made.frameId)?.frameId ?? null).toBeNull()
    expect(f.x >= 3_000 + 1_400 || f.y >= 2_000 + 900).toBe(true)
    expect(Math.min(Math.abs(f.x - 4_400), Math.abs(f.y - 2_900))).toBeLessThan(400)
    // applying moves no camera (M4-4: the panel reveals it); out of the view (x -1000..1000), the reveal moves this
    // tab's camera to it, centred, never above 100%
    expect(k.canvas.viewport.zoomTo).not.toHaveBeenCalled()
    expect(await revealResult(k.canvas, [made.frameId], { now: true })).toBe(true)
    const to = (
      k.canvas.viewport.set as unknown as { mock: { calls: [{ x: number; y: number; zoom: number }][] } }
    ).mock.calls[0]?.[0]
    expect(to?.zoom).toBeLessThanOrEqual(1)
    const view = k.canvas.viewport.screenRect()
    const cx = (to?.x ?? 0) + view.width / 2 / (to?.zoom ?? 1)
    const cy = (to?.y ?? 0) + view.height / 2 / (to?.zoom ?? 1)
    expect(Math.abs(cx - (f.x + f.width / 2))).toBeLessThan(view.width / 4 / (to?.zoom ?? 1))
    expect(Math.abs(cy - (f.y + f.height / 2))).toBeLessThan(view.height / 4 / (to?.zoom ?? 1))
  })

  it('without AI the frame is the room’s results only, with no AI provenance at all', async () => {
    const k = aiKit(board(), {
      status: { ...AI_ON, enabled: false, reason: 'board-off', canSummarize: false },
    })
    const plan: RecapPlan = {
      ...((await runRecap(k.ctx, 'session', NOW))?.plan as RecapPlan),
      topVoted: [{ ref: 'shape:n1', label: 'Summer beach screenings', votes: 2, rank: 1 }],
    }
    const made = applyRecap(k.canvas, plan, 'usr_ana')
    for (const id of made.ids) expect(aiOf(k.els.get(id) as never), id).toBeNull()
    const frameData = k.els.get(made.frameId)?.customData as { lobby?: { kind?: string } } | undefined
    expect(frameData?.lobby?.kind).toBe('recap')
  })
})

describe('Remove this AI result on a Recap frame', () => {
  /** An AI Recap frame with the table and the room's votes (no AI provenance), recorded and settled. */
  async function recapMade() {
    const k = aiKit(board())
    k.answer(recapAnswer)
    const plan: RecapPlan = {
      ...((await runRecap(k.ctx, 'session', NOW))?.plan as RecapPlan),
      plannedVsActual: [{ name: 'Warm-up', plannedMin: 10, actualMin: 12 }],
    }
    const made = applyRecap(k.canvas, plan, 'usr_ana')
    noteCreated(k.canvas, made.ids, 'usr_ana') // what watchAiRuns does with the step's created ids
    k.stamp(2_000)
    settleRecords(k.canvas)
    k.pushes.length = 0
    return { k, made }
  }

  it('removes the whole frame, the table and votes included, in one step; nothing is said to be changed', async () => {
    const { k, made } = await recapMade()
    // the table and the vote lines carry no AI provenance: they are part of the run as the frame's
    const plain = made.ids.filter((id) => !aiOf(k.els.get(id) as never))
    expect(plain.length).toBeGreaterThan(4)
    expect(recordedRunOf(k.canvas, plain[0] as string)).toBe(RUN)
    const plan = removalPlan(k.canvas, RUN)
    expect(plan?.kept).toEqual([])
    expect(plan?.held).toEqual([])
    expect([...(plan?.remove ?? [])].sort()).toEqual([...made.ids].sort())
    expect(applyRemoval(k.canvas, plan as NonNullable<typeof plan>)).toBe(made.ids.length)
    expect(k.pushes).toHaveLength(1)
    for (const id of made.ids) expect(k.els.get(id)?.isDeleted, id).toBe(true)
    expect(removedText(made.ids.length, 0, 0)).toBe(`Removed ${made.ids.length} AI-made items.`)
    k.undo()
    for (const id of made.ids) expect(k.els.get(id)?.isDeleted, id).toBe(false)
  })

  it('a note added to the frame later keeps the frame (and says why); a changed cell is kept as changed', async () => {
    const { k, made } = await recapMade()
    k.canvas.transact('later', (tx) => {
      ;(tx as { create(kind: string, p: Record<string, unknown>): string }).create('text', {
        id: 'later',
        x: 0,
        y: 0,
        text: 'Added after',
        frameId: made.frameId,
      })
    })
    // a step of its own: never part of the run
    expect(noteCreated(k.canvas, ['later'], 'usr_ana')).toBe(false)
    const cell = made.ids.find((id) => k.els.get(id)?.originalText === 'Warm-up') as string
    k.editText(cell, 'Warm-up (long)', 9_000)
    const plan = removalPlan(k.canvas, RUN)
    expect(plan?.kept).toEqual([cell])
    expect(plan?.held).toEqual([made.frameId])
    expect(plan?.remove).not.toContain(made.frameId)
    expect(plan?.remove).not.toContain('later')
    expect(removedText(plan?.remove.length ?? 0, 1, 1)).toBe(
      `Removed ${plan?.remove.length} AI-made items. Kept 1 item someone changed. Kept the frame: it holds other content.`,
    )
    expect(removedText(0, 0, 1)).toBe('Nothing removed. Kept the frame: it holds other content.')
  })
})

describe('Copy as Markdown under the export policy', () => {
  it('a person the policy limits gets no Copy (copying is exporting); an editor does', async () => {
    for (const [role, policy, want] of [
      ['viewer', 'editors', false],
      ['commenter', 'editors', false],
      ['viewer', 'everyone', true],
      ['editor', 'editors', true],
    ] as const) {
      const k = aiKit(board(), {
        status: { ...AI_ON, enabled: false, reason: 'board-off', canSummarize: false },
      })
      const ctx = k.ctx as unknown as {
        role: string
        board: { id: string }
        registries: Record<string, unknown>
      }
      ctx.role = role
      ctx.board = { ...ctx.board, id: `b-copy-${role}-${policy}` }
      ctx.registries = { ...ctx.registries, commands: new Map() }
      exportGate(ctx.board.id).policy.set(policy)
      await runRecap(k.ctx, 'session', NOW)
      const html = renderIn(k, AiRecapOverlay)
      expect(html, `${role} under ${policy}`).toContain('data-testid="recap-panel"')
      expect(html.includes('data-testid="recap-copy"'), `${role} under ${policy}`).toBe(want)
    }
  })
})

describe('Copy as Markdown', () => {
  const plan: RecapPlan = {
    title: 'Recap · 8 Oct',
    scope: 'session',
    scopeLabel: 'This session',
    sharedLabel: 'This session',
    ai: true,
    aiNote: null,
    headline: 'We picked the summer beach screenings and agreed who does what.',
    decisions: [{ text: 'Lead with the beach screenings', refs: ['shape:n1'] }],
    actions: [
      { task: 'Book the beach venue', owner: 'Sam', refs: ['shape:n1'] },
      { task: 'Draft the trailer brief', owner: null, refs: [] },
    ],
    questions: [{ text: 'Who signs off the budget?', refs: ['shape:n3'] }],
    topVoted: [
      { ref: 'shape:n1', label: 'Summer beach screenings', votes: 3, rank: 1 },
      { ref: 'shape:n2', label: 'Solstice trailer drop', votes: 1, rank: 2 },
    ],
    topVotedTitle: 'Top voted',
    plannedVsActual: [
      { name: 'Warm-up | intro', plannedMin: 10, actualMin: 12 },
      { name: 'Brainstorm', plannedMin: null, actualMin: 25 },
    ],
    // wave V: the registered sources' sections (the escaping of their words included)
    sections: [
      {
        id: 'activities',
        title: 'Polls and scales',
        lines: [
          { text: 'Which launch city? 14 answers: Lisbon 8, Oslo 6', ids: [] },
          { text: 'How ready are we (1-5)? 9 answers, mean 3.8', ids: ['c1'] },
        ],
      },
      {
        id: 'word-clouds',
        title: 'Word clouds',
        lines: [{ text: 'One word for the brief: *bold* 5, warm 3', ids: [] }],
      },
      { id: 'breakouts', title: 'Breakouts', lines: [{ text: '3 groups of 4, 15 min', ids: [] }] },
    ],
    windowFrom: null,
    runId: RUN,
  }

  it('matches the golden file', () => {
    const golden = readFileSync(new URL('./recap.golden.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(recapMarkdown(plan)).toBe(golden)
  })

  it('the board’s words stay words: links, images, tags, code, emphasis and leading markers are escaped', () => {
    const md = recapMarkdown({
      ...plan,
      headline: '# Not a heading',
      decisions: [{ text: 'See [the deck](https://x.example) ![pic](https://x.example/p.png)', refs: [] }],
      actions: [{ task: '<b>Bold</b> *now* `rm -rf` _under_', owner: '1. Sam', refs: [] }],
      questions: [{ text: '- a question \\ with a backslash', refs: [] }],
      topVoted: [{ ref: 'shape:n1', label: '[x](y)', votes: 2, rank: 1 }],
    })
    expect(md).toContain('\\# Not a heading')
    expect(md).toContain('- See \\[the deck\\](https://x.example) !\\[pic\\](https://x.example/p.png)')
    expect(md).toContain('- [ ] \\<b\\>Bold\\</b\\> \\*now\\* \\`rm -rf\\` \\_under\\_ (owner: 1\\. Sam)')
    expect(md).toContain('- \\- a question \\\\ with a backslash')
    expect(md).toContain('1. \\[x\\](y) (2 votes)')
    expect(md).not.toMatch(/[^\\]\[the deck\]\(/)
    expect(mdText('Plain words, kept as they are.')).toBe('Plain words, kept as they are.')
  })

  it('is bounded at 20 KB, cut at a whole line, and says so', () => {
    const big: RecapPlan = {
      ...plan,
      decisions: Array.from({ length: 400 }, (_, i) => ({
        text: `Decision ${i} ${'x'.repeat(120)}`,
        refs: [],
      })),
    }
    const md = recapMarkdown(big)
    expect(new TextEncoder().encode(md).length).toBeLessThanOrEqual(RECAP_MARKDOWN_MAX_BYTES)
    expect(md.trimEnd().endsWith('(cut to fit; the rest is on the board)')).toBe(true)
  })
})

describe('the recap window', () => {
  const store = () => {
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

  it('Catch me up: the visit before this one on this device, else the last 24 hours', () => {
    const s = store()
    expect(catchUpSince('b-1', NOW, s)).toBe(NOW - DAY_MS)
    writeLastVisit('b-1', NOW - 5 * 3_600_000, s)
    noteVisit('b-1', NOW, s) // this open: the previous visit is kept for this page, now is stored
    expect(s.m.get(lastVisitKey('b-1'))).toBe(String(NOW))
    expect(catchUpSince('b-1', NOW + 1_000, s)).toBe(NOW - 5 * 3_600_000)
  })

  it('with localStorage throwing (blocked, private mode) it falls back to 24 hours and never throws', () => {
    expect(readLastVisit('b-2', throwing)).toBeNull()
    expect(writeLastVisit('b-2', NOW, throwing)).toBe(false)
    expect(() => noteVisit('b-2', NOW, throwing)).not.toThrow()
    expect(catchUpSince('b-2', NOW, throwing)).toBe(NOW - DAY_MS)
    expect(catchUpSince('b-3', NOW, null)).toBe(NOW - DAY_MS)
  })

  it('This session: the run of show’s start, else the first server-stamped edit today, else midnight', () => {
    const today = new Date(NOW)
    today.setHours(0, 0, 0, 0)
    const els = [
      {
        id: 'a',
        customData: { lobbyServer: { createdAt: today.getTime() - 1_000, lastEditedAt: NOW - 7_200_000 } },
      },
      { id: 'b', customData: { lobbyServer: { createdAt: NOW - 3_600_000, lastEditedAt: NOW - 3_600_000 } } },
    ] as never[]
    expect(firstEditToday(els, NOW)).toBe(NOW - 7_200_000)
    expect(sessionSince(els, NOW, null)).toBe(NOW - 7_200_000)
    expect(sessionSince(els, NOW, [{ actualMs: 600_000 }, { actualMs: 1_200_000 }])).toBe(NOW - 1_800_000)
    expect(sessionSince([], NOW, null)).toBe(today.getTime())
  })
})

describe('what a recap says it covers', () => {
  const OFF = { ...AI_ON, enabled: false, reason: 'board-off' as const, canSummarize: false }
  /** this device's localStorage */
  beforeEach(() => {
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => m.get(key) ?? null,
      setItem: (key: string, v: string) => void m.set(key, v),
      removeItem: (key: string) => void m.delete(key),
    })
  })

  it('Catch me up after a month away: the last 14 days, by date (AI off: clamped here; AI on: the api’s windowFrom)', async () => {
    writeLastVisit(BOARD_ID, NOW - 30 * DAY_MS)
    const off = aiKit(board(), { status: OFF })
    const plan = (await runRecap(off.ctx, 'catch-up', NOW))?.plan
    expect(plan?.windowFrom).toBe(NOW - AI_RECAP_MAX_WINDOW_MS)
    expect(plan?.scopeLabel).toBe(`Since ${recapWhen(NOW - AI_RECAP_MAX_WINDOW_MS)} (the last 14 days)`)
    expect(recapMarkdown(plan as RecapPlan)).toContain('(the last 14 days)')
    resetVisits()
    writeLastVisit(BOARD_ID, NOW - 30 * DAY_MS)
    const on = aiKit(board())
    on.answer({ ...recapAnswer, windowFrom: NOW - AI_RECAP_MAX_WINDOW_MS })
    const ai = (await runRecap(on.ctx, 'catch-up', NOW))?.plan
    // the api was asked for the whole absence and answered for the 14 days it allows
    expect(on.requests[0]?.body).toMatchObject({ scope: { kind: 'since', since: NOW - 30 * DAY_MS } })
    expect(ai?.scopeLabel).toBe(`Since ${recapWhen(NOW - AI_RECAP_MAX_WINDOW_MS)} (the last 14 days)`)
  })

  it('Catch me up names the last visit by date, else says it is the last 24 hours', async () => {
    writeLastVisit(BOARD_ID, NOW - 5 * 3_600_000)
    const k = aiKit(board(), { status: OFF })
    expect((await runRecap(k.ctx, 'catch-up', NOW))?.plan?.scopeLabel).toBe(
      `Since your last visit, ${recapWhen(NOW - 5 * 3_600_000)}`,
    )
    resetVisits()
    const fresh = aiKit(board(), { status: OFF })
    const ctx = fresh.ctx as unknown as { board: { id: string } }
    ctx.board = { ...ctx.board, id: 'b-never-here' }
    expect((await runRecap(fresh.ctx, 'catch-up', NOW))?.plan?.scopeLabel).toBe(
      `Since ${recapWhen(NOW - DAY_MS)} (the last 24 hours)`,
    )
  })

  it('the visit time stays in the private panel: the Recap frame and the Markdown say only "Since your last visit"', async () => {
    // wave N round 1: the time is the server's private visit marker; on the shared board it would be a read receipt
    const seen = NOW - 5 * 3_600_000
    writeLastVisit(BOARD_ID, seen)
    const k = aiKit(board(), { status: OFF })
    const plan = (await runRecap(k.ctx, 'catch-up', NOW))?.plan as RecapPlan
    expect(plan.scopeLabel).toBe(`Since your last visit, ${recapWhen(seen)}`)
    const made = applyRecap(k.canvas, plan, 'usr_ana')
    const words = made.ids
      .map(
        (id) =>
          k.canvas.items().find((e) => e.id === id) as {
            text?: string
            originalText?: string
            name?: string
          },
      )
      .flatMap((e) => [e?.text, e?.originalText, e?.name])
      .filter((t): t is string => typeof t === 'string')
    expect(words).toContain('Since your last visit')
    expect(words.join('\n')).not.toContain(recapWhen(seen))
    expect(recapMarkdown(plan)).toContain('_Since your last visit_')
    expect(recapMarkdown(plan)).not.toContain(recapWhen(seen))
  })

  it('a selection recap keeps only the votes on what is in the selected frames; this tab’s last vote is titled so', () => {
    const k = aiKit([
      { id: 'fa', type: 'frame', x: 0, y: 0, width: 1000, height: 600, name: 'A' } as never,
      ...note('in', 40, 40, 'Inside A', { frameId: 'fa' }),
      ...note('out', 2_000, 40, 'Outside'),
    ])
    const inScope = inSelection(k.canvas, ['fa'])
    expect(inScope('shape:in')).toBe(true)
    expect(inScope('shape:fa')).toBe(true)
    expect(inScope('shape:out')).toBe(false)
    const plan = recapPlan({
      scope: 'selection',
      now: NOW,
      result: null,
      aiNote: 'Without AI: AI is off on this board.',
      since: null,
      inScope,
      actuals: null,
      revealed: {
        results: [
          { ref: 'shape:out', count: 4, rank: 1 },
          { ref: 'shape:in', count: 2, rank: 2 },
        ],
      },
      textOf: (ref) => k.canvas.text.of(ref.replace(/^shape:/, '')),
    })
    expect(plan.topVoted.map((v) => v.ref)).toEqual(['shape:in'])
    expect(plan.topVotedTitle).toBe('Top voted (last vote)')
    expect(recapMarkdown(plan)).toContain('## Top voted (last vote)')
  })
})

describe('one private panel at a time', () => {
  it('a recap closes an open answer and summary; a question closes the recap', async () => {
    const k = aiKit(board())
    k.answer({
      action: 'ask',
      answer: 'Summer [1].',
      found: 'yes',
      citations: [{ ids: ['shape:n1'] }],
      truncated: false,
      budget: null,
      runId: RUN,
    })
    await askBoard(k.ctx, 'Summer?', WHOLE_BOARD)
    expect(aiAnswer(k.canvas).get()?.status).toBe('done')
    aiPanel(k.canvas).set({
      summary: 'S',
      about: 'x',
      truncated: false,
      runId: null,
      target: WHOLE_BOARD,
      opener: null,
    })
    k.answer(recapAnswer)
    await runRecap(k.ctx, 'session', NOW)
    expect(aiRecap(k.canvas).get()?.status).toBe('done')
    expect(aiAnswer(k.canvas).get()).toBeNull()
    expect(aiPanel(k.canvas).get()).toBeNull()
    k.answer({
      action: 'ask',
      answer: 'Winter.',
      found: 'yes',
      citations: [],
      truncated: false,
      budget: null,
      runId: RUN,
    })
    await askBoard(k.ctx, 'Winter?', WHOLE_BOARD)
    expect(aiRecap(k.canvas).get()).toBeNull()
    expect(aiAnswer(k.canvas).get()?.question).toBe('Winter?')
  })
})

describe('the session summary (wave V): the registered sources in Wrap up', () => {
  const AI_OFF = { status: { ...AI_ON, enabled: false, reason: 'board-off' as const, canSummarize: false } }
  const cleanups: (() => void)[] = []
  /** the summary's web switch, as a dev-auth page sets it (features/live/flags.ts) */
  const summary = (on: boolean) => {
    const store = new Map<string, string>(on ? [[LIVE_FLAG_KEYS.summary, '1']] : [])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    })
  }
  const polls = (seen: RecapSourceInput[] = []): RecapSourceSpec => ({
    id: 'activities',
    order: 10,
    collect: async (input) => {
      seen.push(input)
      return {
        id: 'activities',
        title: 'Polls and scales',
        lines: [{ text: 'Which launch city? 14 answers: Lisbon 8, Oslo 6' }, { text: '   ' }],
      }
    },
  })
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })
  /** the panel as the board page draws it (a commands registry without the export command) */
  const panel = (k: ReturnType<typeof aiKit>) => {
    const ctx = k.ctx as unknown as { registries: Record<string, unknown> }
    ctx.registries = { ...ctx.registries, commands: new Map() }
    return renderIn(k, AiRecapOverlay)
  }

  it('with the switch on and AI off, the sources sections are in the plan, the panel, the Markdown and the frame, and no /ai request is made', async () => {
    summary(true)
    const seen: RecapSourceInput[] = []
    cleanups.push(registerRecapSource(polls(seen)))
    cleanups.push(
      registerRecapSource({
        id: 'breakouts',
        order: 30,
        collect: async () => ({
          id: 'breakouts',
          title: 'Breakouts',
          lines: [{ text: '3 groups of 4, 15 min' }],
        }),
      }),
    )
    const k = aiKit(board(), AI_OFF)
    const state = await runRecap(k.ctx, 'session', NOW)
    expect(k.requests).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ scope: 'session', now: NOW })
    expect(seen[0]?.ctx).toBe(k.ctx)
    const plan = state?.plan as RecapPlan
    expect(plan.ai).toBe(false)
    expect(plan.sections).toEqual([
      {
        id: 'activities',
        title: 'Polls and scales',
        lines: [{ text: 'Which launch city? 14 answers: Lisbon 8, Oslo 6', ids: [] }],
      },
      { id: 'breakouts', title: 'Breakouts', lines: [{ text: '3 groups of 4, 15 min', ids: [] }] },
    ])
    expect(recapIsEmpty(plan)).toBe(false)
    const html = panel(k)
    expect(html).toContain('data-testid="recap-source-activities"')
    expect(html).toContain('data-testid="recap-source-breakouts"')
    expect(html).toContain('Which launch city? 14 answers: Lisbon 8, Oslo 6')
    expect(html).not.toContain('data-testid="recap-empty"')
    const md = recapMarkdown(plan)
    expect(md).toContain('## Polls and scales\n- Which launch city? 14 answers: Lisbon 8, Oslo 6\n')
    expect(md).toContain('## Breakouts\n- 3 groups of 4, 15 min\n')
    // collecting, drawing and copying write nothing
    expect(k.pushes).toEqual([])
    const made = applyRecap(k.canvas, plan, 'usr_ana')
    const texts = made.ids.map((id) => k.els.get(id)).filter((e) => e?.type === 'text')
    const words = texts.map((e) => String(e?.originalText ?? ''))
    expect(words).toContain('Polls and scales')
    expect(words).toContain('• Which launch city? 14 answers: Lisbon 8, Oslo 6')
    expect(words).toContain('• 3 groups of 4, 15 min')
    for (const id of made.ids) expect(aiOf(k.els.get(id) as never), id).toBeNull()
  })

  it('with AI on, the sources run beside the one recap call (never through it), and a failing source is left out', async () => {
    summary(true)
    cleanups.push(registerRecapSource(polls()))
    cleanups.push(
      registerRecapSource({
        id: 'word-clouds',
        order: 20,
        collect: async () => {
          throw new Error('down')
        },
      }),
    )
    const k = aiKit(board())
    k.answer(recapAnswer)
    const state = await runRecap(k.ctx, 'session', NOW)
    expect(k.requests).toHaveLength(1)
    expect(k.requests[0]?.body).toMatchObject({ action: 'recap' })
    expect(state?.plan?.ai).toBe(true)
    expect(state?.plan?.sections.map((s) => s.id)).toEqual(['activities'])
  })

  it('with the switch off no source is asked and the recap is as before wave V', async () => {
    summary(false)
    const seen: RecapSourceInput[] = []
    cleanups.push(registerRecapSource(polls(seen)))
    const k = aiKit(board(), AI_OFF)
    const state = await runRecap(k.ctx, 'session', NOW)
    expect(seen).toEqual([])
    expect(state?.plan?.sections).toEqual([])
    expect(panel(k)).not.toContain('recap-source-')
  })

  it('a recap replaced while its sources are out keeps none of them', async () => {
    summary(true)
    let release: () => void = () => {}
    cleanups.push(
      registerRecapSource({
        id: 'activities',
        order: 10,
        collect: (input) =>
          new Promise((resolve) => {
            void input
            release = () => resolve({ id: 'activities', title: 'Late', lines: [{ text: 'late' }] })
          }),
      }),
    )
    const k = aiKit(board(), AI_OFF)
    const first = runRecap(k.ctx, 'session', NOW)
    await Promise.resolve()
    aiRecap(k.canvas).set(null) // closed
    release()
    expect(await first).toBeNull()
    expect(aiRecap(k.canvas).get()).toBeNull()
  })

  it('the sections are plain one-line words, cut to their bounds, each source once, empty ones left out', () => {
    const long = 'x'.repeat(RECAP_SECTION_LINE_MAX + 50)
    expect(
      recapSourceSections([
        {
          id: 'activities',
          title: '  Polls\n and scales ',
          lines: [{ text: 'a\n b', ids: ['e1'] }, { text: long }],
        },
        { id: 'activities', title: 'Again', lines: [{ text: 'dropped: the same source twice' }] },
        { id: 'word-clouds', title: 'Word clouds', lines: [{ text: ' \n ' }] },
        { id: 'breakouts', title: '   ', lines: [{ text: 'no title' }] },
      ]),
    ).toEqual([
      {
        id: 'activities',
        title: 'Polls and scales',
        lines: [
          { text: 'a b', ids: ['e1'] },
          { text: `${'x'.repeat(RECAP_SECTION_LINE_MAX - 1)}…`, ids: [] },
        ],
      },
    ])
    expect(recapSourceSections(undefined)).toEqual([])
  })
})
