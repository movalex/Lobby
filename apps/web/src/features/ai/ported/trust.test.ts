// Wave L (W2, L2-1): the trust layer on the in-memory board of ./test-kit.ts.
//  - Group into themes goes through the preview: nothing is pushed until Apply; Discard pushes nothing; Try again
//    is a new call with a new run id; Apply is one push whose labels carry the run id.
//  - "Remove this AI result" deletes the run's elements in one push, skips an element whose words someone edited
//    (lastEditedAt moved) or that someone moved (its version), never touches what was deleted meanwhile and never
//    revives anything; one undo brings back what it removed.
//  - The lens's hover line says who AI made it for and when, and leaves the name out under Hide note authors;
//    under reduced motion the outline stands still.
//  - The live shimmer of someone else's run: it shows on `ai.working`, clears on `ai.done`, and expires by itself
//    after 30 s without one; this tab's own run shows none.
import { AI_EVENTS, AI_WORKING_TTL_MS } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAi, runPublic } from './actions.ts'
import { applyNotes } from './apply.ts'
import { AiLensOverlay, aiLens, lensLine } from './lens.tsx'
import { aiPreview, previewOwnsEscape } from './preview.tsx'
import { aiOf } from './provenance.ts'
import { applyRemoval, noteCreated, removalPlan, removedText, settleRecords } from './remove.ts'
import { aiJob } from './runtime.ts'
import { selectionTarget } from './target.ts'
import { aiKit, note } from './test-kit.ts'
import {
  AiWorkingOverlay,
  addWorking,
  aiWorking,
  endWorking,
  isOwnRun,
  listenAiWorking,
  liveWorking,
} from './working.tsx'

const RUN_A = 'air_0123456789ABCDEFabcd'
const RUN_B = 'air_ZYXWVUTSRQponmlk9876'

/** A themes answer naming the four notes. */
const themesAnswer = (runId: string) => ({
  action: 'themes',
  themes: [
    { name: 'Summer', noteIds: ['shape:n1', 'shape:n2'] },
    { name: 'Winter', noteIds: ['shape:n3', 'shape:n4'] },
  ],
  truncated: false,
  budget: null,
  runId,
})

const four = () => [
  ...note('n1', 0, 0, 'Beach screenings'),
  ...note('n2', 500, 400, 'Solstice drop'),
  ...note('n3', 900, 0, 'Snow teaser'),
  ...note('n4', 100, 700, 'Ski lodge premiere'),
]

