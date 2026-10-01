// The in-band close reason (CONTRACTS_REV 9, SMK-2). Through the Render edge an unauthenticated WebSocket
// got an EMPTY close frame: no 4099, no reason, so the web's reason screens ("Lobby is updating", a
// refused ticket) had nothing to show and the transport would have reconnected. Every terminal close of
// an upgraded socket on the Excalidraw engine is preceded by `notice` CLOSING with the reason as `detail`;
// the client treats the close that follows it as 4099 with that reason, whatever the close frame carries.
// Sent straight on the socket (not through the session's outbound queue): it must leave before the close
// frame, and `ws` sends frames in call order.

import { CLOSE_TERMINAL } from '@draftroom/canvas-schema/protocol'

/** What `closeTerminal` needs of a socket: `ws`'s WebSocket and `ElementSocket` both fit. */
export interface ClosableSocket {
  send(data: string): void
  close(code: number, reason: string): void
  readonly readyState: number
}

const OPEN = 1

export const closingNotice = (reason: string): string =>
  JSON.stringify({ type: 'notice', code: 'CLOSING', detail: reason })

/** The CLOSING notice, then the 4099 close. Never throws (a socket already closing is left to its handler). */
export function closeTerminal(socket: ClosableSocket, reason: string): void {
  try {
    if (socket.readyState === OPEN) socket.send(closingNotice(reason))
  } catch {
    // a socket that failed mid-send is closing; its close handler cleans up
  }
  try {
    socket.close(CLOSE_TERMINAL, reason)
  } catch {
    // already closed
  }
}
