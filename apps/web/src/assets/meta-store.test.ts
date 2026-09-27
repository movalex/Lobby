import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetStatus, AssetVersionMeta } from './contract.ts'
import { AssetMetaStore, watchMeta } from './meta-store.ts'
import { makeMeta, TEST_BOARD } from './test-fixtures.ts'

const BOARD = TEST_BOARD

/** A fake meta route whose status advances through `statuses`, one per request. */
function fakeServer(meta: AssetVersionMeta, statuses: (AssetStatus | 404 | 500 | 'throw')[]) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    const next = statuses[Math.min(calls.length - 1, statuses.length - 1)]
    if (next === 'throw') throw new TypeError('network down')
    if (next === 404 || next === 500) return new Response('{}', { status: next })
    return Response.json({ ...meta, status: next, updatedAt: `t${calls.length}` })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('AssetMetaStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls a subscribed version until ready, then stops', async () => {
    const meta = makeMeta()
    const server = fakeServer(meta, ['queued', 'processing', 'ready'])
    const store = new AssetMetaStore({ fetchImpl: server.fetchImpl, minDelayMs: 100, maxDelayMs: 100 })
    const seen: (string | undefined)[] = []
    store.subscribe(BOARD, meta.assetId, meta.versionId, () =>
      seen.push(store.get(BOARD, meta.assetId, meta.versionId).meta?.status),
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['queued', 'processing', 'ready'])
    expect(server.calls).toHaveLength(3)
    expect(server.calls[0]).toBe(`/api/boards/${BOARD}/assets/${meta.assetId}/${meta.versionId}`)
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.calls).toHaveLength(3) // terminal: no more requests
  })

  it('caches terminal meta per version: later subscribers and resolve() never refetch', async () => {
    const meta = makeMeta()
    const server = fakeServer(meta, ['failed'])
    const store = new AssetMetaStore({ fetchImpl: server.fetchImpl })
    const off = store.subscribe(BOARD, meta.assetId, meta.versionId, () => {})
    await vi.advanceTimersByTimeAsync(10)
    off()
    store.subscribe(BOARD, meta.assetId, meta.versionId, () => {})
    const snap = await store.load(BOARD, meta.assetId, meta.versionId)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap.meta?.status).toBe('failed')
    expect(server.calls).toHaveLength(1)
  })

  it('stops polling when the last subscriber leaves (card unmounted)', async () => {
    const meta = makeMeta()
    const server = fakeServer(meta, ['processing'])
    const store = new AssetMetaStore({ fetchImpl: server.fetchImpl, minDelayMs: 100, maxDelayMs: 100 })
    const off = store.subscribe(BOARD, meta.assetId, meta.versionId, () => {})
    await vi.advanceTimersByTimeAsync(350)
    const before = server.calls.length
    expect(before).toBeGreaterThanOrEqual(3)
    off()
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.calls.length).toBe(before)
  })

  it('treats 404 as missing (no retries) but keeps retrying through network errors and 5xx', async () => {
    const gone = makeMeta()
    const s404 = fakeServer(gone, [404])
    const store = new AssetMetaStore({ fetchImpl: s404.fetchImpl, minDelayMs: 50, maxDelayMs: 50 })
    store.subscribe(BOARD, gone.assetId, gone.versionId, () => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.get(BOARD, gone.assetId, gone.versionId).missing).toBe(true)
    expect(s404.calls).toHaveLength(1)

    const flaky = makeMeta()
    const sFlaky = fakeServer(flaky, ['throw', 500, 'ready'])
    const store2 = new AssetMetaStore({ fetchImpl: sFlaky.fetchImpl, minDelayMs: 50, maxDelayMs: 50 })
    store2.subscribe(BOARD, flaky.assetId, flaky.versionId, () => {})
    await vi.advanceTimersByTimeAsync(40)
    expect(store2.get(BOARD, flaky.assetId, flaky.versionId).error).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store2.get(BOARD, flaky.assetId, flaky.versionId).meta?.status).toBe('ready')
    expect(sFlaky.calls).toHaveLength(3)
  })

  it('never requests malformed ids (they cannot exist server-side)', async () => {
    const server = fakeServer(makeMeta(), ['ready'])
    const store = new AssetMetaStore({ fetchImpl: server.fetchImpl })
    // 9 base62 chars: one short of the canvas-schema/dev-assets minimum, so no server can hold it
    store.subscribe(BOARD, 'ast_012345678', 'ver_012345678', () => {})
    const snap = await store.load(BOARD, '../../etc', 'ver_x')
    await vi.advanceTimersByTimeAsync(1000)
    expect(snap.missing).toBe(true)
    expect(store.get(BOARD, 'ast_012345678', 'ver_012345678').missing).toBe(true)
    expect(server.calls).toHaveLength(0)
  })

  it('isolates boards: the same version on another board is a separate lookup', async () => {
    const meta = makeMeta()
    const server = fakeServer(meta, ['ready'])
    const store = new AssetMetaStore({ fetchImpl: server.fetchImpl })
    await store.load(BOARD, meta.assetId, meta.versionId)
    await store.load('b-other00001', meta.assetId, meta.versionId)
    expect(server.calls.map((u) => u.split('/')[3])).toEqual([BOARD, 'b-other00001'])
  })
})