function stubDocument(reduced: boolean) {
  vi.stubGlobal('document', {
    defaultView: {
      matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
    },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  })
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Group into themes goes through the preview (L2-1b)', () => {
  async function previewed(k: ReturnType<typeof aiKit>) {
    k.canvas.select(['n1', 'n2', 'n3', 'n4'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    await runAi(k.canvas, { action: 'themes' }, target)
    await vi.waitFor(() => expect(aiPreview(k.canvas).get()).not.toBeNull())
    return aiPreview(k.canvas).get()
  }

  it('shows where the notes go and pushes nothing until Apply; Apply is one push stamped with the run', async () => {
    const k = aiKit(four())
    k.answer(themesAnswer(RUN_A))
    const entry = await previewed(k)
    expect(entry?.plan.runId).toBe(RUN_A)
    expect(entry?.plan.summary).toBe('Moves 4 notes into 2 themes')
    expect(entry?.plan.moves.map((m) => m.id).sort()).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(entry?.plan.creates.filter((c) => c.kind === 'text')).toHaveLength(2)
    expect(k.pushes).toEqual([])
    entry?.choose('apply')
    await vi.waitFor(() => expect(k.pushes).toHaveLength(1))
    const labels = k.live().filter((e) => aiOf(e as never)?.run === RUN_A)
    expect(labels).toHaveLength(2)
    expect(k.steps()).toBe(1)
  })

  it('Discard pushes nothing; Try again is a new call with a new run id', async () => {
    const k = aiKit(four())
    k.answer(themesAnswer(RUN_A), themesAnswer(RUN_B))
    const before = JSON.stringify(k.live())
    const first = await previewed(k)
    first?.choose('retry')
    await vi.waitFor(() => expect(aiPreview(k.canvas).get()?.plan.runId).toBe(RUN_B))
    expect(k.requests).toHaveLength(2)
    expect(k.requests[1]?.body.action).toBe('themes')
    aiPreview(k.canvas).get()?.choose('discard')
    await vi.waitFor(() => expect(aiPreview(k.canvas).get()).toBeNull())
    expect(aiJob(k.canvas).get()).toBeNull()
    expect(k.pushes).toEqual([])
    expect(JSON.stringify(k.live())).toBe(before)
  })
})

describe('Remove this AI result (L2-1d)', () => {
  /** Three AI action items under a heading, as this tab writes them, then stamped and saved. */
  function made() {
    const k = aiKit(note('src', 0, 0, 'Plan the launch'))
    const target = { ...selectionTargetOf(k), ids: ['src'] }
    const ids = applyNotes(
      k.canvas,
      target,
      {
        heading: 'Action items',
        texts: ['Book venue', 'Write brief', 'Call Sam'],
        color: 'light-green',
        kind: 'action-item',
      },
      'usr_ana',
      RUN_A,
    )
    noteCreated(k.canvas, ids, 'usr_ana')
    k.stamp(2_000) // the server's stamps and versions come back
    settleRecords(k.canvas) // the tab's saves settled
    k.pushes.length = 0
    const notes = ids.filter((id) => k.els.get(id)?.type === 'stickynote')
    const heading = ids.find((id) => k.els.get(id)?.type === 'text') as string
    return { k, ids, notes, heading }
  }
  const selectionTargetOf = (k: ReturnType<typeof aiKit>) => {
    k.canvas.select(['src'])
    const t = selectionTarget(k.canvas)
    if (!t) throw new Error('no target')
    return t
  }

  it('keeps the note a colleague edited, removes the rest in one push, and one undo brings them back', () => {
    const { k, ids, notes } = made()
    const [edited, moved] = notes as [string, string]
    k.editText(edited, 'Book the bigger venue', 9_000) // B's words: lastEditedAt moves
    k.moveRemote(moved, 40) // B's move: the version moves
    const plan = removalPlan(k.canvas, RUN_A)
    expect(plan?.kept.sort()).toEqual([edited, moved].sort())
    expect(plan?.remove).toHaveLength(ids.length - 2)
    expect(applyRemoval(k.canvas, plan as NonNullable<typeof plan>)).toBe(ids.length - 2)
    expect(k.pushes).toHaveLength(1)
    expect(k.els.get(edited)?.isDeleted).toBe(false)
    expect(k.els.get(`${edited}.t`)?.isDeleted).toBe(false)
    expect(k.els.get(moved)?.isDeleted).toBe(false)
    for (const id of plan?.remove ?? []) expect(k.els.get(id)?.isDeleted).toBe(true)
    expect(removedText(ids.length - 2, 2)).toBe('Removed 2 AI-made items. Kept 2 items someone changed.')
    k.undo()
    for (const id of ids) expect(k.els.get(id)?.isDeleted).toBe(false)
  })

  it('skips an element whose lastEditedAt moved even at the same version, and never revives a deleted one', () => {
    const { k, notes } = made()
    const [stale, gone] = notes as [string, string]
    const label = k.els.get(`${stale}.t`)
    const cd = label?.customData as { lobbyServer: Record<string, unknown> }
    k.els.set(`${stale}.t`, {
      ...(label as NonNullable<typeof label>),
      customData: { lobbyServer: { ...cd.lobbyServer, lastEditedAt: 7_777 } },
    })
    // someone else deleted one meanwhile (a remote tombstone)
    k.els.set(gone, { ...(k.els.get(gone) as NonNullable<ReturnType<typeof k.els.get>>), isDeleted: true })
    const plan = removalPlan(k.canvas, RUN_A)
    expect(plan?.kept).toContain(stale)
    expect(plan?.remove).not.toContain(gone)
    expect(plan?.remove).not.toContain(stale)
    const version = k.els.get(gone)?.version
    if (plan) applyRemoval(k.canvas, plan)
    expect(k.els.get(gone)?.isDeleted).toBe(true)
    expect(k.els.get(gone)?.version).toBe(version)
  })

  it('knows only the runs this tab wrote; a themes run links to History instead', () => {
    const k = aiKit(note('n1', 0, 0, 'A'))
    expect(removalPlan(k.canvas, RUN_B)).toBeNull()
    k.canvas.transact('ai: group', (tx) => {
      ;(tx as { create(kind: string, p: Record<string, unknown>): string }).create('text', {
        id: 'lab',
        x: 0,
        y: -40,
        text: 'Summer',
        customData: { lobby: { ai: { by: 'usr_ana', run: RUN_B }, kind: 'ai-theme-label' } },
      })
    })
    noteCreated(k.canvas, ['lab'], 'usr_ana')
    expect(removalPlan(k.canvas, RUN_B)?.themes).toBe(true)
    // someone else's run is never recorded by this tab
    expect(noteCreated(k.canvas, ['lab'], 'usr_bo')).toBe(false)
  })
})

describe('the AI lens (L2-1c)', () => {
  const madeByAi = {
    id: 'x',
    type: 'stickynote',
    customData: {
      lobby: { ai: { by: 'usr_dana', run: RUN_A }, kind: 'ai-idea' },
      lobbyServer: {
        createdBy: { uid: 'usr_dana', name: 'Dana', guest: false },
        createdAt: Date.UTC(2026, 9, 8, 12),
      },
    },
  } as never

  it('says who AI made it for and when, and leaves the name out under Hide note authors', () => {
    const now = Date.UTC(2026, 9, 9, 12)
    expect(lensLine(madeByAi, { hideAuthors: false, now })).toBe('Made with AI for Dana · 8 Oct')
    expect(lensLine(madeByAi, { hideAuthors: true, now })).toBe('Made with AI · 8 Oct')
    expect(lensLine({ id: 'y', type: 'stickynote' } as never, { hideAuthors: false })).toBeNull()
  })

  it('outlines what AI made with the hover card; the board setting hides the name; still under reduced motion', () => {
    const els = [
      ...note('n1', 0, 0, 'AI idea', {
        customData: {
          lobby: { ai: { by: 'usr_dana', run: RUN_A }, kind: 'ai-idea' },
          lobbyServer: {
            createdBy: { uid: 'usr_dana', name: 'Dana', guest: false },
            createdAt: 1,
            lastEditedAt: 1,
          },
        },
      }),
      ...note('n2', 400, 0, 'A person’s note'),
    ]
    const k = aiKit(els)
    aiLens(k.canvas).set(true)
    k.setHovered('n1.t')
    stubDocument(false)
    let html = renderToStaticMarkup(createElement(AiLensOverlay, { ctx: k.ctx }))
    expect(html.match(/data-testid="ai-lens-box"/g)).toHaveLength(1)
    expect(html).toContain('data-id="n1"')
    expect(html).toContain('Made with AI for Dana')
    expect(html).toContain('data-motion="pulse"')
    k.setDoc('workshop', { hideNoteAuthors: true })
    stubDocument(true)
    html = renderToStaticMarkup(createElement(AiLensOverlay, { ctx: k.ctx }))
    expect(html).not.toContain('Dana')
    expect(html).toContain('Made with AI')
    expect(html).toContain('data-motion="still"')
    expect(k.pushes).toEqual([])
  })
})

describe('the live shimmer of someone else’s run (L2-1e)', () => {
  const working = (runId: string, name = 'Dana') => ({
    runId,
    name,
    action: 'themes' as const,
    rect: { x: 0, y: 0, w: 400, h: 300 },
  })

  it('pure: a run shows until its done, and expires by itself', () => {
    const list = addWorking([], working(RUN_A), 1_000)
    expect(list).toHaveLength(1)
    expect(endWorking(list, RUN_A)).toEqual([])
    expect(liveWorking(list, 1_000 + AI_WORKING_TTL_MS - 1)).toHaveLength(1)
    expect(liveWorking(list, 1_000 + AI_WORKING_TTL_MS)).toEqual([])
  })

  it('shows on ai.working, clears on ai.done, and clears itself 30 s later without one', () => {
    vi.useFakeTimers()
    const k = aiKit()
    const stop = listenAiWorking(k.ctx, () => false)
    k.emit(AI_EVENTS.working, working(RUN_A))
    expect(
      aiWorking(k.canvas)
        .get()
        .map((e) => e.runId),
    ).toEqual([RUN_A])
    stubDocument(false)
    const html = renderToStaticMarkup(createElement(AiWorkingOverlay, { ctx: k.ctx }))
    expect(html).toContain('Dana is using AI here')
    expect(html).toContain(`data-run="${RUN_A}"`)
    k.emit(AI_EVENTS.done, { runId: RUN_A })
    expect(aiWorking(k.canvas).get()).toEqual([])
    k.emit(AI_EVENTS.working, working(RUN_B))
    vi.advanceTimersByTime(AI_WORKING_TTL_MS - 1_000)
    expect(aiWorking(k.canvas).get()).toHaveLength(1)
    vi.advanceTimersByTime(2_000)
    expect(aiWorking(k.canvas).get()).toEqual([])
    // garbage and this tab's own run show nothing
    k.emit(AI_EVENTS.working, { runId: 'nope' })
    expect(aiWorking(k.canvas).get()).toEqual([])
    stop()
    const mine = aiKit()
    const stopMine = listenAiWorking(mine.ctx, () => true)
    mine.emit(AI_EVENTS.working, working(RUN_A, 'Ana'))
    expect(aiWorking(mine.canvas).get()).toEqual([])
    stopMine()
    expect(k.pushes).toEqual([])
  })
})

describe('the preview’s Escape (L2-1b)', () => {
  const doc = (dialog = false) => ({ querySelector: () => (dialog ? {} : null) }) as never
  const key = (target: unknown, over: Record<string, unknown> = {}) =>
    ({ key: 'Escape', defaultPrevented: false, isComposing: false, target, ...over }) as never
  const field = { tagName: 'TEXTAREA', isContentEditable: false }
  const inPanel = { tagName: 'INPUT', type: 'text', isContentEditable: false }
  const panel = { contains: (el: unknown) => el === inPanel } as never

  it('discards from the board, but leaves a field being typed in elsewhere, a dialog and a composition alone', () => {
    expect(previewOwnsEscape(key({ tagName: 'DIV', isContentEditable: false }), doc(), panel)).toBe(true)
    expect(previewOwnsEscape(key(null), doc(), panel)).toBe(true)
    expect(previewOwnsEscape(key(field), doc(), panel)).toBe(false)
    expect(previewOwnsEscape(key({ tagName: 'DIV', isContentEditable: true }), doc(), panel)).toBe(false)
    expect(previewOwnsEscape(key(inPanel), doc(), panel)).toBe(true)
    expect(previewOwnsEscape(key(null), doc(true), panel)).toBe(false)
    expect(previewOwnsEscape(key(null, { isComposing: true }), doc(), panel)).toBe(false)
    expect(previewOwnsEscape(key(null, { key: 'Enter' }), doc(), panel)).toBe(false)
  })
})

describe('this tab’s own run (L2-1e)', () => {
  const ev = (runId: string, name: string) => ({ runId, name, action: 'themes' as const, rect: null })

  it('a late ai.working of a run this tab was answered with shows no shimmer; a colleague’s does', async () => {
    const k = aiKit(four())
    k.answer(themesAnswer(RUN_A))
    k.canvas.select(['n1', 'n2', 'n3', 'n4'])
    const done = runPublic(k.ctx, {
      action: 'themes',
      shapeIds: ['shape:n1', 'shape:n2', 'shape:n3', 'shape:n4'],
    })
    await done
    // the job has ended: the name rule no longer applies, the run id does
    expect(aiJob(k.canvas).get()).toBeNull()
    expect(isOwnRun(k.canvas, 'Ana', ev(RUN_A, 'Ana'))).toBe(true)
    expect(isOwnRun(k.canvas, 'Ana', ev(RUN_B, 'Bo'))).toBe(false)
    expect(isOwnRun(k.canvas, 'Ana', ev(RUN_B, 'Ana'))).toBe(false)
  })
})
