// The api's view of which canvas its sync runs (canvas-engine.ts; R0's contracts, wave 5 2A): asked at
// most every ttl, one ask at a time, the last answer kept while sync cannot be asked. K6-1: `unknown`
// before the first answer (never tldraw by default), asked at start-up with retries, and a decision that
// needs the engine while it is unknown is a retryable 503, never a guess.
import {
  CANVAS_STARTING_ERROR,
  CANVAS_STARTING_MESSAGE,
  CANVAS_STARTING_RETRY_AFTER_S,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  CANVAS_ENGINE_SILENT_ASKS,
  CANVAS_ENGINE_START_BACKOFF_MS,
  CANVAS_ENGINE_UNKNOWN_ASK_GAP_MS,
  type CanvasEngine,
  canvasStarting,
  createCanvasEngineProbe,
  onNewCanvas,
  showsR0Marks,
  TLDRAW_ONLY,
} from '../src/canvas-engine.ts'
import { ApiError } from '../src/errors.ts'

/** Lets every pending promise chain run (setImmediate is real here). */
const flush = () => new Promise<void>((r) => setImmediate(r))

/** Timers the test runs by hand: `advance(ms)` fires every due one in time order. */
function manualTimers() {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    /** The waits of the timers still set (ms from now), soonest first. */
    pending: () => [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b),
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        timers.delete(next[0])
        t = next[1].at
        next[1].fn()
        await flush()
      }
      t = end
      await flush()
    },
  }
}

