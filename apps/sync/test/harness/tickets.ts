// Test-only secrets and ticket minting (the API signs tickets in production; tests play the API).
import { INTERNAL_SECRET_HEADER, signTicket, type TicketRole } from '@draftroom/auth-tickets'

export const TEST_TICKET_SECRET = 'test-only-ticket-secret-0123456789-abcdef'
export const TEST_INTERNAL_SECRET = 'test-only-internal-secret-0123456789-abcdef'

export interface MintOptions {
  name?: string
  /** Issue time (ms); default now. */
  now?: number
  ttlMs?: number
  secret?: string
  /** A3's name-only guest claim (Excalidraw engine; the tldraw engine ignores it) */
  guest?: boolean
}

export function mintTicket(
  boardId: string,
  userId: string,
  role: TicketRole = 'editor',
  o: MintOptions = {},
) {
  return signTicket(o.secret ?? TEST_TICKET_SECRET, {
    bid: boardId,
    uid: userId,
    name: o.name ?? userId,
    color: '#1971c2',
    role,
    now: o.now,
    ttlMs: o.ttlMs,
    ...(o.guest ? { guest: true } : {}),
  }).ticket
}

/** Rewrites claims inside a correctly signed ticket but keeps the old signature (a forgery). */
export function tamperTicket(ticket: string, patch: Record<string, unknown>): string {
  const [v, payload, sig] = ticket.split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))
  return `${v}.${Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url')}.${sig}`
}

/** fetch() against a sync server's internal endpoints; `secret: null` sends no header. */
export function callInternal(
  baseUrl: string,
  method: string,
  path: string,
  opts: { body?: unknown; secret?: string | null; rawBody?: string; contentType?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  const secret = opts.secret === undefined ? TEST_INTERNAL_SECRET : opts.secret
  if (secret !== null) headers[INTERNAL_SECRET_HEADER] = secret
  let body: string | undefined
  if (opts.rawBody !== undefined || opts.body !== undefined) {
    headers['content-type'] = opts.contentType ?? 'application/json'
    body = opts.rawBody ?? JSON.stringify(opts.body)
  }
  return fetch(`${baseUrl}${path}`, { method, headers, body })
}

/** The error code of a JSON error response ({ error: { code, message } }). */
export async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code
}
