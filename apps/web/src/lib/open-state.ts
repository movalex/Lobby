// OWNER: W5 (wave M, M5-1; S4, PWR-8, CAP-PG-OPEN). The board-open read, shared by the board's features:
// GET /api/boards/:bid/open-state (@draftroom/contracts board-open.ts) answers the panel reads a board page fires
// when it opens, together (they queued for 0.4-1.1 s on the 0.1-CPU Postgres, against about 5 ms alone).
//
// preloadOpenState(boardId) asks for it (lib/prefetch-board.ts preloadBoardOpen, with the board and its first
// ticket, as soon as the board route renders with a session). The answer is kept for OPEN_STATE_TTL_MS.
//
// takeOpenState(boardId, part) hands a feature its part ONCE, for its first fetch:
//   - undefined: nothing to take: no answer (yet), already taken, older than OPEN_STATE_TTL_MS, another board, an
//     api without the route (a 404: never asked again in this tab), or an answer that may have missed an event
//     (below). The feature fetches its own route, exactly as before wave M;
//   - null: the api says this caller may not read that part (the board's W5 takers then ask their own route, which
//     answers its own refusal: it costs a request only where the board page itself would not open);
//   - otherwise that part's body, the same as its own route would have answered.
//
// Events between the answer and the board's stream (M5-1): the answer says where the board's events stood when it
// was read (`eventsSeq`), and the stream's first hello says where they stood when it was subscribed
// (noteBoardHello, from features/events.ts). Positions only move forward (`<process>.<seq>`): a part taken after that
// hello is handed out only when the answer's position is the hello's or later, in the same api process. Then either
// nothing happened to the board in between, or the answer was read after the stream started (what it lacks came on
// the stream). Otherwise the feature reads its route: an event it never received cannot be in the part. A part taken
// before any hello (at mount) is what the feature's own first fetch would have read at that moment.
//
// The parts and their takers: 'exportPolicy' (features/sharing/ported/export-policy.ts), 'outside'
// (features/people/outside.ts), 'threads' (features/comments/api.ts) and 'sharing' (the share badge), W5's;
// 'workshop', 'presentation', 'privateBrainstorm' (W2), 'ai' (W4).

import {
  OPEN_STATE_TTL_MS,
  type OpenState,
  OpenStateBody,
  type OpenStatePart,
  openStatePath,
} from '@draftroom/contracts'
import { api, isApiError } from '../api/client.ts'

export type { OpenStatePart }

interface Entry {
  readonly boardId: string
  /** when it was asked for (the TTL counts from here) */
  readonly at: number
  answer: OpenStateBody | null
  readonly taken: Set<OpenStatePart>
  /** the board stream's first hello since it was asked for: its event position (null: it sent none) */
  hello: { eventsSeq: string | null } | null
}

let entry: Entry | null = null
/** The api answered 404: it has no such route (an older api). Not asked again in this tab. */
let noRoute = false

export interface OpenStateDeps {
  fetch(boardId: string): Promise<OpenStateBody>
  now(): number
}

const defaultDeps: OpenStateDeps = {
  fetch: (boardId) => api.request('GET', openStatePath(boardId), { schema: OpenStateBody }),
  now: () => Date.now(),
}

/**
 * Asks for the board's open state (idempotent while an answer for the same board is fresh or on its way). Never
 * rejects: a failure leaves nothing to take (every feature reads its own route).
 */
export function preloadOpenState(boardId: string, deps: OpenStateDeps = defaultDeps): void {
  if (noRoute) return
  const now = deps.now()
  if (entry && entry.boardId === boardId && now - entry.at < OPEN_STATE_TTL_MS) return
  const e: Entry = { boardId, at: now, answer: null, taken: new Set(), hello: null }
  entry = e
  let p: Promise<OpenStateBody>
  try {
    p = deps.fetch(boardId)
  } catch {
    return
  }
  p.then(
    (body) => {
      if (entry === e) e.answer = body
    },
    (err: unknown) => {
      // an api from before wave M: the separate reads, as before, for the rest of this tab's life
      if (isApiError(err) && err.status === 404) noRoute = true
    },
  )
}

export function takeOpenState<P extends OpenStatePart>(
  boardId: string,
  part: P,
  now: number = Date.now(),
): OpenState[P] | undefined {
  const e = entry
  if (!e || e.boardId !== boardId || !e.answer) return undefined
  if (now - e.at >= OPEN_STATE_TTL_MS || e.taken.has(part)) return undefined
  // the stream started after the answer was read and an event came in between: this answer may lack it
  if (e.hello && !atOrAfter(e.answer.eventsSeq, e.hello.eventsSeq)) return undefined
  e.taken.add(part)
  return e.answer[part] as OpenState[P]
}

/**
 * The board stream said hello (features/events.ts, before its resync listeners run): its event position
 * (`data.eventsSeq`). Only the first hello since the answer was asked for counts.
 */
export function noteBoardHello(boardId: string, eventsSeq: unknown): void {
  const e = entry
  if (!e || e.boardId !== boardId || e.hello) return
  e.hello = { eventsSeq: typeof eventsSeq === 'string' ? eventsSeq : null }
}

/** Whether position `a` is `b` or later, in the same api process (anything unreadable: no). */
function atOrAfter(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false
  const [pa, sa] = a.split('.')
  const [pb, sb] = b.split('.')
  if (!pa || pa !== pb || sa === undefined || sb === undefined) return false
  const na = Number(sa)
  const nb = Number(sb)
  return Number.isSafeInteger(na) && Number.isSafeInteger(nb) && na >= nb
}

/** Another person signed in in this tab (lib/prefetch-board.ts noteSessionUser): nothing of the last one's is kept. */
export function forgetOpenState(): void {
  entry = null
}

/** Tests only. */
export function resetOpenStateForTests(): void {
  entry = null
  noRoute = false
}
