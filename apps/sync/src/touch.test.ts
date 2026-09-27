import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiTouchClient, createTouchReporter, type TouchClient } from './touch.ts'

function fakeClient(behave: (boardId: string) => Promise<void> = async () => {}) {
  const calls: { boardId: string; at: number }[] = []
  const client: TouchClient = {
    touched(boardId, at) {
      calls.push({ boardId, at })
      return behave(boardId)
    },
  }
  return { client, calls }
}

describe('touch reporter (RETRO-19)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => vi.useRealTimers())

  it('reports the first write at once, then at most once per interval with the latest write time', async () => {
    const { client, calls } = fakeClient()
    const r = createTouchReporter({ client, intervalMs: 60_000 })
    r.touched('b-one')
    expect(calls).toEqual([{ boardId: 'b-one', at: 1_000_000 }])
    vi.advanceTimersByTime(10_000)
    r.touched('b-one')
    vi.advanceTimersByTime(20_000)
    r.touched('b-one') // the newest unreported write: t = 1_030_000
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(29_999)
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(calls).toEqual([
      { boardId: 'b-one', at: 1_000_000 },
      { boardId: 'b-one', at: 1_030_000 },
    ])
    // quiet afterwards: nothing more is sent
    vi.advanceTimersByTime(120_000)
    expect(calls).toHaveLength(2)
    // a write long after the last report goes out at once again
    r.touched('b-one')
    expect(calls).toHaveLength(3)
    r.stop()
  })

  it('throttles each board on its own', () => {
    const { client, calls } = fakeClient()
    const r = createTouchReporter({ client, intervalMs: 60_000 })
    r.touched('b-one')
    r.touched('b-two')
    r.touched('b-one')
    expect(calls.map((c) => c.boardId)).toEqual(['b-one', 'b-two'])
    r.stop()
  })

  it('never throws or blocks when the api fails; logs at most once a minute', async () => {
    const log = vi.fn()
    const { client } = fakeClient(async () => {
      throw new Error('unreachable')
    })
    const throwing: TouchClient = {
      touched: () => {
        throw new Error('sync throw')
      },
    }
    for (const c of [client, throwing]) {
      const r = createTouchReporter({ client: c, intervalMs: 1_000, log })
      expect(() => r.touched('b-one')).not.toThrow()
      vi.advanceTimersByTime(1_000)
      expect(() => r.touched('b-one')).not.toThrow()
      await vi.runAllTimersAsync()
      await r.flush()
      r.stop()
    }
    expect(log.mock.calls.length).toBeLessThanOrEqual(2)
    expect(String(log.mock.calls[0]?.[0])).toMatch(/could not report a board edit/)
  })

  it('flush sends the pending trailing report now (shutdown); stop drops timers', async () => {
    const { client, calls } = fakeClient()
    const r = createTouchReporter({ client, intervalMs: 60_000 })
    r.touched('b-one')
    vi.advanceTimersByTime(5_000)
    r.touched('b-one')
    await r.flush()
    expect(calls).toEqual([
      { boardId: 'b-one', at: 1_000_000 },
      { boardId: 'b-one', at: 1_005_000 },
    ])
    r.touched('b-one')
    r.stop()
    vi.advanceTimersByTime(120_000)
    expect(calls).toHaveLength(2)
    r.touched('b-one') // after stop: ignored
    expect(calls).toHaveLength(2)
  })
})

describe('api touch client', () => {
  it('GETs /internal/boards/:bid/touched?at= with the internal secret, a timeout and no redirects', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(null, { status: 204 })
    }) as unknown as typeof globalThis.fetch
    const c = createApiTouchClient({ baseUrl: 'http://api.internal:5859', internalSecret: 's3cret', fetch })
    await c.touched('b-abcdefghij', 1_234_567.8)
    expect(seen[0]?.url).toBe('http://api.internal:5859/internal/boards/b-abcdefghij/touched?at=1234567')
    expect(seen[0]?.init.headers).toMatchObject({ 'x-draftroom-internal': 's3cret' })
    expect(seen[0]?.init.redirect).toBe('error')
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.init.method ?? 'GET').toBe('GET')
  })

  it('rejects on any other status (the reporter swallows it)', async () => {
    const fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch
    const c = createApiTouchClient({ baseUrl: 'http://api', internalSecret: 's', fetch })
    await expect(c.touched('b-abcdefghij', 1)).rejects.toThrow(/401/)
  })
})
