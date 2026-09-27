import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardEvents, STALE_STREAM_MS } from './events.ts'

/** Just enough of EventSource for the client: the test drives messages and errors. */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static all: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeEventSource.all.push(this)
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  send(type: string, data: unknown = null) {
    this.readyState = FakeEventSource.OPEN
    this.onmessage?.({ data: JSON.stringify({ type, data, seq: 0 }) })
  }
  fail(readyState: number) {
    this.readyState = readyState
    this.onerror?.()
  }
}
const hello = { serverNow: new Date().toISOString(), role: 'owner' }
const openStreams = () => FakeEventSource.all.filter((s) => s.readyState !== FakeEventSource.CLOSED)

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createBoardEvents', () => {
  it('delivers events and resyncs on hello', () => {
    const events = createBoardEvents('b-1')
    const resync = vi.fn()
    const got = vi.fn()
    events.onResync(resync)
    events.on('comments.thread', got)
    const [es] = FakeEventSource.all
    expect(es?.url).toBe('/api/boards/b-1/events')
    es?.send('hello', hello)
    es?.send('comments.thread', { id: 'thr_1' })
    expect(resync).toHaveBeenCalledTimes(1)
    expect(got).toHaveBeenCalledWith({ id: 'thr_1' }, expect.objectContaining({ type: 'comments.thread' }))
    events.close()
  })

  it('keeps a stream that receives pings, and replaces one that went quiet (a dead proxied response)', () => {
    const events = createBoardEvents('b-1')
    const resync = vi.fn()
    events.onResync(resync)
    const first = FakeEventSource.all[0]
    first?.send('hello', hello)
    // Pings every 15 s keep it.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(15_000)
      first?.send('ping')
    }
    expect(FakeEventSource.all).toHaveLength(1)
    // Then nothing at all: the api died behind a proxy that keeps the browser side open.
    vi.advanceTimersByTime(STALE_STREAM_MS - 1)
    expect(FakeEventSource.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(first?.readyState).toBe(FakeEventSource.CLOSED)
    expect(FakeEventSource.all).toHaveLength(2)
    expect(openStreams()).toHaveLength(1)
    // The fresh stream's hello makes features refetch.
    FakeEventSource.all[1]?.send('hello', hello)
    expect(resync).toHaveBeenCalledTimes(2)
    events.close()
  })

  it('retries with backoff after an HTTP error closes the stream, one stream at a time', () => {
    const events = createBoardEvents('b-1', { staleMs: 60_000 })
    FakeEventSource.all[0]?.fail(FakeEventSource.CLOSED)
    vi.advanceTimersByTime(999)
    expect(FakeEventSource.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.all).toHaveLength(2)
    FakeEventSource.all[1]?.fail(FakeEventSource.CLOSED)
    vi.advanceTimersByTime(1_999)
    expect(FakeEventSource.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.all).toHaveLength(3)
    expect(openStreams()).toHaveLength(1)
    // A network error the browser retries by itself (CONNECTING) is left to the browser.
    FakeEventSource.all[2]?.fail(FakeEventSource.CONNECTING)
    vi.advanceTimersByTime(30_000)
    expect(FakeEventSource.all).toHaveLength(3)
    events.close()
  })

  it('close() stops every timer: no stream is opened afterwards', () => {
    const events = createBoardEvents('b-1')
    FakeEventSource.all[0]?.send('hello', hello)
    events.close()
    vi.advanceTimersByTime(10 * STALE_STREAM_MS)
    expect(FakeEventSource.all).toHaveLength(1)
    expect(openStreams()).toHaveLength(0)
    const retrying = createBoardEvents('b-2')
    FakeEventSource.all[1]?.fail(FakeEventSource.CLOSED)
    retrying.close()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.all).toHaveLength(2)
  })
})