describe('createCanvasEngineProbe', () => {
  it('caches an answer for the ttl, shares one ask, and keeps the last answer through a failure', async () => {
    let t = 0
    let asks = 0
    let answer: CanvasEngine | Error = 'excalidraw'
    const probe = createCanvasEngineProbe(
      async () => {
        asks++
        if (answer instanceof Error) throw answer
        return answer
      },
      { ttlMs: 1_000, now: () => t },
    )
    expect(probe.known()).toBe('unknown')
    const [a, b] = await Promise.all([probe.current(), probe.current()])
    expect([a, b, asks]).toEqual(['excalidraw', 'excalidraw', 1])
    t = 500
    expect(await probe.current()).toBe('excalidraw')
    expect(asks).toBe(1)
    t = 1_500
    answer = new Error('sync down')
    expect(await probe.current()).toBe('excalidraw') // the last answer stands
    expect(asks).toBe(2)
    answer = 'tldraw' // a rollback deployed R0's sync
    t = 1_600
    expect(await probe.current()).toBe('excalidraw') // asked again only a few seconds after the failure
    t = 10_000
    expect(await probe.current()).toBe('tldraw')
    expect(probe.known()).toBe('tldraw')
  })

  it('without a way to ask (a test fake, a sync client without engine()): tldraw from the start, never unknown', async () => {
    const probe = createCanvasEngineProbe(undefined)
    expect(probe.known()).toBe('tldraw')
    expect(await probe.current()).toBe('tldraw')
    expect(await onNewCanvas({})).toBe(false)
    expect(await onNewCanvas({ canvas: TLDRAW_ONLY })).toBe(false)
    expect(await showsR0Marks({})).toBe(true)
    expect(await onNewCanvas({ canvas: createCanvasEngineProbe(async () => 'excalidraw') })).toBe(true)
  })

  it('K6-1: before the first answer the engine is unknown: a sync that cannot be asked (or a method that throws at once) is no answer', async () => {
    const timers = manualTimers()
    const throwing = createCanvasEngineProbe(() => {
      throw new TypeError('not a function')
    }, timers)
    expect(await throwing.current()).toBe('unknown')
    const down = createCanvasEngineProbe(async () => {
      throw new Error('ECONNREFUSED')
    }, timers)
    expect(down.known()).toBe('unknown')
    expect(await down.current()).toBe('unknown')
    // a decision that writes or refuses is a retryable 503, never NEW_CANVAS; display marks are not shown
    const err = await onNewCanvas({ canvas: down }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 503,
      code: CANVAS_STARTING_ERROR,
      message: CANVAS_STARTING_MESSAGE,
      headers: { 'retry-after': String(CANVAS_STARTING_RETRY_AFTER_S) },
    })
    expect(CANVAS_STARTING_ERROR).not.toBe('NEW_CANVAS')
    expect(canvasStarting().status).toBe(503)
    expect(await showsR0Marks({ canvas: down })).toBe(false)
  })

  it('K6-1: a request before the first answer waits for the ask in flight, but no longer than waitMs', async () => {
    const timers = manualTimers()
    let release: (e: CanvasEngine) => void = () => {}
    const probe = createCanvasEngineProbe(
      () =>
        new Promise<CanvasEngine>((r) => {
          release = r
        }),
      { ...timers, waitMs: 2_000 },
    )
    let first: string | null = null
    void probe.current().then((e) => {
      first = e
    })
    await timers.advance(1_999)
    expect(first).toBeNull()
    await timers.advance(1)
    expect(first).toBe('unknown') // told to retry: the ask is still out
    let second: string | null = null
    void probe.current().then((e) => {
      second = e
    })
    await timers.advance(100)
    release('excalidraw') // sync answers: the waiting request goes on at once
    await flush()
    expect(second).toBe('excalidraw')
    expect(probe.known()).toBe('excalidraw')
  })

  it('K6-1: start() asks at once and again with a short backoff while sync is down, then stops at the first answer', async () => {
    const timers = manualTimers()
    let asks = 0
    let up = false
    const logs: string[] = []
    const probe = createCanvasEngineProbe(
      async () => {
        asks++
        if (!up) throw new Error('sync down')
        return 'excalidraw'
      },
      { ...timers, log: (m) => logs.push(m) },
    )
    probe.start?.()
    await timers.advance(0)
    expect(asks).toBe(1) // at start-up, not at the first request
    expect(timers.pending()).toEqual([CANVAS_ENGINE_START_BACKOFF_MS[0]])
    const waits = [...CANVAS_ENGINE_START_BACKOFF_MS]
    for (const [i, ms] of waits.entries()) {
      await timers.advance(ms)
      expect(asks, `after the wait of ${ms} ms`).toBe(i + 2)
    }
    // past the list, every 5 s
    await timers.advance(5_000)
    expect(asks).toBe(waits.length + 2)
    expect(probe.known()).toBe('unknown')
    up = true
    await timers.advance(5_000)
    expect(probe.known()).toBe('excalidraw')
    // said once after CANVAS_ENGINE_SILENT_ASKS failed asks (an operator's clue: no secret, no URL), then the answer
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatch(
      new RegExp(
        `^sync has not said which canvas it runs \\(${CANVAS_ENGINE_SILENT_ASKS} asks since start-up\\)`,
      ),
    )
    expect(logs[0]).toContain('503 CANVAS_STARTING')
    expect(logs[1]).toBe('sync runs the excalidraw canvas')
    const after = asks
    await timers.advance(60_000)
    expect(asks).toBe(after) // no start-up asks once answered
    expect(timers.pending()).toEqual([])
  })

  it('K6-1: sync coming up is picked up by the next request (within one probe), and stop() ends the start-up asks', async () => {
    const timers = manualTimers()
    let asks = 0
    let up = false
    // no start-up asks here: the requests alone
    const probe = createCanvasEngineProbe(async () => {
      asks++
      if (!up) throw new Error('sync down')
      return 'excalidraw'
    }, timers)
    expect(await probe.current()).toBe('unknown')
    expect(asks).toBe(1)
    expect(await probe.current()).toBe('unknown') // right after a failed ask: not asked again yet
    expect(asks).toBe(1)
    await timers.advance(CANVAS_ENGINE_UNKNOWN_ASK_GAP_MS)
    up = true
    // the next request asks and gets the answer
    expect(await probe.current()).toBe('excalidraw')
    expect(asks).toBe(2)

    const stopped = createCanvasEngineProbe(async () => {
      throw new Error('sync down')
    }, timers)
    stopped.start?.()
    await timers.advance(0)
    stopped.stop?.()
    expect(timers.pending()).toEqual([])
  })

  it('K6-1: R0’s sync answering 404 is an answer (tldraw): R0’s refusals stand and its marks show', async () => {
    const timers = manualTimers()
    const probe = createCanvasEngineProbe(async () => 'tldraw', timers)
    probe.start?.()
    await timers.advance(0)
    expect(probe.known()).toBe('tldraw')
    expect(await onNewCanvas({ canvas: probe })).toBe(false)
    expect(await showsR0Marks({ canvas: probe })).toBe(true)
    expect(timers.pending()).toEqual([])
  })
})
