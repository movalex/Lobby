// OWNER: W2 (wave L, L2-3). The recap's window: what "This session" and "Catch me up" cover.
//  - 'session': since the start of the presenter's run of show (W5's agendaActuals: now less the time its
//    sections took), else since the first edit today (the server's stamps, `lobbyServer`, never a client clock),
//    else since midnight.
//  - 'catch-up': since the visit before this one. Wave N (N4-4): the SERVER's answer when there is one (the person's own
//    visit marker, across their devices: features/visits hands it in through noteServerVisit, so the "Since you were
//    here" highlights and this window are the same time); otherwise this device's last visit, kept in localStorage per
//    board (written when the board opens; the previous value is what Catch me up uses): a name-only guest, an api
//    without the visit route, a refused route, or a first visit (null) use it as before. Empty, blocked or throwing
//    storage means the last 24 hours.
//  - 'selection': the selected frames (or the selection itself), as a 'shapes' scope.
// Pure but for the storage and the clock it is handed.

import type { AiRecapScope } from '@draftroom/contracts'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { stampsOf } from '../ported/provenance.ts'

export const DAY_MS = 24 * 60 * 60 * 1000
/** localStorage key of a board's last visit on this device. */
export const lastVisitKey = (boardId: string) => `lobby-last-visit:${boardId}`

/** The part of Storage this uses (tests hand in their own, a throwing one included). */
export type VisitStorage = Pick<Storage, 'getItem' | 'setItem'>

const browserStorage = (): VisitStorage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The last visit stored for `boardId`, or null (none, unreadable, or storage blocked). */
export function readLastVisit(
  boardId: string,
  storage: VisitStorage | null = browserStorage(),
): number | null {
  try {
    const raw = storage?.getItem(lastVisitKey(boardId))
    const n = raw ? Number(raw) : Number.NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Stores `now` as the last visit of `boardId`; false when storage refused. */
export function writeLastVisit(
  boardId: string,
  now: number,
  storage: VisitStorage | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false
    storage.setItem(lastVisitKey(boardId), String(Math.round(now)))
    return true
  } catch {
    return false
  }
}

/** Per page: the visit before this one, read once when the board opened (null: none known). */
const visitBefore = new Map<string, number | null>()

/** Per page: the visit before this one as the SERVER stored it for this person (wave N, N4-4); absent: none known. */
const serverVisit = new Map<string, number>()

/**
 * The api's answer for this board (features/visits): the person's previous visit time, or null (a first visit, or no
 * answer: Catch me up then uses this device's last visit). A time that is not a positive finite number is no answer.
 */
export function noteServerVisit(boardId: string, previousSeenAt: number | null): void {
  if (typeof previousSeenAt === 'number' && Number.isFinite(previousSeenAt) && previousSeenAt > 0)
    serverVisit.set(boardId, Math.round(previousSeenAt))
  else serverVisit.delete(boardId)
}

/** The board opened: remember the previous visit for Catch me up, then store this one. */
export function noteVisit(
  boardId: string,
  now: number,
  storage: VisitStorage | null = browserStorage(),
): void {
  if (!visitBefore.has(boardId)) visitBefore.set(boardId, readLastVisit(boardId, storage))
  writeLastVisit(boardId, now, storage)
}

/**
 * Catch me up's window: since the visit before this one (`visit` true): the server's when it answered, else this device's;
 * else the last 24 hours.
 * The api clamps a window older than AI_RECAP_MAX_WINDOW_MS (the plan says so: ./plan.ts).
 */
export function catchUpWindow(
  boardId: string,
  now: number,
  storage: VisitStorage | null = browserStorage(),
): { since: number; visit: boolean } {
  const server = serverVisit.get(boardId)
  if (server !== undefined && server < now) return { since: server, visit: true }
  const before = visitBefore.has(boardId) ? visitBefore.get(boardId) : readLastVisit(boardId, storage)
  return before && before < now ? { since: before, visit: true } : { since: now - DAY_MS, visit: false }
}

/** Catch me up's `since` (./catchUpWindow). */
export function catchUpSince(
  boardId: string,
  now: number,
  storage: VisitStorage | null = browserStorage(),
): number {
  return catchUpWindow(boardId, now, storage).since
}

/** Forgets what this page remembered (tests). */
export const resetVisits = () => {
  visitBefore.clear()
  serverVisit.clear()
}

/** Local midnight before `now`. */
export function midnightOf(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The first server-stamped edit today among `els` (created or edited at or after midnight), else null. */
export function firstEditToday(els: readonly CanvasElement[], now: number): number | null {
  const from = midnightOf(now)
  let first: number | null = null
  for (const el of els) {
    const s = stampsOf(el)
    for (const t of [s.createdAt, s.lastEditedAt])
      if (t !== null && t >= from && t <= now && (first === null || t < first)) first = t
  }
  return first
}

/** "This session"'s `since`: the run of show's start, else the first edit today, else midnight. */
export function sessionSince(
  els: readonly CanvasElement[],
  now: number,
  actuals: readonly { readonly actualMs: number }[] | null,
): number {
  const ran = actuals?.reduce((n, a) => n + Math.max(0, a.actualMs), 0) ?? 0
  if (actuals?.length && ran > 0) return Math.max(midnightOf(now) - DAY_MS, now - ran)
  return firstEditToday(els, now) ?? midnightOf(now)
}

export type RecapScopeName = 'session' | 'selection' | 'catch-up'

/** The api's scope for a recap: 'since' a time, or the selected shapes (refs); null when there is nothing to name. */
export function apiScope(
  scope: RecapScopeName,
  since: number,
  selectionRefs: readonly string[],
): AiRecapScope | null {
  if (scope === 'selection')
    return selectionRefs.length ? { kind: 'shapes', shapeIds: selectionRefs.slice(0, 200) } : null
  return { kind: 'since', since: Math.max(0, Math.round(since)) }
}
