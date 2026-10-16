// Backup download tickets (wave R, WS4; docs/WAVE-R-CONTRACTS.md §5). A `.lobby` download is streamed from the api's
// own origin, not through the static site's /api rewrite (Render's rewrite holds a response until it ends: a 2 GiB
// download would sit in its buffer), and a browser download is a plain navigation that carries no header of ours.
// So, as the event stream does (events/tickets.ts), the page first asks for a ticket same-origin (the session cookie,
// the Origin check, the route's permission checks) and then opens `<api origin>/api/boards/:bid/backup?ticket=…`.
//
// A ticket is an opaque random value (`bkt_` + 32 random bytes, base64url) held in THIS process's memory only, for
// BACKUP_LIMITS.ticketMs, single use, for one board, standing for the session that minted it: the download is refused
// once that session ended (logout, sign out everywhere, a revoked guest) or the ticket was used, and the board's checks
// run again as that person. It rides the URL (a navigation cannot send a header), which is why it is single use and
// short-lived; the api never logs URLs (request logging is off; the access log names the route pattern only).

import { randomBytes } from 'node:crypto'
import { BACKUP_LIMITS } from '@draftroom/contracts'

/** Tickets waiting in this process; past it a mint is refused (503) until some expire or are used. */
export const MAX_BACKUP_TICKETS = 1_000
/** Tickets one session may have waiting; minting another drops that session's oldest. */
export const MAX_BACKUP_TICKETS_PER_SESSION = 4

const TICKET_RE = /^bkt_[A-Za-z0-9_-]{43}$/

export interface BackupTicketClaims {
  boardId: string
  userId: string
  /** the minting session's id (sha256 of its cookie; never the cookie itself) */
  sessionId: string
  expiresAt: number
}

export interface BackupTicketStore {
  mint(claims: Omit<BackupTicketClaims, 'expiresAt'>): { ticket: string; expiresAt: number } | null
  /** takes the ticket out of the store; its claims if it had not expired (single use) */
  consume(ticket: unknown): BackupTicketClaims | null
  revokeSessions(ids: readonly string[]): void
  sweep(): void
  readonly size: number
}

export function createBackupTicketStore(opts: {
  now: () => Date
  ttlMs?: number
  random?: () => string
}): BackupTicketStore {
  const ttl = opts.ttlMs ?? BACKUP_LIMITS.ticketMs
  const random = opts.random ?? (() => randomBytes(32).toString('base64url'))
  const at = () => opts.now().getTime()
  const tickets = new Map<string, BackupTicketClaims>()

  const sweep = () => {
    const now = at()
    // mint order is expiry order (one TTL for all)
    for (const [ticket, claims] of tickets) {
      if (claims.expiresAt > now) break
      tickets.delete(ticket)
    }
  }

  return {
    mint(claims) {
      sweep()
      if (tickets.size >= MAX_BACKUP_TICKETS) return null
      const mine = [...tickets].filter(([, c]) => c.sessionId === claims.sessionId)
      for (const [ticket] of mine.slice(0, Math.max(0, mine.length - MAX_BACKUP_TICKETS_PER_SESSION + 1)))
        tickets.delete(ticket)
      let ticket = `bkt_${random()}`
      while (tickets.has(ticket) || !TICKET_RE.test(ticket))
        ticket = `bkt_${randomBytes(32).toString('base64url')}`
      const expiresAt = at() + ttl
      tickets.set(ticket, { ...claims, expiresAt })
      return { ticket, expiresAt }
    },
    consume(ticket) {
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null
      const claims = tickets.get(ticket)
      if (!claims) return null
      tickets.delete(ticket)
      return claims.expiresAt > at() ? claims : null
    },
    revokeSessions(ids) {
      const gone = new Set(ids)
      for (const [ticket, claims] of tickets) if (gone.has(claims.sessionId)) tickets.delete(ticket)
    },
    sweep,
    get size() {
      return tickets.size
    },
  }
}
