import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type BoardEventsOptions,
  createBoardEvents,
  createSseParser,
  DIRECT_RETRY_MAX_MS,
  DIRECT_RETRY_MS,
  type EventsTicket,
  MAX_DIRECT_FAILURES,
  MINT_TROUBLE_MS,
  MintError,
  mintEventsTicket,
  PROBE_HELLO_MS,
  STALE_STREAM_MS,
} from './events.ts'

/** The cookie transport only (what every page did before wave H1, and still does with no direct origin). */
const COOKIE_ONLY: BoardEventsOptions = { mintTicket: null }

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

describe('createBoardEvents (the cookie stream)', () => {
  it('delivers events and resyncs on hello', () => {
    const events = createBoardEvents('b-1', COOKIE_ONLY)
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
    const events = createBoardEvents('b-1', COOKIE_ONLY)
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
      const events = createBoardEvents('b-1', COOKIE_ONLY)
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
    const events = createBoardEvents('b-1', COOKIE_ONLY)
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
    const events = createBoardEvents('b-1', { ...COOKIE_ONLY, staleMs: 60_000 })
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
    const events = createBoardEvents('b-1', COOKIE_ONLY)
    FakeEventSource.all[0]?.send('hello', hello)
    events.close()
    vi.advanceTimersByTime(10 * STALE_STREAM_MS)
    expect(FakeEventSource.all).toHaveLength(1)
    expect(openStreams()).toHaveLength(0)
    const retrying = createBoardEvents('b-2', COOKIE_ONLY)
    FakeEventSource.all[1]?.fail(FakeEventSource.CLOSED)
    retrying.close()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.all).toHaveLength(2)
  })
})

// ---- wave H1: the direct transport (a ticket, a fetch stream on the api's own origin) -----------------------

/** A response body the test writes to as the api would; a real fetch errors it when its signal aborts. */
function wire(signal?: AbortSignal | null) {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  let open = true
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  const w = {
    body,
    aborted: false,
    push(text: string) {
      if (open) ctrl?.enqueue(enc.encode(text))
    },
    end() {
      if (open) ctrl?.close()
      open = false
    },
  }
  signal?.addEventListener('abort', () => {
    w.aborted = true
    if (open) ctrl?.error(new DOMException('The operation was aborted.', 'AbortError'))
    open = false
  })
  return w
}
type Wire = ReturnType<typeof wire>

const fakeResponse = (status: number, type: string, body: ReadableStream<Uint8Array> | null) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': type }),
    body,
  }) as unknown as Response

/** One direct attempt's answer: a stream (default), an HTTP status, or a rejected fetch (CSP, CORS, DNS). */
type Outcome = 'stream' | 'reject' | number

const DIRECT_URL = 'https://api.example/api/boards/b-1/events'

function direct(
  opts: {
    outcomes?: Outcome[]
    mints?: (EventsTicket | MintError)[]
    /** Decides mint number `call` (1-based) once `mints` is used up: an answer, or undefined for a good ticket. */
    mintWhen?: (call: number) => EventsTicket | MintError | undefined
    staleMs?: number
  } = {},
) {
  let minted = 0
  let mintCalls = 0
  const mint = vi.fn(async (_boardId: string, _signal: AbortSignal): Promise<EventsTicket> => {
    mintCalls++
    const next = opts.mints?.shift() ?? opts.mintWhen?.(mintCalls)
    if (next instanceof Error) throw next
    if (next) return next
    minted++
    return { url: DIRECT_URL, ticket: `evt_${minted}` }
  })
  const calls: { url: string; init: RequestInit }[] = []
  const wires: Wire[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const o = opts.outcomes?.shift() ?? 'stream'
    if (o === 'reject') throw new TypeError('Failed to fetch')
    if (typeof o === 'number') return fakeResponse(o, 'application/json; charset=utf-8', null)
    const w = wire(init?.signal)
    wires.push(w)
    return fakeResponse(200, 'text/event-stream; charset=utf-8', w.body)
  })
  const events = createBoardEvents('b-1', {
    mintTicket: mint,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(opts.staleMs ? { staleMs: opts.staleMs } : {}),
  })
  return { events, mint, calls, wires, last: () => wires.at(-1) }
}

