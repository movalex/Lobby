// Wave L (W2, L2-2): Ask this board on the in-memory board of ./test-kit.ts: the question goes to the api with the
// target's refs (none: the whole board), the answer opens privately with numbered source chips, a source click
// only selects and moves this tab's camera (the push counter stays at 0), "The board doesn't say" when it does
// not, and only editors get "Add answer as a note" (one push, kind ai-answer with the run's provenance).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addAnswerAsNote,
  aiAnswer,
  answerParts,
  answerText,
  askBoard,
  showSources,
  WHOLE_BOARD,
} from './ask.ts'
import { AiOverlay } from './Overlay.tsx'
import { aiKindWord, aiOf } from './provenance.ts'
import { selectionTarget } from './target.ts'
import { AI_ON, aiKit, note, renderIn } from './test-kit.ts'

const RUN = 'air_0123456789ABCDEFabcd'
const answer = (over: Record<string, unknown> = {}) => ({
  action: 'ask',
  answer: 'Two concepts mention summer [1], and one is about the solstice [2].',
  found: 'yes',
  citations: [{ ids: ['shape:n1', 'shape:n2'] }, { ids: ['shape:n2'] }],
  truncated: false,
  budget: null,
  runId: RUN,
  ...over,
})

const board = () => [
  ...note('n1', 0, 0, 'Summer beach screenings'),
  ...note('n2', 300, 0, 'Summer solstice drop'),
  ...note('n3', 2000, 900, 'Winter teaser'),
]

function stubDocument() {
  vi.stubGlobal('document', {
    defaultView: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    body: null,
  })
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Ask this board', () => {
  it('asks about the whole board (no refs) and opens the answer privately; nothing is pushed', async () => {
    const k = aiKit(board())
    k.answer(answer())
    await askBoard(k.ctx, '  Which concepts mention   summer? ', WHOLE_BOARD)
    expect(k.requests[0]?.body).toMatchObject({
      action: 'ask',
      question: 'Which concepts mention summer?',
      shapeIds: [],
    })
    expect(aiAnswer(k.canvas).get()?.status).toBe('done')
    expect(aiAnswer(k.canvas).get()?.result?.runId).toBe(RUN)
    expect(k.pushes).toEqual([])
  })

  it('asks about the selection by its refs', async () => {
    const k = aiKit(board())
    k.canvas.select(['n1', 'n2'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    k.answer(answer())
    await askBoard(k.ctx, 'Summer?', target)
    expect(k.requests[0]?.body.shapeIds).toEqual(['shape:n1', 'shape:n2'])
  })

  it('a source click selects its notes and moves only this tab’s camera: the push counter stays at 0', async () => {
    const k = aiKit(board())
    k.answer(answer())
    await askBoard(k.ctx, 'Summer?', WHOLE_BOARD)
    const cites = aiAnswer(k.canvas).get()?.result?.citations ?? []
    expect(showSources(k.canvas, cites[0]?.ids ?? [])).toBe(true)
    expect(k.canvas.selection).toEqual(['n1', 'n2'])
    expect(k.canvas.viewport.zoomTo).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 500, height: 200 },
      expect.objectContaining({ maxZoom: 1 }),
    )
    expect(k.pushes).toEqual([])
    // a source that is gone shows nothing
    expect(showSources(k.canvas, ['shape:gone'])).toBe(false)
  })

  it('reads [n] as chips only for citations that exist, and words for the clipboard or a note', () => {
    expect(answerParts('A [1], B [2] and C [3].', 2)).toEqual([
      { text: 'A ' },
      { cite: 1 },
      { text: ', B ' },
      { cite: 2 },
      { text: ' and C [3].' },
    ])
    expect(answerText('Two concepts mention summer [1], and one [2].')).toBe(
      'Two concepts mention summer, and one.',
    )
  })

  it('shows “The board doesn’t say” when it does not, and the editor’s Add answer as a note only to editors', async () => {
    stubDocument()
    const none = aiKit(board())
    none.answer(answer({ answer: '', found: 'no', citations: [] }))
    await askBoard(none.ctx, 'Octopus?', WHOLE_BOARD)
    let html = renderIn(none, AiOverlay)
    expect(html).toContain('data-testid="ai-answer-none"')
    expect(html).toContain('The board doesn’t say.')
    expect(html).not.toContain('ai-answer-add')

    const viewer = aiKit(board(), { status: { ...AI_ON, canInsert: false } })
    viewer.setReadOnly(true)
    viewer.answer(answer())
    await askBoard(viewer.ctx, 'Summer?', WHOLE_BOARD)
    html = renderIn(viewer, AiOverlay)
    expect(html).toContain('data-testid="ai-answer-text"')
    expect(html.match(/data-testid="ai-answer-cite"/g)).toHaveLength(2)
    expect(html).not.toContain('ai-answer-add')
    expect(addAnswerAsNote(viewer.ctx)).toBeNull()
    expect(viewer.pushes).toEqual([])

    const writer = aiKit(board())
    writer.answer(answer())
    await askBoard(writer.ctx, 'Summer?', WHOLE_BOARD)
    html = renderIn(writer, AiOverlay)
    expect(html).toContain('data-testid="ai-answer-add"')
    const ids = addAnswerAsNote(writer.ctx) ?? []
    expect(writer.pushes.filter((p) => !p.joined)).toHaveLength(1)
    const made = ids.map((id) => writer.els.get(id))
    expect(made.map((e) => aiKindWord(e as never)).sort()).toEqual(['answer', 'heading'])
    for (const e of made) expect(aiOf(e as never)).toEqual({ by: 'usr_ana', run: RUN })
    expect(writer.canvas.text.of(ids.find((id) => writer.els.get(id)?.type === 'stickynote') ?? '')).toBe(
      'Two concepts mention summer, and one is about the solstice.',
    )
    expect(aiAnswer(writer.canvas).get()).toBeNull()
  })
})
