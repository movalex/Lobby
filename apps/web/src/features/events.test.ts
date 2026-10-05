import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type BoardEventsOptions,
  createBoardEvents,
  createSseParser,
  type EventsTicket,
  MAX_DIRECT_FAILURES,
  MintError,
  mintEventsTicket,
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

function direct(opts: { outcomes?: Outcome[]; mints?: (EventsTicket | MintError)[]; staleMs?: number } = {}) {
  let minted = 0
  const mint = vi.fn(async (_boardId: string, _signal: AbortSignal): Promise<EventsTicket> => {
    const next = opts.mints?.shift()
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
