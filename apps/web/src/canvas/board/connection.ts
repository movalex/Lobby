/**
 * P-003 (wave P): the board's connection as the page shows it. The browser's own offline (navigator.onLine, its
 * `offline` and `online` events) is said at once when the socket is not live: the socket only notices a dead network
 * on its next missed heartbeat, up to 30 s later, and until then the board looked live while nothing could be sent.
 *
 * Wave P review: Windows and VPNs often report offline wrongly while the network works, and the board said "Offline"
 * while it synced. So while the socket is live (phase ready), the browser's signal starts a quick probe of the
 * socket (`useSocketProbe`: a ping, PROBE_MS for its pong). Meanwhile, and once the socket answered, the socket is
 * trusted; a socket that did not answer shows offline. The heartbeat still drops a dead socket, and then the board
 * says offline at once.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ConnState } from '../../board/TopBarFrame.tsx'
import type { LobbyBoardSnapshot } from './session.ts'

/** How long the socket's answer to the probe may take before the browser's offline signal is believed. */
export const PROBE_MS = 1_500

/** The probe of a live socket the browser says is offline: asked, answered, or no answer in time. */
export type SocketProbe = 'pending' | 'alive' | 'dead'

function connOf(phase: LobbyBoardSnapshot['phase']): ConnState {
  if (phase === 'ready') return 'online'
  if (phase === 'offline') return 'offline'
  if (phase === 'closed') return 'error'
  return 'connecting'
}

/** The connection to show: the socket's, unless the browser says offline and the socket is not shown to be live. */
export const connWith = (
  s: Pick<LobbyBoardSnapshot, 'phase'>,
  browserOnline: boolean,
  probe: SocketProbe | null = null,
): ConnState => {
  if (browserOnline || s.phase === 'closed') return connOf(s.phase)
  if (s.phase === 'ready' && (probe === 'pending' || probe === 'alive')) return connOf(s.phase)
  return 'offline'
}

/**
 * The probe for the browser's offline signal while the socket is live: null while there is nothing to ask (the
 * browser says online, or the socket is not live), else this episode's answer ('pending' until it comes). A new
 * episode (the signal again, or the socket live again) asks again.
 */
export function useSocketProbe(
  probe: (ms: number) => Promise<boolean>,
  browserOnline: boolean,
  phase: LobbyBoardSnapshot['phase'],
): SocketProbe | null {
  const asking = !browserOnline && phase === 'ready'
  // one object per stretch of asking: an answer belongs to the stretch it was asked in
  const stretch = useMemo(() => ({ asking }), [asking])
  const [answer, setAnswer] = useState<{ stretch: object; alive: boolean } | null>(null)
  useEffect(() => {
    if (!stretch.asking) return
    let live = true
    void probe(PROBE_MS).then((alive) => {
      if (live) setAnswer({ stretch, alive })
    })
    return () => {
      live = false
    }
  }, [stretch, probe])
  if (!asking) return null
  if (answer?.stretch !== stretch) return 'pending'
  return answer.alive ? 'alive' : 'dead'
}
