// Per-run secrets and test tickets for the load generator (docs/EXCALIDRAW-MIGRATION.md §8.6.6
// "Secrets"): a ticket secret and an internal secret generated fresh for every run (on the NAS, inside
// the run folder's run.env; locally, in memory), never a value from .env.deploy.local. Tickets are signed
// exactly as the api signs them (@draftroom/auth-tickets), so sync verifies them on its real path.
import { randomBytes } from 'node:crypto'
import { signTicket, type TicketRole } from '../../packages/auth-tickets/src/index.ts'

export interface RunSecrets {
  readonly ticketSecret: string
  readonly internalSecret: string
}

/** Two fresh, different 32-byte secrets (base64url, 43 chars: over the 32-character minimum). */
export function newRunSecrets(): RunSecrets {
  const ticketSecret = randomBytes(32).toString('base64url')
  let internalSecret = randomBytes(32).toString('base64url')
  while (internalSecret === ticketSecret) internalSecret = randomBytes(32).toString('base64url')
  return { ticketSecret, internalSecret }
}

/** The run.env lines sync and the load generator read (values are secrets: never print this). */
export function runEnvText(s: RunSecrets, apiUrl: string): string {
  return [
    `DRAFTROOM_TICKET_SECRET=${s.ticketSecret}`,
    `DRAFTROOM_INTERNAL_SECRET=${s.internalSecret}`,
    `DRAFTROOM_API_INTERNAL_URL=${apiUrl}`,
    '',
  ].join('\n')
}

/** Reads the secrets back from the environment (the containers get run.env through --env-file). */
export function secretsFromEnv(env: Record<string, string | undefined> = process.env): RunSecrets {
  const ticketSecret = env.DRAFTROOM_TICKET_SECRET ?? ''
  const internalSecret = env.DRAFTROOM_INTERNAL_SECRET ?? ''
  if (ticketSecret.length < 32 || internalSecret.length < 32)
    throw new Error('DRAFTROOM_TICKET_SECRET and DRAFTROOM_INTERNAL_SECRET (32+ characters) are required')
  if (ticketSecret === internalSecret) throw new Error('the ticket and internal secrets must differ')
  return { ticketSecret, internalSecret }
}

export interface LoadUser {
  /** the ticket uid (≤ 60 characters) */
  readonly uid: string
  readonly name: string
  readonly color: string
  readonly role: TicketRole
  readonly guest?: boolean
}

/**
 * A signed ticket for `user` on `boardId`, valid `ttlMs` (default 30 min: sync checks `exp` at every
 * connect, and the reconnects after minute 8's SIGKILL reuse the ticket the session started with).
 */
export function mintTicket(secret: string, boardId: string, user: LoadUser, ttlMs = 30 * 60_000): string {
  return signTicket(secret, {
    bid: boardId,
    uid: user.uid,
    name: user.name,
    color: user.color,
    role: user.role,
    guest: user.guest,
    ttlMs,
  }).ticket
}

const PALETTE = ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#e8590c', '#5c940d']

/** Deterministic load users: `ld_<board>_<n>` uids, editor or viewer. */
export function loadUser(boardIndex: number, n: number, role: TicketRole): LoadUser {
  return {
    uid: `usr_ld${boardIndex.toString(36)}x${n.toString(36)}`,
    name: `Load ${boardIndex}.${n}`,
    color: PALETTE[n % PALETTE.length] as string,
    role,
  }
}