/** Lets every pending promise run (stream reads, the mint): setImmediate is not faked in these tests. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r))
}
/** Advances fake time, letting promises run between the timers. */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

describe('createBoardEvents (the direct stream, wave H1)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  it('mints a ticket, then streams from the minted URL with the ticket in Authorization: never in the URL, no cookie', async () => {
    const d = direct()
    const resync = vi.fn()
    const got = vi.fn()
    d.events.onResync(resync)
    d.events.on('comments.thread', got)
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(1)
    expect(d.mint.mock.calls[0]?.[0]).toBe('b-1')
    expect(d.calls).toHaveLength(1)
    const [call] = d.calls
    expect(call?.url).toBe(DIRECT_URL)
    expect(new URL(call?.url ?? '').search).toBe('')
    expect(call?.init.headers).toEqual({ authorization: 'Bearer evt_1', accept: 'text/event-stream' })
    expect(call?.init.credentials).toBe('omit')
    expect(call?.init.mode).toBe('cors')
    expect(FakeEventSource.all).toHaveLength(0)
    // The api's padding, then hello, in awkward chunks.
    const bytes = STREAM_PADDING + frame('hello', hello) + frame('comments.thread', { id: 'thr_1' })
    for (let at = 0; at < bytes.length; at += 333) d.last()?.push(bytes.slice(at, at + 333))
    await settle()
    expect(resync).toHaveBeenCalledTimes(1)
    expect(got).toHaveBeenCalledWith({ id: 'thr_1' }, expect.objectContaining({ type: 'comments.thread' }))
    expect(Math.abs(d.events.serverOffsetMs())).toBeLessThan(5_000)
    expect(d.events.transport()).toBe('direct')
    d.events.close()
  })

  it('every reconnect mints a fresh ticket (a ticket is single use)', async () => {
    const d = direct()
    const resync = vi.fn()
    d.events.onResync(resync)
    await settle()
    d.last()?.push(frame('hello', hello))
    await settle()
    // The server ends the stream (a deploy, session-ended): the next attempt mints again.
    d.last()?.end()
    await advance(999)
    expect(d.mint).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(d.mint).toHaveBeenCalledTimes(2)
    expect(d.calls.map((c) => (c.init.headers as Record<string, string>).authorization)).toEqual([
      'Bearer evt_1',
      'Bearer evt_2',
    ])
    d.last()?.push(frame('hello', hello))
    await settle()
    expect(resync).toHaveBeenCalledTimes(2)
    // A stream that went quiet (after its hello) is replaced at once, again with a new ticket.
    await advance(STALE_STREAM_MS)
    expect(d.wires[1]?.aborted).toBe(true)
    expect(d.mint).toHaveBeenCalledTimes(3)
    expect(d.calls).toHaveLength(3)
    expect(d.events.transport()).toBe('direct')
    d.events.close()
  })

  it("honours the server's retry: 'replaced' waits a minute before reconnecting", async () => {
    const d = direct()
    await settle()
    d.last()?.push(frame('hello', hello))
    d.last()?.push(`retry: 60000\n${frame('replaced')}`)
    d.last()?.end()
    await advance(59_999)
    expect(d.mint).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(d.mint).toHaveBeenCalledTimes(2)
    d.events.close()
  })

  it(`falls back to the cookie stream after ${MAX_DIRECT_FAILURES} direct failures in a row (a CSP, CORS or DNS failure), and stays there`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct({ outcomes: ['reject', 'reject', 'reject'] })
    await settle()
    expect(d.calls).toHaveLength(1)
    expect(FakeEventSource.all).toHaveLength(0)
    await advance(1_000)
    expect(d.calls).toHaveLength(2)
    expect(FakeEventSource.all).toHaveLength(0)
    await advance(2_000)
    expect(d.calls).toHaveLength(3)
    // The third failure: the same-origin cookie stream, at once.
    expect(FakeEventSource.all).toHaveLength(1)
    expect(FakeEventSource.all[0]?.url).toBe('/api/boards/b-1/events')
    expect(d.events.transport()).toBe('cookie')
    expect(warn).toHaveBeenCalledTimes(1)
    const resync = vi.fn()
    d.events.onResync(resync)
    FakeEventSource.all[0]?.send('hello', hello)
    expect(resync).toHaveBeenCalledTimes(1)
    // Its reconnects stay on the cookie stream: no more tickets.
    FakeEventSource.all[0]?.fail(FakeEventSource.CLOSED)
    await advance(1_000)
    expect(FakeEventSource.all).toHaveLength(2)
    expect(d.mint).toHaveBeenCalledTimes(3)
    d.events.close()
  })

  it('a ticket the direct origin refuses (401) counts as a failure; 404, 429 and 503 answers do not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct({ outcomes: [503, 404, 429, 401, 401, 'stream'] })
    const resync = vi.fn()
    d.events.onResync(resync)
    await settle()
    // Backoff 1, 2, 4, 8, 16 s between the six attempts.
    for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000]) await advance(ms)
    expect(d.calls).toHaveLength(6)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    d.last()?.push(frame('hello', hello))
    await settle()
    expect(resync).toHaveBeenCalledTimes(1)
    d.events.close()

    // Three refused tickets in a row: the origin is not this api (a misconfiguration). Cookie stream.
    FakeEventSource.all = []
    const m = direct({ outcomes: [401, 401, 401] })
    await settle()
    await advance(1_000)
    await advance(2_000)
    expect(m.calls).toHaveLength(3)
    expect(m.events.transport()).toBe('cookie')
    expect(FakeEventSource.all).toHaveLength(1)
    m.events.close()
  })

  it('a stream that ends before its hello counts; a hello resets the count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct()
    await settle()
    d.last()?.end() // 1
    await advance(1_000)
    d.last()?.push(STREAM_PADDING)
    d.last()?.end() // 2 (a comment is not a hello)
    await advance(2_000)
    d.last()?.push(frame('hello', hello)) // reset
    await settle()
    d.last()?.end()
    await advance(1_000)
    d.last()?.end() // 1
    await advance(1_000)
    d.last()?.end() // 2
    await advance(2_000)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    expect(d.calls).toHaveLength(6)
    d.events.close()
  })

  it('no hello within the stale timeout counts as a failure (a proxy that buffers the direct origin too)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct({ staleMs: 5_000 })
    await settle()
    d.last()?.push(STREAM_PADDING)
    await advance(5_000) // 1: aborted, backoff 1 s
    expect(d.wires[0]?.aborted).toBe(true)
    await advance(1_000)
    await advance(5_000) // 2: backoff 2 s
    await advance(2_000)
    await advance(5_000) // 3: the cookie stream
    expect(d.calls).toHaveLength(3)
    expect(d.events.transport()).toBe('cookie')
    expect(FakeEventSource.all).toHaveLength(1)
    d.events.close()
  })

  it('the api has no direct origin ({ url: null }), or no mint route (an older api: 404): the cookie stream at once, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = direct({ mints: [{ url: null }] })
    await settle()
    expect(a.calls).toHaveLength(0)
    expect(FakeEventSource.all).toHaveLength(1)
    expect(a.events.transport()).toBe('cookie')
    a.events.close()
    FakeEventSource.all = []
    const b = direct({ mints: [new MintError(404)] })
    await settle()
    expect(b.calls).toHaveLength(0)
    expect(FakeEventSource.all).toHaveLength(1)
    b.events.close()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a mint that fails for any other reason (signed out, busy, the api restarting) is retried with backoff, never a fallback', async () => {
    const d = direct({
      mints: [new MintError(401), new MintError(503), new MintError(0), new MintError(429)],
    })
    await settle()
    for (const ms of [1_000, 2_000, 4_000]) await advance(ms)
    expect(d.mint).toHaveBeenCalledTimes(4)
    expect(d.calls).toHaveLength(0)
    await advance(8_000)
    expect(d.mint).toHaveBeenCalledTimes(5)
    expect(d.calls).toHaveLength(1)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    d.events.close()
  })

  it('close() aborts the direct stream and its mint; nothing reconnects', async () => {
    const d = direct()
    await settle()
    d.last()?.push(frame('hello', hello))
    await settle()
    d.events.close()
    expect(d.wires[0]?.aborted).toBe(true)
    await advance(10 * STALE_STREAM_MS)
    expect(d.mint).toHaveBeenCalledTimes(1)
    // Closed while minting: the mint's signal is aborted, and its answer is ignored.
    let aborted = false
    const slow = createBoardEvents('b-2', {
      mintTicket: (_b, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new MintError(0))
          }),
        ),
    })
    slow.close()
    await advance(60_000)
    expect(aborted).toBe(true)
    expect(FakeEventSource.all).toHaveLength(0)
  })
})

