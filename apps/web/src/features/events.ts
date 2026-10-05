// Client for GET /api/boards/:bid/events (server-sent events; see apps/api/src/events). One stream
// per open board, shared by every feature. Events are hints: on every (re)open the stream emits
// 'hello' and features re-fetch their authoritative state through onResync.
//
// Two transports (wave H1, apps/api/src/events/tickets.ts):
// - direct: the page mints a ticket same-origin (POST /api/boards/:bid/events/ticket, the session
//   cookie) and fetches the stream from the api's own origin, the URL the api answers, with the ticket in
//   `Authorization: Bearer` (never in the URL: edge logs record URLs) and no cookie. Read as a fetch
//   stream (an EventSource cannot send a header), parsed here like an EventSource would. The reason:
//   Render's static-site rewrite holds a streamed response until it ends, so through the page's origin
//   the stream delivered nothing live (measured on staging 2026-10-05). Every attempt mints a fresh
//   ticket (single use, ~30 s).
// - cookie: an EventSource on the page's own origin, as before H1. Used when the api answers that it has
//   no direct origin ({ url: null }: dev, e2e by default), when the mint route is missing or refuses the
//   board (an older api, no access: the cookie stream gives today's answer), and for good once the direct
//   origin failed MAX_DIRECT_FAILURES times in a row before saying hello (a CSP that does not list it,
//   CORS, DNS, a proxy that buffers): never worse than before H1.
//
// Liveness: the api sends a data 'ping' every 15 s. A proxy between the browser and the api (vite
// dev/preview, a static-site rewrite) can keep the browser's side open after the api died, and an
// SSE comment never reaches JS, so a stream that delivers nothing for `staleMs` is treated as dead
// and replaced by a fresh one (whose 'hello' makes every feature refetch).

export interface BoardEventMessage {
  type: string
  data: unknown
  seq: number
  at?: string
}

type Listener = (data: unknown, message: BoardEventMessage) => void

export interface BoardEvents {
  /** Subscribe to one event type; returns an unsubscribe function. */
  on(type: string, listener: Listener): () => void
  /** Called after every (re)connect (and immediately if already connected): refetch your state. */
  onResync(listener: () => void): () => void
  /**
   * Server time minus local time in ms, from the last 'hello': serverNow minus the local time the
   * message was handled. One-way, so it also absorbs every delay before handling (network, a busy
   * main thread); a countdown that must agree across people should measure a round trip instead
   * (features/workshops/store.ts does).
   */
  serverOffsetMs(): number
  /** Server-side access loss (the stream says so before closing). */
  onAccessLost(listener: () => void): () => void
  close(): void
}

/** What createBoardEvents returns: BoardEvents, and which transport it uses (tests and diagnostics). */
export interface BoardEventStream extends BoardEvents {
  /** The transport of the current or next connection: 'direct' until it falls back to 'cookie'. */
  transport(): 'direct' | 'cookie'
}

/** Nothing received for this long (the api pings every 15 s) => the stream is dead: reopen it. */
export const STALE_STREAM_MS = 40_000
/** Direct attempts in a row that end before 'hello' after which this board session uses the cookie stream. */
export const MAX_DIRECT_FAILURES = 3
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

/** POST /api/boards/:bid/events/ticket's answer (apps/api/src/events/routes.ts EventsTicketResponse). */
export type EventsTicket = { url: string; ticket: string } | { url: null }

/** A failed mint: the HTTP status, or 0 when there was no response. */
export class MintError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`events ticket: ${status || 'no response'}`)
    this.name = 'MintError'
    this.status = status
  }
}

