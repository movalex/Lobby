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
    expect(server.calls[0]).toBe(`/dev-api/boards/${BOARD}/assets/${meta.assetId}/${meta.versionId}`)
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