// ---- wave I1: mints that keep failing, a fallback that is temporary, a page that wakes up ----------------------

/** What the page sees of the browser: 'online' on the window, 'visibilitychange' on the document. */
function stubPage() {
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  return {
    online: () => win.dispatchEvent(new Event('online')),
    visibility(state: 'visible' | 'hidden') {
      doc.visibilityState = state
      doc.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

/** Three rejected direct attempts (a CSP, CORS, DNS): the cookie stream, hello'd, with the page waiting to retry. */
async function fallenBack(opts: Parameters<typeof direct>[0] = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // A long stale timeout: the cookie stream is left alone for as long as the test runs.
  const d = direct({
    ...opts,
    staleMs: opts.staleMs ?? 3_600_000,
    outcomes: ['reject', 'reject', 'reject', ...(opts.outcomes ?? [])],
  })
  const resync = vi.fn()
  d.events.onResync(resync)
  await settle()
  await advance(1_000)
  await advance(2_000)
  expect(d.events.transport()).toBe('cookie')
  const cookie = FakeEventSource.all[0] as FakeEventSource
  cookie.send('hello', hello)
  expect(resync).toHaveBeenCalledTimes(1)
  return { ...d, warn, resync, cookie }
}

describe('createBoardEvents: a mint that keeps failing (wave I1)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  it('a mint refused in a way a retry will not fix (400, 405, 415) counts like a failed direct attempt: the third in a row is the cookie stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct({ mints: [new MintError(405), new MintError(400), new MintError(415)] })
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.all).toHaveLength(0)
    await advance(1_000)
    expect(d.mint).toHaveBeenCalledTimes(2)
    await advance(2_000)
    expect(d.mint).toHaveBeenCalledTimes(3)
    expect(d.calls).toHaveLength(0)
    expect(d.events.transport()).toBe('cookie')
    expect(FakeEventSource.all).toHaveLength(1)
    expect(FakeEventSource.all[0]?.url).toBe('/api/boards/b-1/events')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('the ticket route answered 415')
    d.events.close()
  })

  it('a good ticket and a hello reset that count: refused twice, then fine, then refused twice again stays direct', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mints: (EventsTicket | MintError)[] = [new MintError(405), new MintError(405)]
    const d = direct({ mints })
    await settle()
    await advance(1_000)
    await advance(2_000) // the third mint is good
    expect(d.calls).toHaveLength(1)
    d.last()?.push(frame('hello', hello))
    await settle()
    mints.push(new MintError(405), new MintError(405))
    d.last()?.end()
    await advance(1_000)
    await advance(2_000)
    await advance(4_000)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    expect(d.calls).toHaveLength(2)
    d.events.close()
  })

  it(`a 5xx that lasts ${MINT_TROUBLE_MS / 1000} s with no good mint (a full ticket store, a broken route) is the cookie stream; a shorter one (an api restart) is waited out`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct({ mintWhen: () => new MintError(503) })
    await settle()
    await advance(MINT_TROUBLE_MS - 20_000)
    expect(d.mint.mock.calls.length).toBeGreaterThan(5)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    await advance(60_000)
    expect(d.events.transport()).toBe('cookie')
    expect(FakeEventSource.all).toHaveLength(1)
    expect(d.calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('the ticket route keeps failing (503)')
    d.events.close()
  })

  it('a good mint (and a hello) restart the window: restarts that add up to more than it never fall back', async () => {
    let failing = true
    const d = direct({ mintWhen: () => (failing ? new MintError(502) : undefined) })
    const resync = vi.fn()
    d.events.onResync(resync)
    await settle()
    await advance(MINT_TROUBLE_MS - 20_000) // the api is restarting
    failing = false
    await advance(30_000) // the next retry mints
    d.last()?.push(frame('hello', hello))
    await settle()
    expect(resync).toHaveBeenCalledTimes(1)
    // a second restart: its own run, though more than MINT_TROUBLE_MS have passed since the first failure
    failing = true
    d.last()?.end()
    await advance(MINT_TROUBLE_MS - 20_000)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    failing = false
    await advance(30_000)
    d.last()?.push(frame('hello', hello))
    await settle()
    expect(resync).toHaveBeenCalledTimes(2)
    d.events.close()
  })

  it('no response, signed out and busy are never counted, however long they last', async () => {
    const d = direct({ mintWhen: (n) => new MintError([0, 401, 429][n % 3] as number) })
    await settle()
    await advance(10 * 60_000)
    expect(d.mint.mock.calls.length).toBeGreaterThan(20)
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    d.events.close()
  })

  it('a mint answered 403 or 404 is still the cookie stream at once, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct({ mints: [new MintError(403)] })
    await settle()
    expect(d.events.transport()).toBe('cookie')
    expect(FakeEventSource.all).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    d.events.close()
  })

  it('a resync listener that throws is that feature’s problem: the stream is not failed, no fallback', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = direct()
    const fine = vi.fn()
    d.events.onResync(() => {
      throw new Error('a feature broke')
    })
    d.events.onResync(fine)
    const got = vi.fn()
    d.events.on('comments.thread', got)
    await settle()
    for (let i = 0; i < MAX_DIRECT_FAILURES + 1; i++) {
      d.last()?.push(frame('hello', hello) + frame('comments.thread', { id: `thr_${i}` }))
      await settle()
      expect(fine).toHaveBeenCalledTimes(i + 1)
      expect(got).toHaveBeenCalledTimes(i + 1)
      d.last()?.end()
      await advance(1_000)
    }
    expect(error).toHaveBeenCalled()
    expect(d.events.transport()).toBe('direct')
    expect(FakeEventSource.all).toHaveLength(0)
    d.events.close()
  })
})

