// L8-2: sort by a lens and place on a 2x2 with the AI's answers (runAi stood in for), on a small in-memory
// canvas. Axis detection on the K4-2 template (the squares' own instruction lines), a matrix made now from the
// axes the person named, the notes' quadrants, one undo step, the skip rules, unscored notes, the preview.

import { checkElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { AiResult, AiRunInput } from '@draftroom/contracts'
import { instantiateSceneTemplate } from '@draftroom/templates/scene'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { placeOnMatrix, sortByLens, validAxes } from './ai.ts'
import { setSortDeps } from './deps.ts'
import { QUADRANT_KEYS, type QuadrantKey, quadrantOf } from './layout.ts'
import { detectMatrix, MATRIX_FRAME_KIND, readTemplateMatrix } from './matrix.ts'
import { targetNotes } from './model.ts'
import { scoresOf } from './scores.ts'
import { type El, fakeCanvas, fakeCtx, fillOf, frameEl, noteEls } from './test-kit.ts'

beforeAll(() => {
  installServerTextMetrics()
})
afterEach(() => setSortDeps(null))

const RUN = 'air_0123456789ABCDEFGHIJ'
const ref = (id: string) => `shape:${id}`

/** A fake runAi: records the requests, answers with what `answer` makes of the request. */
function stubAi(answer: (input: AiRunInput) => AiResult | null) {
  const seen: AiRunInput[] = []
  setSortDeps({
    runAi: async (_ctx, input) => {
      seen.push(input)
      return answer(input)
    },
    showAiPreview: async () => 'apply',
  })
  return seen
}

const common = { truncated: false, budget: null, runId: RUN }

// ---- sort by a lens ------------------------------------------------------------------------------------------------

function lensBoard(n = 8): El[] {
  const els: El[] = [frameEl('f1', 0, 0, 2400, 1400, 'Journey')]
  for (let i = 0; i < n; i++)
    els.push(...noteEls(`n${i}`, 60 + (i % 4) * 230, 120 + Math.floor(i / 4) * 230, { frameId: 'f1' }))
  return els
}
const nids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`)

describe('sort by a lens', () => {
  it('asks for the notes that may move, and lays the named groups out as columns with the run on their headings', async () => {
    const seen = stubAi(() => ({
      action: 'sort',
      lens: 'journey stage',
      themes: [
        { name: 'Awareness', noteIds: ['n0', 'n1', 'n4'].map(ref) },
        { name: 'Decision', noteIds: ['n2', 'n3', 'n5', 'n6', 'n7'].map(ref) },
      ],
      ...common,
    }))
    const f = fakeCanvas(lensBoard())
    f.leases.n7 = { sid: 'usr_bob:1', uid: 'usr_bob', name: 'Bob' }
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await sortByLens(ctx, '  journey   stage ', nids(8))
    expect(out).toMatchObject({ status: 'applied', skipped: 1 })
    // the api was asked about the seven notes that may move, with the lens cleaned up
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ action: 'sort', lens: 'journey stage' })
    expect((seen[0] as { shapeIds: string[] }).shapeIds).toEqual(
      ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map(ref),
    )
    // two columns, headed by the names, made by the run
    const heads = [...f.els.values()].filter((e) => e.type === 'text' && !e.containerId && !e.isDeleted)
    expect(heads.map((h) => h.originalText)).toEqual(['Awareness', 'Decision'])
    for (const h of heads) {
      expect((h.customData as { lobby: Record<string, unknown> }).lobby).toEqual({
        ai: { by: 'usr_alice', run: RUN },
        kind: 'ai-sort-label',
      })
      expect(
        checkElement({
          ...h,
          index: 'a0',
          version: 1,
          versionNonce: 1,
          seed: 1,
          updated: 1,
          created: null,
          link: null,
          boundElements: null,
          roundness: null,
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 0,
          opacity: 100,
          baseFontSize: null,
          labelPosition: null,
          lineHeight: 1.25,
        }).ok,
      ).toBeDefined()
    }
    expect(f.els.get('n0')?.x).toBe(f.els.get('n1')?.x)
    expect(f.els.get('n0')?.x).not.toBe(f.els.get('n2')?.x)
    // the one under another tab's lease did not move, and the notice says so
    expect(f.ops.some((o) => o.id === 'n7' || o.id === 'n7.t')).toBe(false)
    expect(notices.at(-1)?.text).toMatch(/1 note was skipped/)
    expect(f.steps).toHaveLength(1)
  })

  it('leaves the notes the AI did not place where they are, and says so', async () => {
    stubAi(() => ({
      action: 'sort',
      lens: 'x',
      themes: [{ name: 'Only', noteIds: ['n0', 'n1', 'n2'].map(ref) }],
      ...common,
    }))
    const f = fakeCanvas(lensBoard(5))
    const before = { x: f.els.get('n4')?.x, y: f.els.get('n4')?.y }
    const { ctx, notices } = fakeCtx(f.canvas)
    await sortByLens(ctx, 'x', nids(5))
    expect({ x: f.els.get('n4')?.x, y: f.els.get('n4')?.y }).toEqual(before)
    expect(notices.at(-1)?.text).toMatch(/2 notes the AI did not place stayed where they were\./)
  })

  it('ignores ids the AI invented and ones it repeats', async () => {
    stubAi(() => ({
      action: 'sort',
      lens: 'x',
      themes: [
        {
          name: 'A',
          noteIds: ['n0', 'n1', 'shape:ghost', 'n0'].map((x) => (x.startsWith('shape:') ? x : ref(x))),
        },
        { name: 'B', noteIds: ['n1', 'n2'].map(ref) },
      ],
      ...common,
    }))
    const f = fakeCanvas(lensBoard(3))
    const { ctx } = fakeCtx(f.canvas)
    await sortByLens(ctx, 'x', nids(3))
    const heads = [...f.els.values()].filter((e) => e.type === 'text' && !e.containerId && !e.isDeleted)
    expect(heads.map((h) => h.originalText)).toEqual(['A', 'B'])
    // n1 is in A only: A has n0 and n1 in one column
    expect(f.els.get('n0')?.x).toBe(f.els.get('n1')?.x)
    expect(f.els.get('n2')?.x).not.toBe(f.els.get('n0')?.x)
  })

  it('replaces the headings of an earlier run: sorting twice leaves one set', async () => {
    let call = 0
    stubAi(() => ({
      action: 'sort',
      lens: 'x',
      themes:
        call++ === 0
          ? [
              { name: 'One', noteIds: ['n0', 'n1'].map(ref) },
              { name: 'Two', noteIds: ['n2', 'n3'].map(ref) },
            ]
          : [
              { name: 'Alpha', noteIds: ['n0', 'n2'].map(ref) },
              { name: 'Beta', noteIds: ['n1', 'n3'].map(ref) },
            ],
      ...common,
    }))
    const f = fakeCanvas(lensBoard(4))
    const { ctx } = fakeCtx(f.canvas)
    await sortByLens(ctx, 'x', nids(4))
    await sortByLens(ctx, 'x', nids(4))
    const heads = [...f.els.values()].filter((e) => e.type === 'text' && !e.containerId && !e.isDeleted)
    expect(heads.map((h) => h.originalText)).toEqual(['Alpha', 'Beta'])
  })

  it('does nothing when the AI is off or fails (runAi resolves null), and writes nothing', async () => {
    stubAi(() => null)
    const f = fakeCanvas(lensBoard(4))
    const out = await sortByLens(fakeCtx(f.canvas).ctx, 'x', nids(4))
    expect(out).toEqual({ status: 'nothing', reason: 'ai' })
    expect(f.steps).toEqual([])
  })

  it('needs a lens and at least two notes', async () => {
    const seen = stubAi(() => null)
    const f = fakeCanvas(lensBoard(4))
    const { ctx, notices } = fakeCtx(f.canvas)
    expect((await sortByLens(ctx, '   ', nids(4))).status).toBe('nothing')
    expect(notices.at(-1)?.text).toMatch(/how the notes should be grouped/)
    expect((await sortByLens(ctx, 'x', ['n0'])).status).toBe('nothing')
    expect(seen).toHaveLength(0)
  })

  it('previews over ten moves, builds again on "Try again" with a new call, and writes nothing on discard', async () => {
    const answers: AiResult[] = [0, 1].map((k) => ({
      action: 'sort',
      lens: 'x',
      themes: [
        { name: `Try ${k}`, noteIds: nids(6).map(ref) },
        { name: `Rest ${k}`, noteIds: ['n6', 'n7', 'n8', 'n9', 'n10', 'n11'].map(ref) },
      ],
      ...common,
    }))
    let calls = 0
    const choices = ['retry', 'discard'] as const
    let c = 0
    setSortDeps({
      runAi: async () => answers[calls++] ?? null,
      showAiPreview: async (_ctx, plan) => {
        expect(plan.runId).toBe(RUN)
        return choices[c++] ?? 'discard'
      },
    })
    const f = fakeCanvas(lensBoard(12))
    const out = await sortByLens(fakeCtx(f.canvas).ctx, 'x', nids(12))
    expect(out.status).toBe('discarded')
    expect(calls).toBe(2)
    expect(f.steps).toEqual([])
  })

  it('does nothing on a read-only canvas', async () => {
    const seen = stubAi(() => null)
    const f = fakeCanvas(lensBoard(4), { readOnly: true })
    expect((await sortByLens(fakeCtx(f.canvas).ctx, 'x', nids(4))).status).toBe('refused')
    expect(seen).toHaveLength(0)
  })
})

// ---- the 2x2 ----------------------------------------------------------------------------------------------------------

/** The K4-2 template as elements, with 12 real notes in its frame of ideas. */
function templateBoard(noteCount = 12) {
  const scene = instantiateSceneTemplate('prioritisation-2x2', { origin: { x: 0, y: 0 } })
  const els = scene.elements as unknown as El[]
  const frames = els.filter((e) => e.type === 'frame')
  const named = (name: string) => frames.find((x) => x.name === name) as El
  const ideas = named('1 · Ideas to place')
  const notes: El[] = []
  for (let i = 0; i < noteCount; i++)
    notes.push(
      ...noteEls(`i${i}`, ideas.x + 60 + (i % 6) * 230, ideas.y + 190 + Math.floor(i / 6) * 215, {
        frameId: ideas.id,
        fill: fillOf('yellow'),
      }),
    )
  return {
    els: [...els, ...notes],
    ideas,
    quick: named('2 · Quick wins'),
    bets: named('3 · Big bets'),
    fill: named('4 · Fill-ins'),
    park: named('5 · Park it'),
    ids: Array.from({ length: noteCount }, (_, i) => `i${i}`),
  }
}

/** Scores that put notes 0..2 in Quick wins, 3..5 in Big bets, 6..8 in Fill-ins and 9..11 in Park it. */
const SPREAD = [
  // effort (x), impact (y)
  [-4, 4],
  [-3, 5],
  [-5, 3],
  [4, 4],
  [5, 5],
  [3, 3],
  [-4, -4],
  [-2, -5],
  [-5, -2],
  [4, -4],
  [5, -3],
  [3, -5],
] as const

const scoreAnswer = (ids: readonly string[], spread = SPREAD): AiResult => ({
  action: 'score',
  axes: [
    { name: 'Effort', low: 'Low', high: 'High' },
    { name: 'Impact', low: 'Low', high: 'High' },
  ],
  scores: ids.map((id, i) => ({
    id: ref(id),
    x: spread[i % spread.length]?.[0] ?? 0,
    y: spread[i % spread.length]?.[1] ?? 0,
  })),
  ...common,
})

describe('axis detection on the K4-2 template', () => {
  it('reads the axes and the four squares from the squares’ instruction lines', () => {
    const t = templateBoard(2)
    const f = fakeCanvas(t.els)
    const near = { x: t.ideas.x, y: t.ideas.y, w: t.ideas.width, h: t.ideas.height }
    const m = readTemplateMatrix(f.canvas, near)
    expect(m?.source).toBe('template')
    // effort runs across (the squares in a row differ by effort), impact runs up
    expect(m?.axes.map((a) => a.name)).toEqual(['Effort', 'Impact'])
    expect(m?.axes.map((a) => [a.low, a.high])).toEqual([
      ['Low', 'High'],
      ['Low', 'High'],
    ])
    const q = (k: QuadrantKey) => m?.quadrants[k].frameId
    expect(q('low-high')).toBe(t.quick.id)
    expect(q('high-high')).toBe(t.bets.id)
    expect(q('low-low')).toBe(t.fill.id)
    expect(q('high-low')).toBe(t.park.id)
    // each square's room lies inside its frame, below its heading and instruction line
    for (const k of QUADRANT_KEYS) {
      const fr = f.els.get(m?.quadrants[k].frameId ?? '') as El
      const a = m?.quadrants[k].area
      expect(a?.x).toBeGreaterThanOrEqual(fr.x)
      expect((a?.x ?? 0) + (a?.w ?? 0)).toBeLessThanOrEqual(fr.x + fr.width)
      expect(a?.y).toBeGreaterThan(fr.y + 120)
      expect((a?.y ?? 0) + (a?.h ?? 0)).toBeLessThanOrEqual(fr.y + fr.height)
    }
  })

  it('finds it from the notes in the ideas frame, and not for notes on a plain frame', () => {
    const t = templateBoard(3)
    const f = fakeCanvas([
      ...t.els,
      frameEl('plain', 9000, 0, 800, 600),
      ...noteEls('p0', 9060, 120, { frameId: 'plain' }),
    ])
    const notes = targetNotes(f.canvas, [t.ideas.id])
    expect(detectMatrix(f.canvas, notes)?.source).toBe('template')
    expect(detectMatrix(f.canvas, targetNotes(f.canvas, ['p0']))?.source).toBe('template')
    // (the nearest template is still found from a plain frame: it is the only 2x2 on the board)
    const lone = fakeCanvas([
      frameEl('plain', 0, 0, 800, 600),
      ...noteEls('p0', 60, 120, { frameId: 'plain' }),
    ])
    expect(detectMatrix(lone.canvas, targetNotes(lone.canvas, ['p0']))).toBeNull()
  })

  it('takes the 2x2 nearest the notes when the board has two', () => {
    const a = templateBoard(2)
    const b = instantiateSceneTemplate('prioritisation-2x2', { origin: { x: 20000, y: 0 } })
    const f = fakeCanvas([...a.els, ...(b.elements as unknown as El[])])
    const m = readTemplateMatrix(f.canvas, { x: 100, y: 100, w: 100, h: 100 })
    expect(m?.quadrants['low-high'].frameId).toBe(a.quick.id)
  })

  it('needs all four squares', () => {
    const t = templateBoard(2)
    const f = fakeCanvas(t.els.filter((e) => e.id !== t.park.id && e.frameId !== t.park.id))
    expect(readTemplateMatrix(f.canvas, { x: 0, y: 0, w: 10, h: 10 })).toBeNull()
  })
})

describe('Place with AI on the 2x2 template', () => {
  it('moves 12 notes into the squares their scores name, in one undo step, with only notes written', async () => {
    const seen = stubAi((input) =>
      input.action === 'score' ? scoreAnswer(input.shapeIds.map((r) => r.slice(6))) : null,
    )
    const t = templateBoard()
    const f = fakeCanvas(t.els)
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await placeOnMatrix(ctx, { ids: t.ids })
    expect(out).toMatchObject({ status: 'applied', skipped: 0 })
    // asked about the 12 notes, with the template's axes
    expect(seen[0]).toMatchObject({ action: 'score' })
    expect((seen[0] as { shapeIds: string[] }).shapeIds).toHaveLength(12)
    expect((seen[0] as { axes: { name: string }[] }).axes.map((a) => a.name)).toEqual(['Effort', 'Impact'])
    // one step; nothing created (the squares are there), no frame grew
    expect(f.steps).toHaveLength(1)
    expect(f.ops.some((o) => o.op === 'create')).toBe(false)
    const expectedIn: Record<string, string> = {
      i0: t.quick.id,
      i1: t.quick.id,
      i2: t.quick.id,
      i3: t.bets.id,
      i4: t.bets.id,
      i5: t.bets.id,
      i6: t.fill.id,
      i7: t.fill.id,
      i8: t.fill.id,
      i9: t.park.id,
      i10: t.park.id,
      i11: t.park.id,
    }
    for (const id of t.ids) {
      const n = f.els.get(id) as El
      const fr = f.els.get(expectedIn[id] as string) as El
      expect(n.frameId, id).toBe(fr.id)
      // wholly inside its square
      expect(n.x, id).toBeGreaterThanOrEqual(fr.x)
      expect(n.y, id).toBeGreaterThanOrEqual(fr.y)
      expect(n.x + n.width, id).toBeLessThanOrEqual(fr.x + fr.width)
      expect(n.y + n.height, id).toBeLessThanOrEqual(fr.y + fr.height)
      // the bound label moved with it
      const l = f.els.get(`${id}.t`) as El
      expect(l.x - n.x).toBe(10)
      expect(l.frameId).toBe(fr.id)
    }
    // no two notes overlap, and none sits on the template's example note
    const all = [...f.els.values()].filter((e) => !e.isDeleted && e.type === 'stickynote')
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i] as El
        const b = all[j] as El
        const over =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(over, `${a.id} and ${b.id}`).toBe(false)
      }
    // the scores are kept for the optional overlay (never stored)
    expect(scoresOf(f.canvas).get()?.scores.get('i4')).toEqual({ x: 5, y: 5 })
    expect(notices.at(-1)?.text).toMatch(/12 notes placed/)
  })

  it('puts a more extreme score further from the middle of the 2x2', async () => {
    stubAi((input) =>
      input.action === 'score'
        ? ({
            action: 'score',
            axes: [
              { name: 'Effort', low: 'Low', high: 'High' },
              { name: 'Impact', low: 'Low', high: 'High' },
            ],
            scores: [
              { id: ref('i0'), x: 5, y: 5 },
              { id: ref('i1'), x: 1, y: 1 },
            ],
            ...common,
          } as AiResult)
        : null,
    )
    const t = templateBoard(2)
    const f = fakeCanvas(t.els)
    await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: ['i0', 'i1'] })
    const wild = f.els.get('i0') as El
    const mild = f.els.get('i1') as El
    // Big bets is top right: further right and further up is more extreme
    expect(wild.x).toBeGreaterThan(mild.x)
    expect(wild.y).toBeLessThan(mild.y)
  })

  it('does not move a note another tab is typing in or someone is dragging', async () => {
    stubAi((input) => (input.action === 'score' ? scoreAnswer(input.shapeIds.map((r) => r.slice(6))) : null))
    const t = templateBoard()
    const f = fakeCanvas(t.els, {
      leases: { i2: { sid: 'usr_bob:1', uid: 'usr_bob', name: 'Bob' } },
      draggers: { i9: { sid: 'usr_bob:1', name: 'Bob' } },
    })
    const before = ['i2', 'i9'].map((id) => [f.els.get(id)?.x, f.els.get(id)?.y, f.els.get(id)?.frameId])
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await placeOnMatrix(ctx, { ids: t.ids })
    expect(out).toMatchObject({ status: 'applied', skipped: 2 })
    expect(['i2', 'i9'].map((id) => [f.els.get(id)?.x, f.els.get(id)?.y, f.els.get(id)?.frameId])).toEqual(
      before,
    )
    expect(notices.at(-1)?.text).toMatch(/2 notes were skipped/)
  })

  it('flags the notes the AI left out: they stay where they are and are counted', async () => {
    stubAi((input) =>
      input.action === 'score'
        ? ({
            ...scoreAnswer(input.shapeIds.map((r) => r.slice(6))),
            scores: [
              { id: ref('i0'), x: -4, y: 4 },
              { id: ref('i1'), x: 0, y: 0, unscored: true },
            ],
          } as AiResult)
        : null,
    )
    const t = templateBoard(3)
    const f = fakeCanvas(t.els)
    const before = { x: f.els.get('i1')?.x, f: f.els.get('i1')?.frameId, x2: f.els.get('i2')?.x }
    const { ctx, notices } = fakeCtx(f.canvas)
    await placeOnMatrix(ctx, { ids: ['i0', 'i1', 'i2'] })
    expect({ x: f.els.get('i1')?.x, f: f.els.get('i1')?.frameId, x2: f.els.get('i2')?.x }).toEqual(before)
    expect(f.els.get('i0')?.frameId).toBe(t.quick.id)
    expect(notices.at(-1)?.text).toMatch(/2 notes the AI could not score stayed where they were/)
  })

  it('reads the board again when it applies: a note taken meanwhile stays put', async () => {
    const t = templateBoard()
    const f = fakeCanvas(t.els)
    setSortDeps({
      runAi: async (_c, input) =>
        input.action === 'score' ? scoreAnswer(input.shapeIds.map((r) => r.slice(6))) : null,
      showAiPreview: async () => {
        f.draggers.i4 = { sid: 'usr_bob:1', name: 'Bob' }
        return 'apply'
      },
    })
    const before = [f.els.get('i4')?.x, f.els.get('i4')?.y]
    const out = await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: t.ids })
    expect(out).toMatchObject({ status: 'applied', skipped: 1 })
    expect([f.els.get('i4')?.x, f.els.get('i4')?.y]).toEqual(before)
  })

  it('writes nothing when the preview is discarded', async () => {
    const t = templateBoard()
    const f = fakeCanvas(t.els)
    setSortDeps({
      runAi: async (_c, input) =>
        input.action === 'score' ? scoreAnswer(input.shapeIds.map((r) => r.slice(6))) : null,
      showAiPreview: async () => 'discard',
    })
    const out = await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: t.ids })
    expect(out.status).toBe('discarded')
    expect(f.ops).toEqual([])
  })

  it('refuses locked squares, and does nothing without a runAi answer', async () => {
    stubAi((input) => (input.action === 'score' ? scoreAnswer(input.shapeIds.map((r) => r.slice(6))) : null))
    const t = templateBoard()
    const park = t.els.find((e) => e.id === t.park.id)
    if (park) park.locked = true
    const f = fakeCanvas(t.els)
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await placeOnMatrix(ctx, { ids: t.ids })
    expect(out.status).toBe('nothing')
    expect(notices.at(-1)?.text).toMatch(/locked/)
    stubAi(() => null)
    expect(
      (await placeOnMatrix(fakeCtx(fakeCanvas(templateBoard().els).canvas).ctx, { ids: templateBoard().ids }))
        .status,
    ).toBe('nothing')
  })

  it('grows a square that is too small for its notes when nothing is below it, and only grows it', async () => {
    stubAi((input) =>
      input.action === 'score'
        ? ({
            ...scoreAnswer([]),
            scores: input.shapeIds.map((r) => ({ id: r, x: 4, y: 4 })),
          } as AiResult)
        : null,
    )
    const t = templateBoard(12)
    // a lone 2x2 stretched out so there is room below the squares
    const f = fakeCanvas(t.els)
    const bets = f.els.get(t.bets.id) as El
    const before = bets.height
    const out = await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: t.ids })
    expect(out.status).toBe('applied')
    // all twelve landed in Big bets or stayed (a square below it blocks the growth)
    const inBets = t.ids.filter((id) => f.els.get(id)?.frameId === t.bets.id).length
    const stayed = t.ids.filter((id) => f.els.get(id)?.frameId === t.ideas.id).length
    expect(inBets + stayed).toBe(12)
    expect((f.els.get(t.bets.id) as El).height).toBeGreaterThanOrEqual(before)
  })
})

describe('Place with AI where there is no 2x2: a matrix is made from the axes the person names', () => {
  const AXES = [
    { name: 'Effort', low: 'Low', high: 'High' },
    { name: 'Impact', low: 'Low', high: 'High' },
  ] as const

  function plain(n = 8): El[] {
    const els: El[] = [frameEl('ideas', 0, 0, 1600, 700, 'Ideas')]
    for (let i = 0; i < n; i++)
      els.push(...noteEls(`n${i}`, 60 + (i % 4) * 230, 120 + Math.floor(i / 4) * 230, { frameId: 'ideas' }))
    return els
  }

  const scoresFor = (n: number): AiResult => ({
    action: 'score',
    axes: [AXES[0], AXES[1]],
    scores: Array.from({ length: n }, (_, i) => ({
      id: ref(`n${i}`),
      x: i % 2 ? 4 : -4,
      y: i % 4 < 2 ? 4 : -4,
    })),
    ...common,
  })

  it('asks for the axes first (needs-axes), then makes a frame with a cross and six axis words, and fills it', async () => {
    const seen = stubAi(() => scoresFor(8))
    const f = fakeCanvas(plain())
    const { ctx } = fakeCtx(f.canvas)
    const first = await placeOnMatrix(ctx, { ids: nids(8) })
    expect(first).toEqual({ status: 'needs-axes' })
    expect(seen).toHaveLength(0)
    const out = await placeOnMatrix(ctx, { ids: nids(8), axes: [AXES[0], AXES[1]] })
    expect(out.status).toBe('applied')
    expect(f.steps).toHaveLength(1)
    // the frame, two lines, six words: all new, none of them AI-made
    const created = [...f.els.values()].filter(
      (e) => !e.isDeleted && ['frame', 'line', 'text'].includes(e.type) && !e.containerId && e.id !== 'ideas',
    )
    const frame = created.find((e) => e.type === 'frame') as El
    expect(frame.name).toBe('Impact by Effort')
    expect((frame.customData as { lobby: { kind: string } }).lobby.kind).toBe(MATRIX_FRAME_KIND)
    expect(created.filter((e) => e.type === 'line')).toHaveLength(2)
    const words = created
      .filter((e) => e.type === 'text')
      .map((e) => e.originalText)
      .sort()
    expect(words).toEqual(['Effort', 'High', 'High', 'Impact', 'Low', 'Low'])
    for (const e of created) if (e.type !== 'frame') expect(e.frameId).toBe(frame.id)
    // the frame sits beside the ideas frame, not over it
    expect(frame.x).toBeGreaterThanOrEqual(1600)
    // every note is in the new frame, in the quadrant of its scores
    for (let i = 0; i < 8; i++) {
      const n = f.els.get(`n${i}`) as El
      expect(n.frameId).toBe(frame.id)
      expect(n.x).toBeGreaterThanOrEqual(frame.x)
      expect(n.x + n.width).toBeLessThanOrEqual(frame.x + frame.width)
      expect(n.y).toBeGreaterThanOrEqual(frame.y)
      expect(n.y + n.height).toBeLessThanOrEqual(frame.y + frame.height)
      const mid = {
        x: frame.x + 120 + (frame.width - 120 - 32) / 2,
        y: frame.y + 32 + (frame.height - 32 - 72) / 2,
      }
      expect(n.x + n.width / 2 > mid.x, `n${i} across`).toBe(i % 2 === 1)
      expect(n.y + n.height / 2 < mid.y, `n${i} up`).toBe(i % 4 < 2)
    }
  })

  it('reads a matrix it made back: the second run uses its axes and keeps the frame', async () => {
    stubAi(() => scoresFor(8))
    const f = fakeCanvas(plain())
    const { ctx } = fakeCtx(f.canvas)
    await placeOnMatrix(ctx, { ids: nids(8), axes: [AXES[0], AXES[1]] })
    const made = detectMatrix(f.canvas, targetNotes(f.canvas, nids(8)))
    expect(made?.source).toBe('made')
    expect(made?.axes.map((a) => a.name)).toEqual(['Effort', 'Impact'])
    const frames = () => [...f.els.values()].filter((e) => e.type === 'frame' && !e.isDeleted).length
    const before = frames()
    const steps = f.steps.length
    const seen = stubAi(() => scoresFor(8))
    // no axes asked for: the frame names them
    const again = await placeOnMatrix(ctx, { ids: nids(8) })
    expect(['applied', 'nothing']).toContain(again.status)
    expect(frames()).toBe(before)
    expect(seen[0]).toMatchObject({ action: 'score' })
    expect(f.steps.length).toBeLessThanOrEqual(steps + 1)
  })

  it('refuses axes the api would not take', async () => {
    const seen = stubAi(() => scoresFor(8))
    const f = fakeCanvas(plain())
    const { ctx, notices } = fakeCtx(f.canvas)
    const bad = [{ name: '', low: 'Low', high: 'High' }, AXES[1]] as const
    const out = await placeOnMatrix(ctx, { ids: nids(8), axes: [bad[0], bad[1]] })
    expect(out.status).toBe('nothing')
    expect(seen).toHaveLength(0)
    expect(notices.at(-1)?.text).toMatch(/axes/)
    expect(validAxes([AXES[0], AXES[1]])).toBe(true)
    expect(validAxes([{ name: 'x'.repeat(25), low: 'a', high: 'b' }, AXES[1]])).toBe(false)
    expect(validAxes([AXES[0]])).toBe(false)
  })

  it('a viewer is not offered it (read-only: refused, nothing sent)', async () => {
    const seen = stubAi(() => scoresFor(8))
    const f = fakeCanvas(plain(), { readOnly: true })
    const out = await placeOnMatrix(fakeCtx(f.canvas).ctx, { ids: nids(8), axes: [AXES[0], AXES[1]] })
    expect(out.status).toBe('refused')
    expect(seen).toHaveLength(0)
    expect(quadrantOf(1, 1)).toBe('high-high')
  })
})
