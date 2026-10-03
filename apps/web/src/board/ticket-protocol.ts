// The board socket's ticket off the URL (security audit L7). NODE-SAFE (no DOM types, no import.meta):
// the board session uses it in the browser (canvas/board/session.ts, through ./ticket.ts), and the sync
// server's tests run it against the real server (apps/sync/test/http/ticket-transport.test.ts).
//
// The ticket is a 60 s secret bound to one board. In the socket URL (`?ticket=`) it reached every log
// that keeps request URLs (Render's, Cloudflare's). It now travels in the WebSocket handshake's
// `Sec-WebSocket-Protocol` header instead, as a second offered subprotocol `lobby.ticket.<ticket>` next to
// `lobby.board.v1`. The sync server (apps/sync/src/app.ts, which defines the same two names) answers with
// exactly `lobby.board.v1` (a browser fails a handshake whose answer names a protocol it did not offer, and
// the ticket never comes back in a response header). It still accepts `?ticket=` for at least one release:
// tabs opened before the deploy and cached bundles keep connecting.

/** The subprotocol a board socket speaks: the one the sync server answers with. */
export const BOARD_SOCKET_PROTOCOL = 'lobby.board.v1'
/** The offered subprotocol that carries the ticket: this prefix, then the ticket. */
export const TICKET_PROTOCOL_PREFIX = 'lobby.ticket.'
/** An HTTP token (RFC 9110 §5.6.2): what a subprotocol may be (browsers refuse anything else). */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** The subprotocols that carry `ticket`, or null when it cannot travel as one (not an HTTP token). */
export function ticketProtocols(ticket: string): [string, string] | null {
  const p = `${TICKET_PROTOCOL_PREFIX}${ticket}`
  return ticket && HTTP_TOKEN.test(p) ? [BOARD_SOCKET_PROTOCOL, p] : null
}

type SocketCtor<W> = new (url: string, protocols?: string | string[]) => W

/**
 * A WebSocket constructor for the board socket: it takes the URL as the transport builds it (the ticket in
 * `?ticket=`, canvas/sync/transport/socket.ts), moves the ticket out of the URL into the offered
 * subprotocols, and opens the socket with what is left. A ticket that is not an HTTP token (never one the
 * api signs: `v1.<base64url>.<base64url>`) stays in the URL, which the server still reads.
 */
export function ticketInProtocol<W>(Impl: SocketCtor<W>): new (url: string) => W {
  return function TicketSocket(url: string): W {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return new Impl(url)
    }
    const ticket = u.searchParams.get('ticket')
    const protocols = ticket === null ? null : ticketProtocols(ticket)
    if (!protocols) return new Impl(url)
    u.searchParams.delete('ticket')
    return new Impl(u.toString(), protocols)
  } as unknown as new (
    url: string,
  ) => W
}
