// Wave L (W2, L2-3): Wrap up and Catch me up on the in-memory board of ../ported/test-kit.ts.
//  - With AI off the recap has no AI sections and makes no /ai request; with AI on it is one 'recap' run (panel).
//  - "Add as Recap frame" is one transact (the notes' frame membership folded into the same undo step), and one
//    undo removes the frame and everything in it; the AI parts carry the run, the room's results do not.
//  - A citation click only moves this tab's camera: the push counter stays at 0.
//  - The Markdown matches the golden file (recap.golden.md) and is bounded at 20 KB.
//  - Catch me up's window: the previous visit on this device, else 24 h, also when localStorage throws.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportGate } from '../../canvas-ux/ported/export-gate.ts'
import { showSources } from '../ported/ask.ts'
import { aiKindWord, aiOf } from '../ported/provenance.ts'
import { AI_ON, aiKit, note, renderIn } from '../ported/test-kit.ts'
import { applyRecap } from './apply.ts'
import { RECAP_MARKDOWN_MAX_BYTES, recapMarkdown } from './markdown.ts'
import type { RecapPlan } from './plan.ts'
import { AiRecapOverlay } from './RecapPanel.tsx'
import { aiRecap, runRecap } from './recap.ts'
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
    // and wholly shown: in the view already, or this tab's camera goes to it (never a write)
    const inside =
      f.x >= v.x && f.y >= v.y && f.x + f.width <= v.x + v.width && f.y + f.height <= v.y + v.height
    if (!inside)
      expect(k.canvas.viewport.zoomTo).toHaveBeenCalledWith(
        expect.objectContaining({ x: f.x, y: f.y, width: f.width, height: f.height }),
        expect.objectContaining({ maxZoom: 1 }),
      )
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
    // out of the view (x -1000..1000): this tab's camera is moved to it
    expect(k.canvas.viewport.zoomTo).toHaveBeenCalledWith(
      expect.objectContaining({ x: f.x, y: f.y }),
      expect.objectContaining({ maxZoom: 1 }),
    )
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
    plannedVsActual: [
      { name: 'Warm-up | intro', plannedMin: 10, actualMin: 12 },
      { name: 'Brainstorm', plannedMin: null, actualMin: 25 },
    ],
    windowFrom: null,
    runId: RUN,
  }

  it('matches the golden file', () => {
    const golden = readFileSync(new URL('./recap.golden.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(recapMarkdown(plan)).toBe(golden)
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
