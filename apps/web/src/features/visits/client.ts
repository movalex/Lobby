// OWNER: WS4 (wave N, since your last visit; a stub landed by the wave N foundation). The web side of the private
// visit markers: POST /api/boards/:bid/visit (@draftroom/contracts visits.ts VisitAnswer) and the "seen" beacon.
//
// Frozen signatures:
//   fetchVisit(boardId): Promise<VisitAnswer | null>   this person's previous visit time and the one just stored;
//                                                       null when there is none to show: a name-only guest, an api
//                                                       without the route (404), a refusal or a network error
//   sendSeen(boardId): boolean                          the pagehide / "Mark all seen" beacon; whether it was queued
//
// The stub: fetchVisit answers null without a request and sendSeen queues nothing, so the chip stays hidden and Catch
// me up keeps its device-local window (features/ai/recap/window.ts), until WS4 implements them.
import type { VisitAnswer } from '@draftroom/contracts'

export async function fetchVisit(_boardId: string): Promise<VisitAnswer | null> {
  return null
}

export function sendSeen(_boardId: string): boolean {
  return false
}