describe('AssetMetaStore under a fetch storm (PERF-01)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A meta route with latency that fails ~`failRate` of requests (seeded) and records concurrency. */
  function flakyServer(failRate: number, latencyMs = 40) {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const stats = { inFlight: 0, maxInFlight: 0, requests: 0, failures: 0, order: [] as string[] }
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      stats.requests++
      stats.inFlight++
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
      stats.order.push(String(url))
      try {
        await new Promise((r) => setTimeout(r, latencyMs))
        const [, , , , , assetId, versionId] = String(url).split('/')
        const roll = rand()
        if (roll < failRate) {
          stats.failures++
          if (roll < failRate / 3) throw new TypeError('net::ERR_INSUFFICIENT_RESOURCES')
          return new Response('{}', { status: roll < (failRate * 2) / 3 ? 503 : 429 })
        }
        return Response.json(makeMeta({ assetId, versionId, status: 'ready' }))
      } finally {
        stats.inFlight--
      }
    }) as unknown as typeof fetch
    return { fetchImpl, stats }
  }

  it('never has more than the cap in flight, serves requests FIFO, and retries 20 % failures to success', async () => {
    const { fetchImpl, stats } = flakyServer(0.2)
    const store = new AssetMetaStore({ fetchImpl, maxConcurrent: 6 })
    const versions = Array.from({ length: 300 }, () => makeMeta())
    const results = versions.map((m) => store.load(BOARD, m.assetId, m.versionId))
    await vi.advanceTimersByTimeAsync(60_000)
    const snaps = await Promise.all(results)
    expect(stats.maxInFlight).toBe(6)
    expect(stats.failures).toBeGreaterThan(30)
    // Every one ends ready: no transient failure is left as a broken image.
    expect(snaps.filter((s) => s.meta?.status === 'ready')).toHaveLength(300)
    expect(snaps.some((s) => s.error)).toBe(false)
    // FIFO: the first wave of requests goes out in the order the loads were made.
    const first = stats.order.slice(0, 50).map((u) => u.split('/')[5])
    expect(first).toEqual(versions.slice(0, 50).map((m) => m.assetId))
    expect(store.queueStats).toEqual({ active: 0, waiting: 0 })
  })

  it('also caps the pollers, and gives up after 3 retries without caching an error as terminal', async () => {
    const meta = makeMeta()
    const down = fakeServer(meta, ['throw', 'throw', 500, 500, 'ready'])
    const store = new AssetMetaStore({ fetchImpl: down.fetchImpl, random: () => 0.5 })
    const first = store.load(BOARD, meta.assetId, meta.versionId)
    await vi.advanceTimersByTimeAsync(4000) // 0.5 + 1 + 2 s of backoff (the ±25 % jitter pinned to 0)
    const snap = await first
    expect(down.calls).toHaveLength(4)
    expect(snap.error).toBe(true)
    expect(snap.meta).toBeNull()
    // Not terminal: the next resolve asks again and gets it.
    const again = await store.load(BOARD, meta.assetId, meta.versionId)
    expect(again.meta?.status).toBe('ready')
    expect(down.calls).toHaveLength(5)

    const { fetchImpl, stats } = flakyServer(0)
    const polled = new AssetMetaStore({ fetchImpl, maxConcurrent: 3, minDelayMs: 10, maxDelayMs: 10 })
    for (let i = 0; i < 40; i++) {
      const m = makeMeta()
      polled.subscribe(BOARD, m.assetId, m.versionId, () => {})
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(stats.requests).toBe(40)
    expect(stats.maxInFlight).toBe(3)
  })

  it('does not retry a 404 (terminal: missing)', async () => {
    const gone = makeMeta()
    const s404 = fakeServer(gone, [404])
    const store = new AssetMetaStore({ fetchImpl: s404.fetchImpl })
    const snap = await store.load(BOARD, gone.assetId, gone.versionId)
    expect(snap.missing).toBe(true)
    expect(s404.calls).toHaveLength(1)
  })
})

describe('watchMeta', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sees an already-cached terminal meta immediately, and stops on abort', async () => {
    const meta = makeMeta()
    const server = fakeServer(meta, ['ready'])
    const store = new AssetMetaStore({ fetchImpl: server.fetchImpl })
    await store.load(BOARD, meta.assetId, meta.versionId)
    const seen: string[] = []
    watchMeta(store, BOARD, meta.assetId, meta.versionId, new AbortController().signal, (s) => {
      seen.push(s.meta?.status ?? 'none')
      return false
    })
    expect(seen).toEqual(['ready'])

    const pending = makeMeta()
    const slow = fakeServer(pending, ['processing'])
    const store2 = new AssetMetaStore({ fetchImpl: slow.fetchImpl, minDelayMs: 50, maxDelayMs: 50 })
    const ctrl = new AbortController()
    watchMeta(store2, BOARD, pending.assetId, pending.versionId, ctrl.signal, () => false)
    await vi.advanceTimersByTimeAsync(120)
    ctrl.abort()
    const n = slow.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(slow.calls.length).toBe(n)
  })
})
