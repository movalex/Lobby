// OWNER: WS4 (wave N, N4-1). The web side of the private visit markers: POST /api/boards/:bid/visit (@draftroom/contracts
// visits.ts VisitAnswer) and the "seen" beacon.
//
//   fetchVisit(boardId): Promise<VisitAnswer | null>   this person's previous visit time and the one just stored;
//                                                       null when there is none to show: a name-only guest (403), an api
//                                                       without the route (404), a refusal, a body this build cannot read,
//                                                       a network error (all of them silent: the chip stays hidden and
//                                                       Catch me up keeps its device-local window)
//   sendSeen(boardId): boolean                          the pagehide / "Mark all seen" beacon; whether it was queued
//
// Same origin, the session cookie, no body. Nothing is stored here: the times live on the server (only this person's own
// row, ever) and in this page's memory. Nothing is logged.
import {
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  VisitAnswer,
  visitPath,
  visitSeenPath,
} from '@draftroom/contracts'

export async function fetchVisit(boardId: string): Promise<VisitAnswer | null> {
  try {
    if (typeof fetch !== 'function') return null
    const res = await fetch(visitPath(boardId), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV) },
    })
    if (!res.ok) return null
    const parsed = VisitAnswer.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Queues the "seen" write so it outlives the page: navigator.sendBeacon with no body, else a keepalive fetch. True when
 * a request was queued (not that it succeeded: nobody waits for it).
 */
export function sendSeen(boardId: string): boolean {
  const url = visitSeenPath(boardId)
  try {
    const nav = (globalThis as { navigator?: Navigator }).navigator
    if (nav && typeof nav.sendBeacon === 'function' && nav.sendBeacon(url)) return true
  } catch {
    // a browser that refuses the beacon: the keepalive fetch below
  }
  try {
    if (typeof fetch !== 'function') return false
    void fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true }).catch(
      () => {},
    )
    return true
  } catch {
    return false
  }
}