/** The same-origin mint (the session cookie goes with it; the api checks the Origin of every POST). */
export async function mintEventsTicket(boardId: string, signal?: AbortSignal): Promise<EventsTicket> {
  let res: Response
  try {
    res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/events/ticket`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    })
  } catch {
    throw new MintError(0)
  }
  if (!res.ok) throw new MintError(res.status)
  const body: unknown = await res.json().catch(() => null)
  const b = body as { url?: unknown; ticket?: unknown } | null
  if (b && b.url === null) return { url: null }
  if (b && typeof b.url === 'string' && typeof b.ticket === 'string') {
    let url: URL | null = null
    try {
      url = new URL(b.url)
    } catch {}
    if (url && (url.protocol === 'https:' || url.protocol === 'http:'))
      return { url: url.href, ticket: b.ticket }
  }
  // An answer this build cannot use: the cookie stream, as if the api had no direct origin.
  return { url: null }
}

/**
 * An event-stream parser as the HTML spec defines it (what an EventSource runs before onmessage): lines
 * end with CRLF, LF or CR; ':' starts a comment; `data` lines are joined with '\n'; a blank line
 * dispatches the event if it has data; `retry` sets the reconnection delay; an event with an `event`
 * name other than "message" is not a message (EventSource's onmessage never sees it). A chunk may end
 * anywhere, a CRLF included.
 */
export function createSseParser(handlers: { message(data: string): void; retry?(ms: number): void }) {
  let buf = ''
  let first = true
  let skipLf = false
  let data: string[] = []
  let eventName = ''
  const line = (l: string) => {
    if (l === '') {
      if (data.length && (eventName === '' || eventName === 'message')) handlers.message(data.join('\n'))
      data = []
      eventName = ''
      return
    }
    if (l.startsWith(':')) return
    const colon = l.indexOf(':')
    const field = colon < 0 ? l : l.slice(0, colon)
    let value = colon < 0 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') eventName = value
    else if (field === 'retry' && /^\d+$/.test(value)) handlers.retry?.(Number(value))
  }
  return {
    feed(chunk: string) {
      let text = chunk
      if (first && text.length) {
        first = false
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      if (skipLf && text.startsWith('\n')) text = text.slice(1)
      skipLf = false
      buf += text
      for (;;) {
        const i = buf.search(/[\r\n]/)
        if (i < 0) return
        line(buf.slice(0, i))
        if (buf[i] === '\r') {
          if (i + 1 < buf.length) buf = buf.slice(buf[i + 1] === '\n' ? i + 2 : i + 1)
          else {
            buf = ''
            skipLf = true // the LF of a CRLF may start the next chunk
          }
        } else buf = buf.slice(i + 1)
      }
    },
  }
}

export interface BoardEventsOptions {
  /** The same-origin stream (cookie transport). Default /api/boards/:bid/events. */
  url?: string
  staleMs?: number
  /**
   * Mints a ticket for the direct transport (default mintEventsTicket). `null`: never try it (the cookie
   * stream only).
   */
  mintTicket?: ((boardId: string, signal: AbortSignal) => Promise<EventsTicket>) | null
  /** The direct transport's fetch (default: the global one, read per call). */
  fetchImpl?: typeof fetch
  maxDirectFailures?: number
}

const directSupported = () =>
  typeof fetch === 'function' && typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined'

export function createBoardEvents(boardId: string, opts: BoardEventsOptions = {}): BoardEventStream {
  const url = opts.url ?? `/api/boards/${encodeURIComponent(boardId)}/events`
  const staleMs = opts.staleMs ?? STALE_STREAM_MS
  const mint = opts.mintTicket === undefined ? mintEventsTicket : opts.mintTicket
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const maxDirectFailures = opts.maxDirectFailures ?? MAX_DIRECT_FAILURES
  const listeners = new Map<string, Set<Listener>>()
  const resync = new Set<() => void>()
  const lost = new Set<() => void>()
  let offset = 0
  let connected = false
  let closed = false
  let mode: 'direct' | 'cookie' = mint && directSupported() ? 'direct' : 'cookie'
  let directFailures = 0
  let source: EventSource | null = null
  let controller: AbortController | null = null
  /** Bumped by every new connection and by close(): callbacks of an earlier one do nothing. */
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryMs = FIRST_RETRY_MS
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  const clearStale = () => {
    if (staleTimer) clearTimeout(staleTimer)
    staleTimer = null
  }

  const emit = (msg: BoardEventMessage) => {
    for (const l of listeners.get(msg.type) ?? []) {
      try {
        l(msg.data, msg)
      } catch (e) {
        console.error('board event listener failed', msg.type, e)
      }
    }
  }

  /** One message's data, from either transport. Returns its type ('' when it is not JSON). */
  const handle = (raw: string): string => {
    let msg: BoardEventMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return ''
    }
    if (msg.type === 'hello') {
      const serverNow = Date.parse((msg.data as { serverNow?: string } | null)?.serverNow ?? '')
      if (!Number.isNaN(serverNow)) offset = serverNow - Date.now()
      connected = true
      retryMs = FIRST_RETRY_MS
      for (const r of resync) r()
    } else if (msg.type === 'access-lost') {
      for (const l of lost) l()
    }
    emit(msg)
    return msg.type
  }

  /** Drops the current connection (if any) and its timers; later callbacks of it do nothing. */
  const drop = () => {
    attempt++
    clearStale()
    connected = false
    source?.close()
    source = null
    controller?.abort()
    controller = null
  }
  const schedule = (ms: number) => {
    if (closed) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(open, ms)
  }
  const backoff = () => {
    const ms = retryMs
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    schedule(ms)
  }

  const open = () => {
    retryTimer = null
    if (closed) return
    if (mode === 'cookie') openCookie()
    else void openDirect()
  }

  const useCookie = (why: string) => {
    if (mode === 'cookie') return
    mode = 'cookie'
    if (why) console.warn(`Lobby: live board updates use the page's own origin from now on (${why}).`)
    drop()
    open()
  }

  // ---- cookie transport (same-origin EventSource) ----------------------------------------------------

  function openCookie() {
    if (typeof EventSource === 'undefined') return
    drop()
    const mine = attempt
    // Same-origin: the session cookie goes with the request; no credentials flag needed.
    const es = new EventSource(url)
    source = es
    // Armed on open and re-armed by every message.
    const armStale = () => {
      clearStale()
      staleTimer = setTimeout(() => {
        staleTimer = null
        if (closed || attempt !== mine) return
        drop()
        open()
      }, staleMs)
    }
    armStale()
    es.onmessage = (ev) => {
      if (attempt !== mine) return
      armStale()
      handle(ev.data)
    }
    es.onerror = () => {
      if (attempt !== mine) return
      // EventSource retries by itself for network errors, but gives up on HTTP errors (401/404):
      // take over with our own bounded backoff so a restarted API is picked up again.
      connected = false
      if (es.readyState === EventSource.CLOSED) {
        drop()
        backoff()
      }
    }
  }

  // ---- direct transport (a ticket, a fetch stream on the api's origin) ---------------------------------

  /** A direct attempt that ended before 'hello': counted; past the limit, the cookie stream for good. */
  const directFailed = (why: string) => {
    directFailures++
    drop()
    if (directFailures >= maxDirectFailures) useCookie(why)
    else backoff()
  }

  async function openDirect() {
    drop()
    const mine = attempt
    const ac = new AbortController()
    controller = ac
    const stale = () => attempt !== mine
    let hello = false
    /** A mint that hangs is the page origin's problem, not the direct origin's: not counted. */
    let minting = true
    let serverRetryMs: number | null = null
    // Armed for the mint and the connect too, then re-armed by every message.
    const armStale = () => {
      clearStale()
      staleTimer = setTimeout(() => {
        staleTimer = null
        if (closed || stale()) return
        if (hello || minting) {
          drop()
          open()
        } else directFailed(`no answer within ${Math.round(staleMs / 1000)} s`)
      }, staleMs)
    }
    armStale()

    let ticket: EventsTicket
    try {
      ticket = await (mint as NonNullable<typeof mint>)(boardId, ac.signal)
    } catch (e) {
      if (stale()) return
      const status = e instanceof MintError ? e.status : 0
      // No mint route (an api older than this page) or no access: the cookie stream answers as before.
      if (status === 403 || status === 404) return useCookie('')
      // Signed out, rate limited, the api restarting or unreachable: that is not the direct origin's fault.
      drop()
      return backoff()
    }
    if (stale()) return
    if (ticket.url === null) return useCookie('')
    minting = false

    let res: Response
    try {
      res = await fetchImpl(ticket.url, {
        method: 'GET',
        headers: { authorization: `Bearer ${ticket.ticket}`, accept: 'text/event-stream' },
        credentials: 'omit',
        cache: 'no-store',
        mode: 'cors',
        signal: ac.signal,
      })
    } catch {
      // A network error, CORS or a CSP that does not list the origin (all look the same from here).
      if (!stale()) directFailed('the api origin cannot be reached')
      return
    }
    if (stale()) {
      void res.body?.cancel().catch(() => {})
      return
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      // 401: a ticket refused (expired, used, or an api that never minted it: a misconfigured origin).
      if (res.status === 401) return directFailed('the api origin refused the ticket')
      // 404/403 (access gone), 429/503 (busy), 5xx: the api answered; try again later.
      drop()
      return backoff()
    }
    const type = res.headers.get('content-type') ?? ''
    if (!res.body || !type.toLowerCase().startsWith('text/event-stream'))
      return directFailed('the api origin did not answer with an event stream')

    const parser = createSseParser({
      message: (data) => {
        if (stale()) return
        armStale()
        if (handle(data) === 'hello' && !hello) {
          hello = true
          directFailures = 0
        }
      },
      retry: (ms) => {
        serverRetryMs = ms
      },
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (stale()) {
          void reader.cancel().catch(() => {})
          return
        }
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
      }
    } catch {
      // the connection dropped (or we aborted it: then stale() below)
    }
    if (stale() || closed) return
    // The server ended the stream ('replaced' with its retry, 'session-ended', a deploy) or it dropped.
    if (!hello) return directFailed('the stream ended before it started')
    drop()
    schedule(serverRetryMs ?? retryMs)
  }

  open()

  return {
    on(type, listener) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => void set?.delete(listener)
    },
    onResync(listener) {
      resync.add(listener)
      if (connected) listener()
      return () => void resync.delete(listener)
    },
    serverOffsetMs: () => offset,
    onAccessLost(listener) {
      lost.add(listener)
      return () => void lost.delete(listener)
    },
    transport: () => mode,
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      drop()
      listeners.clear()
      resync.clear()
      lost.clear()
    },
  }
}