describe('createBoardEvents: the cookie fallback is temporary (wave I1)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  it('after the cool-down the ticket is minted first (the cookie stream runs on), then the page swaps to the direct stream and keeps it', async () => {
    let cookieStreamsWhileMinting = -1
    const f = await fallenBack({
      mintWhen: (n) => {
        if (n === 4) cookieStreamsWhileMinting = openStreams().length
        return undefined
      },
    })
    await advance(DIRECT_RETRY_MS - 1)
    expect(f.mint).toHaveBeenCalledTimes(3)
    expect(f.cookie.readyState).toBe(FakeEventSource.OPEN)
    await advance(1)
    expect(f.mint).toHaveBeenCalledTimes(4)
    expect(cookieStreamsWhileMinting).toBe(1)
    // minted, so swapped: one direct attempt with that ticket
    expect(f.cookie.readyState).toBe(FakeEventSource.CLOSED)
    expect(f.calls).toHaveLength(4)
    expect(((f.calls[3]?.init.headers ?? {}) as Record<string, string>).authorization).toBe('Bearer evt_4')
    expect(f.events.transport()).toBe('direct')
    f.last()?.push(STREAM_PADDING + frame('hello', hello))
    await settle()
    expect(f.resync).toHaveBeenCalledTimes(2)
    expect(openStreams()).toHaveLength(0)
    // and it stays: the next reconnect mints again, no cookie stream
    f.last()?.end()
    await advance(1_000)
    expect(f.mint).toHaveBeenCalledTimes(5)
    expect(f.calls).toHaveLength(5)
    expect(FakeEventSource.all).toHaveLength(1)
    expect(f.warn).toHaveBeenCalledTimes(1)
    expect(String(f.warn.mock.calls[0]?.[0])).toContain('tried again later')
    f.events.close()
  })

  it('a retry that fails goes back to the cookie stream after ONE failure, quietly, and the next retry waits twice as long', async () => {
    const f = await fallenBack({ outcomes: ['reject'] })
    await advance(DIRECT_RETRY_MS)
    expect(f.calls).toHaveLength(4)
    expect(f.events.transport()).toBe('cookie')
    expect(FakeEventSource.all).toHaveLength(2)
    expect(openStreams()).toHaveLength(1)
    expect(f.warn).toHaveBeenCalledTimes(1) // said once, not by every retry
    FakeEventSource.all[1]?.send('hello', hello)
    await advance(2 * DIRECT_RETRY_MS - 1)
    expect(f.mint).toHaveBeenCalledTimes(4)
    await advance(1)
    expect(f.mint).toHaveBeenCalledTimes(5)
    expect(f.events.transport()).toBe('direct')
    f.events.close()
  })

  it(`the wait doubles per failed retry, up to ${DIRECT_RETRY_MAX_MS / 60_000} minutes`, async () => {
    const f = await fallenBack({ outcomes: Array.from({ length: 12 }, () => 'reject' as const) })
    const waits: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = f.mint.mock.calls.length
      // the next mint comes when the cool-down ends: find it to the second
      let ms = 0
      while (f.mint.mock.calls.length === before && ms < 2 * DIRECT_RETRY_MAX_MS) {
        await advance(1_000)
        ms += 1_000
      }
      waits.push(ms)
      await settle()
    }
    // each wait is measured from the fallback before it (the retry itself takes no time here)
    expect(waits).toEqual([
      DIRECT_RETRY_MS,
      2 * DIRECT_RETRY_MS,
      4 * DIRECT_RETRY_MS,
      DIRECT_RETRY_MAX_MS,
      DIRECT_RETRY_MAX_MS,
    ])
    f.events.close()
  })

  it('a retried stream that never says hello is given up on after PROBE_HELLO_MS, not after the stale timeout', async () => {
    const f = await fallenBack({ outcomes: ['stream'] })
    await advance(DIRECT_RETRY_MS)
    expect(f.calls).toHaveLength(4)
    f.last()?.push(STREAM_PADDING) // a buffering proxy: the padding at best
    await advance(PROBE_HELLO_MS - 1)
    expect(f.events.transport()).toBe('direct')
    expect(openStreams()).toHaveLength(0)
    await advance(1)
    expect(f.wires[0]?.aborted).toBe(true)
    expect(f.events.transport()).toBe('cookie')
    expect(openStreams()).toHaveLength(1)
    expect(f.warn).toHaveBeenCalledTimes(1)
    f.events.close()
  })

  it('a retried stream the api answers with an error status goes back at once too (no backoff with no stream at all)', async () => {
    const f = await fallenBack({ outcomes: [503] })
    await advance(DIRECT_RETRY_MS)
    expect(f.calls).toHaveLength(4)
    expect(f.events.transport()).toBe('cookie')
    expect(openStreams()).toHaveLength(1)
    // not a retry loop: nothing more is asked until the next cool-down
    await advance(60_000)
    expect(f.mint).toHaveBeenCalledTimes(4)
    f.events.close()
  })

  it('a retry whose mint finds no direct origin, fails, or hangs leaves the cookie stream untouched', async () => {
    const answers: (EventsTicket | MintError | 'hang')[] = [
      { url: null },
      new MintError(503),
      new MintError(0),
      'hang',
    ]
    for (const answer of answers) {
      FakeEventSource.all = []
      const f = await fallenBack({
        staleMs: 10 * 60_000,
        mintWhen: (n) => (n === 4 && answer !== 'hang' ? answer : undefined),
      })
      if (answer === 'hang')
        f.mint.mockImplementationOnce(
          (_b, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new MintError(0))),
            ),
        )
      await advance(DIRECT_RETRY_MS)
      expect(f.mint).toHaveBeenCalledTimes(4)
      // the cookie stream keeps getting its pings, and a mint that hangs is abandoned after the stale timeout
      const quiet = async (minutes: number) => {
        for (let i = 0; i < minutes; i++) {
          await advance(60_000)
          f.cookie.send('ping')
        }
      }
      await quiet(answer === 'hang' ? 10 : 4)
      expect(f.cookie.readyState).toBe(FakeEventSource.OPEN)
      expect(FakeEventSource.all).toHaveLength(1)
      expect(f.calls).toHaveLength(3)
      expect(f.events.transport()).toBe('cookie')
      expect(f.mint).toHaveBeenCalledTimes(4)
      // the page tries again at the next cool-down: twice the first wait, counted from the retry that found nothing
      await quiet(10)
      expect(f.mint).toHaveBeenCalledTimes(5)
      f.events.close()
    }
  })

  it('a successful direct stream starts the count over: the next fallback is retried after the first wait again', async () => {
    const f = await fallenBack({ outcomes: ['stream', 'reject', 'reject', 'reject'] })
    await advance(DIRECT_RETRY_MS)
    f.last()?.push(frame('hello', hello))
    await settle()
    expect(f.events.transport()).toBe('direct')
    f.last()?.end()
    await advance(1_000) // attempt 5
    await advance(1_000) // 6
    await advance(2_000) // 7: the third failure since the hello
    expect(f.events.transport()).toBe('cookie')
    const mints = f.mint.mock.calls.length
    await advance(DIRECT_RETRY_MS - 1)
    expect(f.mint).toHaveBeenCalledTimes(mints)
    await advance(1)
    expect(f.mint).toHaveBeenCalledTimes(mints + 1)
    f.events.close()
  })

  it('a page with no direct transport never retries, and close() cancels a retry that is waiting', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const cookieOnly = createBoardEvents('b-1', { mintTicket: null, staleMs: 3_600_000 })
    await advance(3 * 3_600_000)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(openStreams()).toHaveLength(1)
    cookieOnly.close()

    FakeEventSource.all = []
    const f = await fallenBack()
    f.events.close()
    await advance(3 * DIRECT_RETRY_MAX_MS)
    expect(f.mint).toHaveBeenCalledTimes(3)
    expect(f.calls).toHaveLength(3)
  })

  it("'online' retries the direct stream at once; the tab becoming visible does too, but only once the cool-down is over", async () => {
    const page = stubPage()
    const a = await fallenBack()
    page.visibility('hidden')
    page.visibility('visible')
    await settle()
    expect(a.mint).toHaveBeenCalledTimes(3) // cool-down not over: leave it
    page.online() // the network changed: try the direct stream now
    await settle()
    expect(a.mint).toHaveBeenCalledTimes(4)
    expect(a.events.transport()).toBe('direct')
    a.events.close()

    FakeEventSource.all = []
    const b = await fallenBack()
    // the page slept: the clock moved on, the timer did not fire
    vi.setSystemTime(Date.now() + DIRECT_RETRY_MS + 1)
    page.visibility('visible')
    await settle()
    expect(b.mint).toHaveBeenCalledTimes(4)
    expect(b.events.transport()).toBe('direct')
    b.events.close()
  })
})

