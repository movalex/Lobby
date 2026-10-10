// Wave M (W4, M4-1): the AI preview shows what it asks the person to accept. The preview model (./preview.tsx
// previewGroups, groupsLine, previewMarks) builds the names and counts from an AiPreviewPlan; Group into themes
// gives each label's outline its theme's name and lists the themes with their notes; the panel and the outlines
// say them before anything is written.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAi } from './actions.ts'
import {
  AiPreviewOverlay,
  aiPreview,
  groupsLine,
  groupText,
  PREVIEW_MAX_GROUPS,
  type PreviewPlan,
  previewGroups,
  previewMarks,
} from './preview.tsx'
import { selectionTarget } from './target.ts'
import { aiKit, note, renderIn } from './test-kit.ts'

const RUN = 'air_0123456789ABCDEFabcd'

const plan = (over: Partial<PreviewPlan> = {}): PreviewPlan => ({
  runId: RUN,
  title: 'Sort by a lens',
  summary: 'Moves 4 notes into 2 columns',
  moves: [],
  recolors: [],
  creates: [],
  ...over,
})

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => vi.unstubAllGlobals())

describe('the preview model (M4-1)', () => {
  it('names each group with its notes, in the plan’s order: "Sooner (2) · Later (2)"', () => {
    const groups = previewGroups(
      plan({
        groups: [
          { name: 'Sooner', count: 2 },
          { name: 'Later', count: 2 },
        ],
      }),
    )
    expect(groups).toEqual([
      { name: 'Sooner', count: 2 },
      { name: 'Later', count: 2 },
    ])
    expect(groupsLine(groups)).toBe('Sooner (2) · Later (2)')
  })

  it('one entry per name (a theme over two frames adds up), blank names left out, spaces tidied', () => {
    const groups = previewGroups(
      plan({
        groups: [
          { name: 'Next  Steps', count: 2 },
          { name: '  ', count: 4 },
          { name: 'First Thoughts', count: 1 },
          { name: 'Next Steps', count: 3 },
        ],
      }),
    )
    expect(groups).toEqual([
      { name: 'Next Steps', count: 5 },
      { name: 'First Thoughts', count: 1 },
    ])
  })

  it('without groups, the names the new elements carry (no count); nothing named, nothing listed', () => {
    const named = plan({
      creates: [
        { x: 0, y: 0, w: 100, h: 30, kind: 'text', label: 'Impact' },
        { x: 0, y: 40, w: 100, h: 30, kind: 'frame' },
        { x: 0, y: 80, w: 100, h: 30, kind: 'text', label: 'Effort' },
      ],
    })
    expect(previewGroups(named)).toEqual([
      { name: 'Impact', count: null },
      { name: 'Effort', count: null },
    ])
    expect(groupText({ name: 'Impact', count: null })).toBe('Impact')
    expect(previewGroups(plan())).toEqual([])
    expect(groupsLine([])).toBe('')
  })

  it(`past ${PREVIEW_MAX_GROUPS} groups the line counts the rest`, () => {
    const many = Array.from({ length: PREVIEW_MAX_GROUPS + 3 }, (_, i) => ({ name: `G${i}`, count: 1 }))
    expect(groupsLine(previewGroups(plan({ groups: many })))).toMatch(/G11 \(1\) and 3 more$/)
  })

  it('a new element’s outline carries its words; one without words carries none', () => {
    const marks = previewMarks(
      plan({
        creates: [
          { x: 10, y: 10, w: 100, h: 30, kind: 'text', label: '  First   Thoughts ' },
          { x: 10, y: 60, w: 100, h: 30, kind: 'arrow' },
        ],
      }),
      () => null,
      (p) => p,
      { width: 1000, height: 800 },
    )
    expect(marks.creates.map((c) => c.label ?? null)).toEqual(['First Thoughts', null])
  })
})

describe('Group into themes shows the themes it asks you to accept (M4-1)', () => {
  const answer = {
    action: 'themes',
    themes: [
      { name: 'First Thoughts', noteIds: ['shape:n1', 'shape:n2'] },
      { name: 'Next Steps', noteIds: ['shape:n3', 'shape:n4'] },
    ],
    truncated: false,
    budget: null,
    runId: RUN,
  }

  async function previewed() {
    const k = aiKit([
      ...note('n1', 0, 0, 'Beach screenings'),
      ...note('n2', 500, 400, 'Solstice drop'),
      ...note('n3', 900, 0, 'Snow teaser'),
      ...note('n4', 100, 700, 'Ski lodge premiere'),
    ])
    k.answer(answer)
    k.canvas.select(['n1', 'n2', 'n3', 'n4'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    await runAi(k.canvas, { action: 'themes' }, target)
    await vi.waitFor(() => expect(aiPreview(k.canvas).get()).not.toBeNull())
    return { k, entry: aiPreview(k.canvas).get() }
  }

  it('each label’s outline has its theme’s name, and the plan lists the themes with their notes', async () => {
    const { k, entry } = await previewed()
    const labels = entry?.plan.creates.filter((c) => c.kind === 'text').map((c) => c.label)
    expect(labels?.sort()).toEqual(['First Thoughts', 'Next Steps'])
    expect(entry?.plan.groups).toEqual([
      { name: 'First Thoughts', count: 2 },
      { name: 'Next Steps', count: 2 },
    ])
    expect(groupsLine(previewGroups(entry?.plan ?? plan()))).toBe('First Thoughts (2) · Next Steps (2)')
    // nothing written yet
    expect(k.pushes).toEqual([])
    entry?.choose('discard')
  })

  it('the panel and the outlines say them before Apply (the rendered preview)', async () => {
    const { k, entry } = await previewed()
    vi.stubGlobal('document', {
      defaultView: {
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      },
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    })
    const html = renderIn(k, AiPreviewOverlay)
    expect(html).toContain('data-testid="ai-preview-groups"')
    expect(html).toContain('First Thoughts (2)')
    expect(html).toContain('Next Steps (2)')
    // the outlines of the two labels, each with its words
    expect(html.match(/data-testid="ai-preview-name"/g)).toHaveLength(2)
    expect(k.pushes).toEqual([])
    entry?.choose('discard')
  })
})
