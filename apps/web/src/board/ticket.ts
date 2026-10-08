import { CANVAS_STARTING_ERROR, type TicketResponse } from '@draftroom/contracts'
import { isApiError } from '../api/client.ts'

export interface TicketUriOptions {
  boardId: string
  fetchTicket(boardId: string): Promise<TicketResponse>
  /** Every successful ticket (the role can change between reconnects). */
  onTicket(ticket: TicketResponse): void
  /** 403/404 from the ticket endpoint: access is gone (revoked, trashed, never had it). */
  onAccessLost(): void
  /** 401: the session ended. */
  onSignedOut(): void
  /**
   * 409 NEW_CANVAS (bridge release R0): the board was made on the new canvas and this build cannot open
   * it; nothing is retried. Absent: treated like any other failure (retried).
   */
  onNewCanvas?(): void
  /**
   * Where the page is served from. By default the socket goes to the same origin (the Vite proxy in dev,
   * or a single-origin edge that proxies /connect).
   */
  origin: { protocol: string; host: string }
  /**
   * A separate sync origin for the socket. Omitted: the build-time `VITE_DRAFTROOM_SYNC_ORIGIN` (unset =
   * the page origin). `null`: always the page origin.
   */
  syncOrigin?: string | null
  /**
   * K6-1: called before each wait of a retry (the page says "Connecting" meanwhile): `starting` when the api
   * answered 503 CANVAS_STARTING (it has not reached the board server since it started), retried on the
   * short STARTING_BACKOFF_MS; otherwise a transient failure on `backoffMs`.
   */
  onConnecting?(info: TicketRetry): void
  sleep?: (ms: number) => Promise<void>
  backoffMs?: readonly number[]
  /** The waits between tries while the api is starting (default STARTING_BACKOFF_MS). */
  startingBackoffMs?: readonly number[]
}

/** One retry of a ticket: which try failed, how long until the next, and whether the api is starting. */
export interface TicketRetry {
  readonly attempt: number
  readonly waitMs: number
  readonly starting: boolean
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 5000] as const
/**
 * K6-1: the waits while the api answers 503 CANVAS_STARTING (Retry-After 2 s): short, because the api asks
 * sync again and again until it answers, and the first ticket after that succeeds. Never past 2 s.
 */
export const STARTING_BACKOFF_MS: readonly number[] = [250, 500, 1_000, 1_000, 2_000]

/**
 * 503 CANVAS_STARTING (K6-1): the api does not know yet which canvas its sync runs. A retry, never the
 * NEW_CANVAS refusal (409) it used to be mistaken for.
 */
export const isCanvasStarting = (e: unknown): boolean =>
  isApiError(e) && e.status === 503 && e.code === CANVAS_STARTING_ERROR

/**
 * The build-time sync origin, e.g. `https://draftroom-staging-sync.onrender.com` (Render static sites
 * cannot proxy WebSockets, docs/DEPLOY.md). Vite inlines it into the bundle; read per call so tests can stub it.
 */