describe('createBoardEvents: a page that wakes up does not sit out the backoff (wave I1)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  it("'online' reconnects the direct stream at once instead of waiting out a 30 s backoff, and the backoff starts over", async () => {
    const page = stubPage()
    const d = direct({ mintWhen: () => new MintError(0) }) // offline: no response
    await settle()
    // attempts at 0, 1, 3, 7, 15, 31 s; the next would be at 61 s
    await advance(31_000)
    expect(d.mint).toHaveBeenCalledTimes(6)
    await advance(5_000)
    expect(d.mint).toHaveBeenCalledTimes(6)
    page.online()
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(7)
    await advance(1_000)
    expect(d.mint).toHaveBeenCalledTimes(8)
    d.events.close()
  })

  it('the tab becoming visible does the same; becoming hidden does nothing', async () => {
    const page = stubPage()
    const d = direct({ mintWhen: (n) => (n < 9 ? new MintError(0) : undefined) })
    await settle()
    await advance(31_000)
    await advance(10_000)
    const before = d.mint.mock.calls.length
    page.visibility('hidden')
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(before)
    page.visibility('visible')
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(before + 1)
    d.events.close()
  })

  it('a stream that is connected, or one the server told to wait ("replaced", 60 s), is left alone', async () => {
    const page = stubPage()
    const d = direct()
    await settle()
    d.last()?.push(frame('hello', hello))
    await settle()
    page.online()
    page.visibility('visible')
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(1)
    // 'replaced': the person has another tab; coming back must not push that one out in turn
    d.last()?.push(`retry: 60000\n${frame('replaced')}`)
    d.last()?.end()
    await advance(5_000)
    page.online()
    page.visibility('visible')
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(1)
    await advance(55_000)
    expect(d.mint).toHaveBeenCalledTimes(2)
    d.events.close()
  })

  it('a connection opened less than a second ago is not reopened (a flapping tab is not a storm)', async () => {
    const page = stubPage()
    const d = direct({ mintWhen: () => new MintError(0) })
    await settle()
    page.online() // attempt 1 is 0 ms old
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(1)
    await advance(1_000) // attempt 2 at 1 s; the next regular one would be at 3 s
    expect(d.mint).toHaveBeenCalledTimes(2)
    await advance(500)
    page.online()
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(2)
    await advance(500)
    page.online()
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(3) // at 2 s, not 3
    d.events.close()
  })

  it('the cookie stream too: after an HTTP error it reopens at once when the page wakes up', () => {
    vi.useRealTimers()
    vi.useFakeTimers()
    const page = stubPage()
    const events = createBoardEvents('b-1', { ...COOKIE_ONLY, staleMs: 60_000 })
    FakeEventSource.all[0]?.fail(FakeEventSource.CLOSED)
    vi.advanceTimersByTime(1_000)
    FakeEventSource.all[1]?.fail(FakeEventSource.CLOSED)
    vi.advanceTimersByTime(2_000)
    FakeEventSource.all[2]?.fail(FakeEventSource.CLOSED)
    // 4 s of backoff, 1 s in
    vi.advanceTimersByTime(1_000)
    expect(FakeEventSource.all).toHaveLength(3)
    page.online()
    expect(FakeEventSource.all).toHaveLength(4)
    expect(openStreams()).toHaveLength(1)
    // one stream at a time: the old backoff timer must not open another
    vi.advanceTimersByTime(10_000)
    expect(FakeEventSource.all).toHaveLength(4)
    events.close()
  })

  it('close() stops listening: a closed stream never reopens', async () => {
    const page = stubPage()
    const d = direct({ mintWhen: () => new MintError(0) })
    await settle()
    d.events.close()
    await advance(5_000)
    page.online()
    page.visibility('visible')
    await settle()
    expect(d.mint).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.all).toHaveLength(0)
  })
})

