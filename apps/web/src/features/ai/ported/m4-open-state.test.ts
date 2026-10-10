// Wave M (W4 with W5's board-open read): the AI status is seeded from takeOpenState(boardId, 'ai') when the board's
// first read holds it, so the overlay asks nothing; without it (an api without the route, an answer taken already)
// the first read waits for an idle moment and asks GET /ai, exactly as before.
import type { AiStatus } from '@draftroom/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const takeOpenState = vi.fn()
vi.mock('../../../lib/open-state.ts', () => ({
  takeOpenState: (...a: unknown[]) => takeOpenState(...a),
}))

const { askAiStatus, hasAskedAiStatus } = await import('./actions.ts')
const { aiStatus } = await import('./runtime.ts')
const { aiKit } = await import('./test-kit.ts')

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: false,
  budget: null,
  settings: null,
}

/** An idle environment that never goes idle by itself (the test says when). */
const never = () => {
  const run: (() => void)[] = []
  return {
    env: {
      requestIdleCallback: (cb: () => void) => {
        run.push(cb)
        return run.length
      },
      cancelIdleCallback: () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    },
    idle: () => {
      for (const cb of run.splice(0)) cb()
    },
  }
}

beforeEach(() => takeOpenState.mockReset())

describe('the AI status from the board-open read', () => {
  it('a status in the read is taken once and nothing is asked', () => {
    const k = aiKit([], { status: null })
    takeOpenState.mockReturnValue(ON)
    const idle = never()
    askAiStatus(k.canvas, undefined, idle.env)
    expect(takeOpenState).toHaveBeenCalledWith(k.ctx.board.id, 'ai')
    expect(aiStatus(k.canvas).get()).toEqual(ON)
    expect(hasAskedAiStatus(k.canvas)).toBe(true)
    idle.idle()
    expect(k.requests).toEqual([])
  })

  it('null in the read (no AI for this person here) is the answer too', () => {
    const k = aiKit([], { status: ON })
    takeOpenState.mockReturnValue(null)
    askAiStatus(k.canvas, undefined, never().env)
    expect(aiStatus(k.canvas).get()).toBeNull()
    expect(k.requests).toEqual([])
  })

  it('nothing to take: the first read waits for an idle moment and asks GET /ai', async () => {
    const k = aiKit([], { status: null })
    takeOpenState.mockReturnValue(undefined)
    k.answer(ON)
    const idle = never()
    askAiStatus(k.canvas, undefined, idle.env)
    expect(k.requests).toEqual([])
    idle.idle()
    await vi.waitFor(() => expect(aiStatus(k.canvas).get()).toEqual(ON))
    expect(k.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /api/boards/${k.ctx.board.id}/ai`])
  })
})