export function buildTimeSyncOrigin(): string | undefined {
  const v: unknown = import.meta.env.VITE_DRAFTROOM_SYNC_ORIGIN
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export type SocketOrigin = { ok: true; base: string } | { ok: false; base: string; error: string }

const SOCKET_SCHEME: Record<string, 'ws:' | 'wss:'> = {
  'http:': 'ws:',
  'https:': 'wss:',
  'ws:': 'ws:',
  'wss:': 'wss:',
}

/**
 * `ws(s)://host[:port]` for board sockets: the page's own origin, or `configured` (an http(s) or ws(s)
 * origin; http -> ws, https -> wss). A configured value that is not an origin, or an insecure socket
 * from an https page (browsers block it as mixed content), is refused with `ok: false` and the page
 * origin as the fallback base, so a bad build setting is reported instead of silently misrouting.
 */
export function syncSocketOrigin(
  page: { protocol: string; host: string },
  configured?: string,
): SocketOrigin {
  const pageBase = `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}`
  if (configured === undefined || configured.trim() === '') return { ok: true, base: pageBase }
  let url: URL | null = null
  try {
    url = new URL(configured.trim())
  } catch {}
  const scheme = url ? SOCKET_SCHEME[url.protocol] : undefined
  if (
    !url ||
    !scheme ||
    !url.host ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return {
      ok: false,
      base: pageBase,
      error: 'VITE_DRAFTROOM_SYNC_ORIGIN must be an origin only (https://host[:port] or wss://host[:port])',
    }
  if (page.protocol === 'https:' && scheme === 'ws:')
    return {
      ok: false,
      base: pageBase,
      error: 'VITE_DRAFTROOM_SYNC_ORIGIN must be https/wss when the page is served over https',
    }
  return { ok: true, base: `${scheme}//${url.host}` }
}

// L7: the ticket travels in the WebSocket handshake, not the socket URL (./ticket-protocol.ts, NODE-SAFE so
// the sync server's tests run the very constructor the board session uses).
export {
  BOARD_SOCKET_PROTOCOL,
  TICKET_PROTOCOL_PREFIX,
  ticketInProtocol,
  ticketProtocols,
} from './ticket-protocol.ts'

/** Settles never: used once the board is being torn down, so useSync makes no further attempt. */
const never = () => new Promise<string>(() => {})

/**
 * Builds useSync's `uri` function. It runs on EVERY (re)connect and fetches a fresh 60 s ticket.
 *
 * useSync's reconnect manager calls `uri()` without a catch: a rejected promise would silently stop
 * reconnecting. So this never rejects. Transient failures (API restarting, offline) are retried here
 * with backoff; access and session failures notify the page and then never settle, because the page
 * replaces the board with a "no access" or sign-in screen (unmounting useSync).
 */
export function createTicketUri(opts: TicketUriOptions) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF
  const startingBackoff = opts.startingBackoffMs ?? STARTING_BACKOFF_MS
  /** A try failed and the next one is waited for (the page shows "Connecting"). */
  let retrying = false
  // Bumped by cancel(): attempts from an earlier generation stop and never settle.
  let generation = 0
  let inflight: Promise<string> | null = null

  const target = syncSocketOrigin(
    opts.origin,
    opts.syncOrigin === undefined ? buildTimeSyncOrigin() : (opts.syncOrigin ?? undefined),
  )
  // A build misconfiguration: say so once (the socket then tries the page origin, as before).
  if (!target.ok) console.error(`Draftroom: ${target.error}; connecting to this page's origin instead.`)
  const wsBase = () => `${target.base}/connect/${encodeURIComponent(opts.boardId)}`

  async function attempt(): Promise<string> {
    const gen = generation
    const stale = () => gen !== generation
    let transient = 0
    let starting = 0
    for (let i = 0; ; i++) {
      if (stale()) return never()
      try {
        const t = await opts.fetchTicket(opts.boardId)
        if (stale()) return never()
        retrying = false
        opts.onTicket(t)
        // The caller appends sessionId. The ticket is a secret: it only ever appears here, and the board
        // socket (ticketInProtocol) moves it into the handshake before the URL goes anywhere.
        return `${wsBase()}?${new URLSearchParams({ ticket: t.ticket })}`
      } catch (e) {
        if (stale()) return never()
        if (isApiError(e) && (e.kind === 'forbidden' || e.kind === 'not-found')) {
          opts.onAccessLost()
          return never()
        }
        if (isApiError(e) && e.kind === 'unauthorized') {
          opts.onSignedOut()
          return never()
        }
        if (isApiError(e) && e.code === 'NEW_CANVAS' && opts.onNewCanvas) {
          opts.onNewCanvas()
          return never()
        }
        // K6-1: the api is starting (503 CANVAS_STARTING): again soon. Anything else transient: the backoff.
        const isStarting = isCanvasStarting(e)
        const waitMs = isStarting
          ? (startingBackoff[Math.min(starting++, startingBackoff.length - 1)] ?? 2_000)
          : (backoff[Math.min(transient++, backoff.length - 1)] ?? 5000)
        retrying = true
        try {
          opts.onConnecting?.({ attempt: i + 1, waitMs, starting: isStarting })
        } catch (err) {
          console.error('Lobby: a ticket retry listener failed', err)
        }
        await sleep(waitMs)
      }
    }
  }

  return {
    /** K6-1: a ticket try failed and the next one is being waited for (the page says "Connecting"). */
    connecting: () => retrying,
    /** Stable for the lifetime of one board session; pass it to useSync as `uri`. */
    uri(): Promise<string> {
      // The reconnect manager can ask again while a slow attempt is still running (on 'online' /
      // visibility events); share one attempt rather than racing several ticket requests.
      if (inflight) return inflight
      const p: Promise<string> = attempt().finally(() => {
        if (inflight === p) inflight = null
      })
      inflight = p
      return p
    },
    /**
     * Abandons any attempt in flight (the board session unmounted, or React StrictMode simulated
     * it). A later uri() call starts a fresh attempt.
     */
    cancel() {
      generation++
      inflight = null
      retrying = false
    },
  }
}

/**
 * K6-1: the board page's FIRST ticket (who this is, before the board session exists), retried like the
 * session's own while the api is starting (503 CANVAS_STARTING: STARTING_BACKOFF_MS, "Connecting") for at
 * most `maxWaitMs`. Any other failure, or one that lasts, is thrown as it was (the page shows its error
 * screen). Aborting `signal` stops the waits and throws its reason.
 */
export async function firstTicketWhileStarting(
  fetchTicket: (signal?: AbortSignal) => Promise<TicketResponse>,
  opts: {
    signal?: AbortSignal
    onConnecting?(info: TicketRetry): void
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    backoffMs?: readonly number[]
    maxWaitMs?: number
  } = {},
): Promise<TicketResponse> {
  const backoff = opts.backoffMs ?? STARTING_BACKOFF_MS
  const maxWaitMs = opts.maxWaitMs ?? 30_000
  const sleep =
    opts.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(signal.reason)
        })
      }))
  let waited = 0
  for (let i = 0; ; i++) {
    try {
      return await fetchTicket(opts.signal)
    } catch (e) {
      if (!isCanvasStarting(e) || opts.signal?.aborted) throw e
      const waitMs = backoff[Math.min(i, backoff.length - 1)] ?? 2_000
      if (waited + waitMs > maxWaitMs) throw e
      waited += waitMs
      opts.onConnecting?.({ attempt: i + 1, waitMs, starting: true })
      await sleep(waitMs, opts.signal)
    }
  }
}
