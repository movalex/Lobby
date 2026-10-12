// N1 (wave M follow-up 4): an AI request names at most AI_MAX_REQUEST_SHAPES objects. The whole-board target (Summarize with
// nothing selected, M4-5) used to cut a larger board to its first objects without a word, so a summary of a big board
// read as if it covered all of it. The target now says how many it left out, and the person is told once the result is in.
import { AI_MAX_REQUEST_SHAPES } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsageForTests } from '../../../lib/usage.ts'
import { runAi } from './actions.ts'
import { aiPanel } from './runtime.ts'
import { boardTarget, NONE, omittedNotice } from './target.ts'
import { aiKit, note } from './test-kit.ts'

const board = (n: number) =>
  aiKit(
    Array.from({ length: n }, (_, i) =>
      note(`n${i}`, (i % 25) * 230, Math.floor(i / 25) * 230, `Idea ${i}`),
    ).flat(),
  )
const summary = {
  action: 'summarize',
  summary: 'Many ideas.',
  sources: 1,
  truncated: false,
  budget: null,
  runId: 'air_0123456789ABCDEFabcd',
}

beforeEach(() => {
  resetUsageForTests()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetUsageForTests()
})

describe('the whole-board target says what the cap left out', () => {
  it('a board over the cap names the first objects and counts the rest; under it, nothing is left out', () => {
    const over = boardTarget(board(AI_MAX_REQUEST_SHAPES + 50).canvas)
    expect(over.ids).toHaveLength(AI_MAX_REQUEST_SHAPES)
    expect(over.omitted).toBe(50)
    expect(boardTarget(board(AI_MAX_REQUEST_SHAPES).canvas).omitted ?? 0).toBe(0)
    expect(boardTarget(board(5).canvas).omitted ?? 0).toBe(0)
  })

  it('the notice is plain words with the numbers, or nothing when nothing was left out', () => {
    expect(omittedNotice({ ...NONE, ids: new Array(200).fill('x'), omitted: 50 })).toBe(
      'AI read 200 of the 250 things here, the most it takes at once. Select fewer, or one frame, to cover the rest.',
    )
    expect(omittedNotice({ ...NONE, ids: ['a'], omitted: 0 })).toBeNull()
    expect(omittedNotice({ ...NONE, ids: ['a'] })).toBeNull()
  })
})

describe('Summarize of a board over the cap', () => {
  it('sends the first objects and tells the person once the summary is in', async () => {
    const k = board(AI_MAX_REQUEST_SHAPES + 50)
    k.answer(summary)
    await runAi(k.canvas, { action: 'summarize' }, NONE)
    await vi.waitFor(() => expect(aiPanel(k.canvas).get()).not.toBeNull())
    const body = k.requests.find((r) => r.path.endsWith('/ai/run'))?.body as { shapeIds: string[] }
    expect(body.shapeIds).toHaveLength(AI_MAX_REQUEST_SHAPES)
    expect(k.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        testId: 'ai-capped',
        text: expect.stringContaining('200 of the 250 things'),
      }),
    )
  })

  it('a board under the cap gets no such notice', async () => {
    const k = board(12)
    k.answer(summary)
    await runAi(k.canvas, { action: 'summarize' }, NONE)
    await vi.waitFor(() => expect(aiPanel(k.canvas).get()).not.toBeNull())
    expect(k.notify.mock.calls.some(([n]) => (n as { testId?: string }).testId === 'ai-capped')).toBe(false)
  })
})
