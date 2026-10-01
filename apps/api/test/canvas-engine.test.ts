// The api's view of which canvas its sync runs (canvas-engine.ts; R0's contracts, wave 5 2A): asked at
// most every ttl, one ask at a time, the last answer kept while sync cannot be asked, tldraw before any.
import { describe, expect, it } from 'vitest'
import { type CanvasEngine, createCanvasEngineProbe, onNewCanvas } from '../src/canvas-engine.ts'

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
    expect(probe.known()).toBe('tldraw')
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

  it('without a way to ask (a test fake), or a sync method that throws at once: tldraw', async () => {
    expect(await createCanvasEngineProbe(undefined).current()).toBe('tldraw')
    const throwing = createCanvasEngineProbe(() => {
      throw new TypeError('not a function')
    })
    expect(await throwing.current()).toBe('tldraw')
    expect(await onNewCanvas({})).toBe(false)
    expect(await onNewCanvas({ canvas: createCanvasEngineProbe(async () => 'excalidraw') })).toBe(true)
  })
})
