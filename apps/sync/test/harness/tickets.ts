// Test-only secrets and ticket minting (the API signs tickets in production; tests play the API).
import { INTERNAL_SECRET_HEADER, signTicket, type TicketRole } from '@draftroom/auth-tickets'
import { ticketInProtocol, ticketProtocols } from '../../../web/src/board/ticket-protocol.ts'

export { ticketInProtocol }

/**
 * Where a test socket's ticket goes (L7-tail). `protocol` (the default): as the browsers send it, the
 * offered subprotocol `lobby.ticket.<ticket>` next to `lobby.board.v1` (the handshake's
 * `Sec-WebSocket-Protocol`; apps/web/src/board/ticket-protocol.ts). `url`: the old `?ticket=`, which the
 * server still reads for one more release; only the tests OF that transport ask for it, so the old path can
 * be retired by deleting them.
 */
export type TicketIn = 'protocol' | 'url'

/**
 * Node's global WebSocket behind the browsers' wrapper (apps/web/src/board/ticket-protocol.ts): the headless
 * client's `WebSocketImpl` for tests, so the ticket moves from the URL the client builds into the offered
 * subprotocol, as in a browser.
 */
export const TicketWebSocket: new (url: string) => never = ticketInProtocol(
  (globalThis as unknown as { WebSocket: new (url: string, protocols?: string | string[]) => never })
    .WebSocket,
)

/**
 * The URL and the offered subprotocols of a board socket for `ticket`. A ticket that is not an HTTP token
 * (some forgeries: it cannot travel as a subprotocol, and the browsers' wrapper keeps such a one in the URL
 * too) goes in the URL whatever `ticketIn` says.
 */
export function boardSocketTarget(
  connectUrl: string,
  ticket: string,
  ticketIn: TicketIn = 'protocol',
): { url: string; protocols: string[] | undefined } {
  const protocols = ticketIn === 'protocol' ? ticketProtocols(ticket) : null
  if (protocols) return { url: connectUrl, protocols }
  const sep = connectUrl.includes('?') ? '&' : '?'
  return { url: `${connectUrl}${sep}${new URLSearchParams({ ticket })}`, protocols: undefined }
}

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