describe('createSseParser', () => {
  const parse = (chunks: string[]) => {
    const messages: string[] = []
    const retries: number[] = []
    const p = createSseParser({ message: (d) => messages.push(d), retry: (ms) => retries.push(ms) })
    for (const c of chunks) p.feed(c)
    return { messages, retries }
  }

  it('reads LF, CRLF (even split across chunks) and CR line ends, joins data lines, and skips comments', () => {
    expect(
      parse(['data: a\n\n', 'data: b\r', '\n\r\n', 'data: c\rdata: d\r\r', ': comment\n\n']).messages,
    ).toEqual(['a', 'b', 'c\nd'])
    expect(parse(['﻿data: x\n\n']).messages).toEqual(['x'])
    expect(parse(['data:no-space\n', 'data\n\n']).messages).toEqual(['no-space\n'])
  })

  it('takes retry, ignores ids and unknown fields, and drops named (non-message) events and unfinished ones', () => {
    const r = parse([
      'retry: 60000\nid: 7\nfoo: bar\ndata: m\n\n',
      'event: other\ndata: x\n\n',
      'retry: soon\n',
      'data: cut',
    ])
    expect(r.messages).toEqual(['m'])
    expect(r.retries).toEqual([60_000])
  })
})

describe('mintEventsTicket', () => {
  it('POSTs same-origin and reads the answer; failures carry the status (0 = no response)', async () => {
    const answers: (Response | Error)[] = [
      new Response(JSON.stringify({ url: DIRECT_URL, ticket: 'evt_x', expiresAt: 'later' }), { status: 200 }),
      new Response(JSON.stringify({ url: null }), { status: 200 }),
      new Response(JSON.stringify({ url: 'javascript:alert(1)', ticket: 'evt_x' }), { status: 200 }),
      new Response('{"error":{"code":"NOT_FOUND","message":"Not found."}}', { status: 404 }),
      new TypeError('Failed to fetch'),
    ]
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        const a = answers.shift()
        if (a instanceof Error) throw a
        return a
      }),
    )
    expect(await mintEventsTicket('b 1')).toEqual({ url: DIRECT_URL, ticket: 'evt_x' })
    expect(calls[0]?.url).toBe('/api/boards/b%201/events/ticket')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(await mintEventsTicket('b')).toEqual({ url: null })
    // An answer this build cannot use is the cookie stream.
    expect(await mintEventsTicket('b')).toEqual({ url: null })
    await expect(mintEventsTicket('b')).rejects.toMatchObject({ name: 'MintError', status: 404 })
    await expect(mintEventsTicket('b')).rejects.toMatchObject({ name: 'MintError', status: 0 })
  })
})
