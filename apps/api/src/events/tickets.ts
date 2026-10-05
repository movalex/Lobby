// Board event-stream tickets (wave H1): how a browser opens GET /api/boards/:bid/events DIRECTLY on the
// api's own origin instead of through the static site's /api/* rewrite.
//
// Why: Render's static-site rewrite proxy holds every response until it ENDS (measured on staging
// 2026-10-05 with GET /api/diag/stream: first byte 0.23 s direct, 3.25 s = the whole response through the
// rewrite). The event stream never ends, so through the rewrite nothing arrived live; events only came
// with the 40 s stale-stream reconnect's resync. The board socket already goes direct to the sync origin
// for the same kind of reason (apps/web/src/board/ticket.ts).
//
// How (routes.ts):
//  1. POST /api/boards/:bid/events/ticket, same-origin through the rewrite: the session cookie and the
//     api's Origin check (CSRF) apply as to every mutation; view permission on the board. Answers
//     { url, ticket, expiresAt } when DRAFTROOM_EVENTS_ORIGIN is set, { url: null } when it is not (dev,
//     e2e by default: the page keeps the same-origin cookie stream).
//  2. GET <url> with `Authorization: Bearer <ticket>` from the page's origin (CORS: exactly PUBLIC_ORIGIN,
//     no credentials; the header makes it a preflighted request). The ticket never rides a URL, so neither
//     Fastify's logs nor Render's edge logs (which record URLs) ever see it. The ticket is consumed (single
//     use, ~30 s), and the request then runs the SAME path as a cookie request: the ticket stands for the
//     session that minted it, so every hook keyed on the route (the guests' per-link stream cap), the
//     session check, opens.take, requireBoardAction(view) and hub.openStream see that person and that
//     session. The 10 s revalidation, endSessions and the per-person caps follow from that unchanged.
//
// What a ticket is: an opaque random value (`evt_` + 32 random bytes, base64url), held in THIS process's
// memory only (one api instance, like the in-process event hub; a restart forgets every ticket, and the
// page mints a new one on its next attempt). It is not a session cookie (the prefix and length fail the
// cookie's format check) and not a sync ticket (packages/auth-tickets signs those; this store only knows
// its own values), so none of the three can stand in for another. The entry keeps the minting session's
// cookie value so the stream request can be run as that session; that value never leaves this process,
// is never logged and is dropped with the entry.

import { randomBytes } from 'node:crypto'

/** How long a minted ticket may wait for its stream request. */
export const EVENTS_TICKET_TTL_MS = 30_000
/** Tickets waiting in this process; past it a mint is refused (503) until some expire or are used. */
export const MAX_OUTSTANDING_TICKETS = 10_000
/** Tickets one session may have waiting; minting another drops that session's oldest. */
export const MAX_TICKETS_PER_SESSION = 4

const PREFIX = 'evt_'
const TICKET_RE = /^evt_[A-Za-z0-9_-]{43}$/

/** Whether a value has the shape of an event-stream ticket (says nothing about whether it is valid). */
export const isEventTicket = (value: unknown): value is string =>
  typeof value === 'string' && TICKET_RE.test(value)

export interface EventTicketClaims {
  boardId: string
  userId: string
  /** sha256 of the session cookie (the hub's StreamInfo.sessionId). */
  sessionId: string
  /** The minting session's cookie value: the stream request runs as this session. Never logged. */
  sessionToken: string
  /** Epoch ms after which the ticket is refused. */
  expiresAt: number
}

export interface EventTicketStore {
  /** A fresh ticket for these claims, or null when the process holds MAX_OUTSTANDING_TICKETS already. */
  mint(claims: Omit<EventTicketClaims, 'expiresAt'>): { ticket: string; expiresAt: number } | null
  /**
   * Takes the ticket out of the store and returns its claims if it had not expired. Single use: a ticket
   * that was consumed (or expired, or never existed) answers null from then on.
   */
  consume(ticket: string): EventTicketClaims | null
  /** Drops every ticket of these sessions (logout, sign out everywhere, a revoked guest). */
  revokeSessions(ids: readonly string[]): void
  /** Drops expired tickets. */
  sweep(): void
  readonly size: number
}

export function createEventTicketStore(
  opts: {
    now: () => Date
    ttlMs?: number
    max?: number
    perSession?: number
    /** Test seam: the random part (32 bytes, base64url). */
    random?: () => string
  } = { now: () => new Date() },
): EventTicketStore {
  const ttlMs = opts.ttlMs ?? EVENTS_TICKET_TTL_MS
  const max = opts.max ?? MAX_OUTSTANDING_TICKETS
  const perSession = opts.perSession ?? MAX_TICKETS_PER_SESSION
  const random = opts.random ?? (() => randomBytes(32).toString('base64url'))
  const at = () => opts.now().getTime()
  /** ticket -> claims, in mint order (a Map iterates in insertion order). */
  const tickets = new Map<string, EventTicketClaims>()
  /** sessionId -> its waiting tickets, oldest first. */
  const bySession = new Map<string, string[]>()

  const forget = (ticket: string, claims: EventTicketClaims) => {
    tickets.delete(ticket)
    const list = bySession.get(claims.sessionId)
    if (!list) return
    const i = list.indexOf(ticket)
    if (i >= 0) list.splice(i, 1)
    if (list.length === 0) bySession.delete(claims.sessionId)
  }

  const sweep = () => {
    const now = at()
    // Mint order is expiry order (one TTL for all): stop at the first one still valid.
    for (const [ticket, claims] of tickets) {
      if (claims.expiresAt > now) break
      forget(ticket, claims)
    }
  }

  return {
    mint(claims) {
      sweep()
      if (tickets.size >= max) return null
      const mine = bySession.get(claims.sessionId) ?? []
      while (mine.length >= perSession) {
        const oldest = mine[0]
        const old = oldest === undefined ? undefined : tickets.get(oldest)
        if (oldest === undefined || !old) {
          mine.shift()
          continue
        }
        forget(oldest, old)
      }
      let ticket = `${PREFIX}${random()}`
      // 256 random bits never collide; a test seam might.
      while (tickets.has(ticket)) ticket = `${PREFIX}${randomBytes(32).toString('base64url')}`
      const expiresAt = at() + ttlMs
      tickets.set(ticket, { ...claims, expiresAt })
      const list = bySession.get(claims.sessionId) ?? []
      list.push(ticket)
      bySession.set(claims.sessionId, list)
      return { ticket, expiresAt }
    },
    consume(ticket) {
      if (!isEventTicket(ticket)) return null
      const claims = tickets.get(ticket)
      if (!claims) return null
      forget(ticket, claims)
      return claims.expiresAt > at() ? claims : null
    },
    revokeSessions(ids) {
      for (const id of ids) {
        for (const ticket of [...(bySession.get(id) ?? [])]) {
          const claims = tickets.get(ticket)
          if (claims) forget(ticket, claims)
        }
        bySession.delete(id)
      }
    },
    sweep,
    get size() {
      return tickets.size
    },
  }
}
