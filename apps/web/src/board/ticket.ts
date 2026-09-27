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
  /** Where the page is served from; the socket goes to the same origin (Vite/edge proxies /connect). */
  origin: { protocol: string; host: string }
  sleep?: (ms: number) => Promise<void>
  backoffMs?: readonly number[]
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 5000] as const

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

  const wsBase = () => {
    const scheme = opts.origin.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${opts.origin.host}/connect/${encodeURIComponent(opts.boardId)}`
  }

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
