import type { TicketResponse } from '@draftroom/contracts'
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
  sleep?: (ms: number) => Promise<void>
  backoffMs?: readonly number[]
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 5000] as const

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
    for (let i = 0; ; i++) {
      if (stale()) return never()
      try {
        const t = await opts.fetchTicket(opts.boardId)
        if (stale()) return never()
        opts.onTicket(t)
        // useSync appends sessionId/storeId. The ticket is a secret: it only ever appears here.
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
        await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 5000)
      }
    }
  }

  return {
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
    },
  }
}
