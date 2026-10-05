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
  private pending = ''
  private dataLines: string[] = []
  /**
   * Raw bytes off the wire, parsed the way the HTML spec's event stream parser does (what a real
   * EventSource does before it calls onmessage): split into lines, drop a line starting with ':' (a
   * comment), collect 'data:' lines, and dispatch on a blank line only when there is data. A chunk may
   * end anywhere.
   */
  feed(chunk: string) {
    this.readyState = FakeEventSource.OPEN
    this.pending += chunk
    for (;;) {
      const end = this.pending.indexOf('\n')
      if (end < 0) return
      const line = this.pending.slice(0, end)
      this.pending = this.pending.slice(end + 1)
      if (line === '') {
        if (this.dataLines.length) this.onmessage?.({ data: this.dataLines.join('\n') })
        this.dataLines = []
      } else if (line.startsWith(':')) {
        // a comment: dropped, never seen by the page
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
  }
  fail(readyState: number) {
    this.readyState = readyState
    this.onerror?.()
  }
}
const hello = { serverNow: new Date().toISOString(), role: 'owner' }
/** What apps/api/src/events/routes.ts writes first on every stream (STREAM_PADDING; its api test pins the bytes). */
const STREAM_PADDING = `:${' '.repeat(2048)}\n\n`
/** One data frame as the api writes it. */
const frame = (type: string, data: unknown = null) => `data: ${JSON.stringify({ type, data, seq: 0 })}\n\n`
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

  it('ignores the comment padding the api writes first: the hello still resyncs, once, whatever the chunking', () => {
    const wire =
      STREAM_PADDING + frame('hello', hello) + frame('ping') + frame('comments.thread', { id: 'thr_1' })
    for (const size of [wire.length, 1_000, 7, 1]) {
      FakeEventSource.all = []
      const events = createBoardEvents('b-1')
      const resync = vi.fn()
      const thread = vi.fn()
      const pings = vi.fn()
      events.onResync(resync)
      events.on('comments.thread', thread)
      events.on('ping', pings)
      const [es] = FakeEventSource.all
      // Only the padding so far: no message, so no resync.
      es?.feed(STREAM_PADDING)
      expect(resync).not.toHaveBeenCalled()
      // The rest of the wire (padding included: it is just a comment) in chunks of `size`.
      for (let at = 0; at < wire.length; at += size) es?.feed(wire.slice(at, at + size))
      expect(resync).toHaveBeenCalledTimes(1)
      expect(pings).toHaveBeenCalledTimes(1)
      expect(thread).toHaveBeenCalledWith(
        { id: 'thr_1' },
        expect.objectContaining({ type: 'comments.thread' }),
      )
      expect(Math.abs(events.serverOffsetMs())).toBeLessThan(5_000)
      events.close()
    }
  })

  it('a stream that delivered only the padding is still stale: a comment is not liveness', () => {
    const events = createBoardEvents('b-1')
    const resync = vi.fn()
    events.onResync(resync)
    const first = FakeEventSource.all[0]
    first?.feed(STREAM_PADDING)
    vi.advanceTimersByTime(STALE_STREAM_MS - 1)
    expect(FakeEventSource.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(first?.readyState).toBe(FakeEventSource.CLOSED)
    expect(FakeEventSource.all).toHaveLength(2)
    expect(resync).not.toHaveBeenCalled()
    // The replacement's padded hello connects it.
    FakeEventSource.all[1]?.feed(STREAM_PADDING + frame('hello', hello))
    expect(resync).toHaveBeenCalledTimes(1)
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
