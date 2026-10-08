// K7-4: the AI status read leaves the board-open burst. The first read waits for an idle moment after the board is
// live (the overlay only mounts after the first welcome), later ones go at once, and opening the AI menu always
// asks (./actions.ts askAiStatus, openAiMenu; ./idle.ts deferUntilIdle).
import type { AiStatus } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { fakeMapCanvas } from '../../mindmap/test-canvas.ts'
import { askAiStatus, hasAskedAiStatus, openAiMenu } from './actions.ts'
import { deferUntilIdle, type IdleEnv, STATUS_FALLBACK_DELAY_MS, STATUS_IDLE_TIMEOUT_MS } from './idle.ts'
import { aiStatus, setAiCtx } from './runtime.ts'
import { NONE } from './target.ts'

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}

/** A browser with requestIdleCallback that runs its callbacks when the test says. */
function idleBrowser() {
  const callbacks = new Map<number, () => void>()
  let n = 0
  const seen: { timeout?: number }[] = []
  const env: IdleEnv = {
    requestIdleCallback: (cb, opts) => {
      callbacks.set(++n, cb)
      seen.push(opts ?? {})
      return n
    },
    cancelIdleCallback: (h) => void callbacks.delete(h),
    setTimeout: () => {
      throw new Error('no timer where requestIdleCallback exists')
    },
    clearTimeout: () => undefined,
  }
  const idle = () => {
    for (const cb of [...callbacks.values()]) cb()
  }
  return { env, callbacks, seen, idle }
}

describe('deferUntilIdle', () => {
  it('never runs synchronously; runs once when the browser is idle, with a bounded wait', () => {
    const b = idleBrowser()
    const run = vi.fn()
    deferUntilIdle(run, b.env)
    expect(run).not.toHaveBeenCalled()
    expect(b.seen[0]?.timeout).toBe(STATUS_IDLE_TIMEOUT_MS)
    b.idle()
    b.idle()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('cancel stops it', () => {
    const b = idleBrowser()
    const run = vi.fn()
    const cancel = deferUntilIdle(run, b.env)
    cancel()
    b.idle()
    expect(run).not.toHaveBeenCalled()
  })

  it('where there is no requestIdleCallback (Safari), a short pause instead', () => {
    const timers: { cb: () => void; ms: number }[] = []
    const env: IdleEnv = {
      setTimeout: (cb, ms) => timers.push({ cb, ms }),
      clearTimeout: () => undefined,
    }
    const run = vi.fn()
    deferUntilIdle(run, env)
    expect(run).not.toHaveBeenCalled()
    expect(timers[0]?.ms).toBe(STATUS_FALLBACK_DELAY_MS)
    timers[0]?.cb()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

function boardWith(status: AiStatus = ON) {
  const f = fakeMapCanvas()
  const gets: string[] = []
  const request = vi.fn(async (method: string, path: string) => {
    gets.push(`${method} ${path}`)
    return status
  })
  const ctx = {
    canvas: f.canvas,
    board: { id: 'bd_1' },
    api: { request },
    notify: vi.fn(),
    dismiss: vi.fn(),
  } as unknown as CanvasFeatureContext
  setAiCtx(ctx)
  return { f, gets, request }
}

describe('the status read', () => {
  it('is not asked while the board opens: nothing until the browser is idle', async () => {
    const { f, gets } = boardWith()
    const b = idleBrowser()
    askAiStatus(f.canvas, undefined, b.env)
    // the open burst: the overlay has mounted, no /ai request yet
    await Promise.resolve()
    expect(gets).toEqual([])
    expect(hasAskedAiStatus(f.canvas)).toBe(false)
    expect(aiStatus(f.canvas).get()).toBeNull()
    b.idle()
    await vi.waitFor(() => expect(aiStatus(f.canvas).get()).toEqual(ON))
    expect(gets).toEqual(['GET /api/boards/bd_1/ai'])
    expect(hasAskedAiStatus(f.canvas)).toBe(true)
  })

  it('once asked, a change of role or board status asks again at once', async () => {
    const { f, gets } = boardWith()
    const b = idleBrowser()
    askAiStatus(f.canvas, undefined, b.env)
    b.idle()
    await vi.waitFor(() => expect(gets).toHaveLength(1))
    askAiStatus(f.canvas, undefined, b.env)
    await vi.waitFor(() => expect(gets).toHaveLength(2))
    expect(b.callbacks.size).toBe(1) // the second ask scheduled nothing
  })

  it('opening the AI menu asks (before any idle moment), as it always has', async () => {
    const { f, gets } = boardWith()
    openAiMenu(f.canvas, { x: 0, top: 0, bottom: 0 }, NONE)
    await vi.waitFor(() => expect(gets).toEqual(['GET /api/boards/bd_1/ai']))
  })

  it('a pending first read is dropped when the overlay goes away', async () => {
    const { f, gets } = boardWith()
    const b = idleBrowser()
    const cancel = askAiStatus(f.canvas, undefined, b.env)
    cancel()
    b.idle()
    await Promise.resolve()
    expect(gets).toEqual([])
  })
})
