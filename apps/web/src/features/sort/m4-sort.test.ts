// Wave M (W4): what the sort feature's AI paths show before they write.
//  - M4-2: an AI answer is always previewed, whatever its size: a lens sort of three notes and a 2x2 of four notes
//    (which moved at once before) show the preview first, and nothing is written until Apply; Discard writes nothing.
//    A deterministic sort of three notes still goes straight on (no AI chose anything).
//  - M4-1: the preview names what there is to judge: the columns with their notes, the new 2x2's squares and its
//    axis words.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { AiResult } from '@draftroom/contracts'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AiPreviewPlan } from '../ai/ported/public.ts'
import { placeOnMatrix, sortByLens } from './ai.ts'
import { setSortDeps } from './deps.ts'
import { sortBy } from './run.ts'
import { type El, fakeCanvas, fakeCtx, frameEl, noteEls } from './test-kit.ts'

beforeAll(() => {
  installServerTextMetrics()
})
afterEach(() => setSortDeps(null))

const RUN = 'air_0123456789ABCDEFGHIJ'
const ref = (id: string) => `shape:${id}`
const common = { truncated: false, budget: null, runId: RUN }

function board(n: number): El[] {
  const els: El[] = [frameEl('f1', 0, 0, 1600, 900, 'Ideas')]
  for (let i = 0; i < n; i++)
    els.push(
      ...noteEls(`n${i}`, 60 + (i % 3) * 230, 120 + Math.floor(i / 3) * 230, {
        frameId: 'f1',
        ...(i % 2 ? { fill: '#a6d8f3' } : {}),
      }),
    )
  return els
}
const nids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`)

/** Stands in for the AI and the preview: what the preview was shown, and how many steps were written by then. */
function deps(answer: AiResult, choice: 'apply' | 'discard', f: ReturnType<typeof fakeCanvas>) {
  const shown: { plan: AiPreviewPlan; stepsThen: number }[] = []
  setSortDeps({
    runAi: async () => answer,
    showAiPreview: async (_ctx, plan) => {
      shown.push({ plan, stepsThen: f.steps.length })
      return choice
    },
  })
  return shown
}

const lensAnswer: AiResult = {
  action: 'sort',
  lens: 'when',
  themes: [
    { name: 'Sooner', noteIds: ['n0', 'n1'].map(ref) },
    { name: 'Later', noteIds: ['n2'].map(ref) },
  ],
  ...common,
}

const AXES = [
  { name: 'Effort', low: 'Low', high: 'High' },
  { name: 'Impact', low: 'Low', high: 'High' },
] as const
const scoreAnswer: AiResult = {
  action: 'score',
  axes: [AXES[0], AXES[1]],
  scores: nids(4).map((id, i) => ({ id: ref(id), x: i % 2 ? 4 : -4, y: i < 2 ? 4 : -4 })),
  ...common,
}

describe('every AI answer goes through the preview (M4-2)', () => {
  it('a lens sort of three notes is shown first, its columns named with their notes; nothing is written until Apply', async () => {
    const f = fakeCanvas(board(3))
    const shown = deps(lensAnswer, 'apply', f)
    const out = await sortByLens(fakeCtx(f.canvas).ctx, 'when', nids(3))
    expect(out.status).toBe('applied')
    expect(shown).toHaveLength(1)
    expect(shown[0]?.stepsThen).toBe(0)
    expect(shown[0]?.plan.groups).toEqual([
      { name: 'Sooner', count: 2 },
      { name: 'Later', count: 1 },
    ])
    expect(shown[0]?.plan.creates.map((c) => c.label)).toEqual(['Sooner', 'Later'])
    expect(f.steps).toHaveLength(1)
  })

  it('a 2x2 of four notes is shown first: the new frame, its axis words and its squares; Discard writes nothing', async () => {
    const f = fakeCanvas(board(4))
    const shown = deps(scoreAnswer, 'discard', f)
    const out = await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: nids(4), axes: [AXES[0], AXES[1]] })
    expect(out.status).toBe('discarded')
    expect(shown).toHaveLength(1)
    const plan = shown[0]?.plan
    expect(plan?.creates.filter((c) => c.kind === 'frame')).toHaveLength(1)
    expect(
      plan?.creates
        .filter((c) => c.kind === 'text')
        .map((c) => c.label)
        .sort(),
    ).toEqual(['Effort', 'High', 'High', 'Impact', 'Low', 'Low'])
    expect(plan?.groups?.map((g) => `${g.name} (${g.count})`)).toEqual([
      'High impact · Low effort (1)',
      'High impact · High effort (1)',
      'Low impact · Low effort (1)',
      'Low impact · High effort (1)',
    ])
    expect(f.steps).toEqual([])
  })

  it('Apply then writes the 2x2 in one step', async () => {
    const f = fakeCanvas(board(4))
    const shown = deps(scoreAnswer, 'apply', f)
    const out = await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: nids(4), axes: [AXES[0], AXES[1]] })
    expect(out.status).toBe('applied')
    expect(shown[0]?.stepsThen).toBe(0)
    expect(f.steps).toHaveLength(1)
  })

  it('a deterministic sort of three notes still goes straight on: no AI chose anything', async () => {
    const f = fakeCanvas(board(3))
    const shown = deps(lensAnswer, 'discard', f)
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', nids(3))
    expect(out.status).toBe('applied')
    expect(shown).toHaveLength(0)
  })
})
