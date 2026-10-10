// OWNER: W5 (wave M, M5-1; S4, PWR-8, CAP-PG-OPEN). The board-open read, shared by the board's features:
// GET /api/boards/:bid/open-state (@draftroom/contracts board-open.ts) answers the panel reads a board page fires
// when it opens, together (they queued for 0.4-1.1 s on the 0.1-CPU Postgres, against about 5 ms alone).
//
// preloadOpenState(boardId) asks for it (lib/prefetch-board.ts preloadBoardOpen, with the board and its first
// ticket, as soon as the board route renders with a session). The answer is kept for OPEN_STATE_TTL_MS.
//
// Each part is for its feature's FIRST fetch only. The first call for a part consumes it, hit or miss: a part asked
// for before the answer is there (takeOpenState) or after the wait for it ended (awaitOpenState) is never handed to
// a later call. A later call is an event-driven reload (a policy event, a privacy refresh, a reconnect's resync) and
// must read the route: an older snapshot would undo events the feature has already applied.
//   - takeOpenState(boardId, part): synchronous: the part when the answer is already there, else undefined;
//   - awaitOpenState(boardId, part): for a feature whose first fetch is a request anyway: the part as soon as the
//     answer on its way lands (at most OPEN_STATE_WAIT_MS), so a slow board-open read is waited for instead of being
//     doubled by the separate read it replaces.
// What they give:
//   - undefined: nothing to take: no answer (yet, or within the wait), the part was asked for before, older than
//     OPEN_STATE_TTL_MS, another board, an api without the route (a 404: never asked again in this tab), a failed
//     read, or an answer that may have missed an event (below). The feature fetches its own route, as before wave M;
//   - null: the api says this caller may not read that part (the board's W5 takers then ask their own route, which
//     answers its own refusal: it costs a request only where the board page itself would not open);
//   - otherwise that part's body, the same as its own route would have answered.
//
// Events (M5-1): the answer says where the board's events stood when it was read (`eventsSeq`, `<process>.<seq>`).
// features/events.ts reports every position the board's stream shows: each hello's (`noteBoardHello`: where the
// events stood when that connection was subscribed, a reconnect included) and each delivered event's (`noteBoardEvent`:
// its `seq` is the board's position after it). Positions only move forward. A part is handed out only when the
// answer's position is at or after every position the stream has shown since the answer was asked for, in the same
// api process: then the answer already holds everything the page has heard of, and what it lacks comes on the stream.
// A hello from another process, or one without a position, rules the answer out. A part taken before any hello (at
// mount) is what the feature's own first fetch would have read then, and the first hello's resync repairs both alike.
//
// One board page: the entry is dropped when its event stream closes (the board page unmounts) once anything used
// it, and a later preload of the same board (re-entry within the TTL) asks again unless the entry is untouched.
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

/** How long awaitOpenState waits for an answer on its way before the feature reads its own route. */
export const OPEN_STATE_WAIT_MS = 5_000
/** After a server error (5xx) the board-open read is not asked for again for this long (the separate reads). */
export const OPEN_STATE_PAUSE_MS = 60_000

interface Position {
  readonly process: string
  seq: number
}

interface Entry {
  readonly boardId: string
  /** when it was asked for (the TTL counts from here) */
  readonly at: number
  readonly now: () => number
  answer: OpenStateBody | null
  /** the request settled (answered or failed) */
  settled: boolean
  /** parts a feature has asked for, hit or miss: each is for its feature's first fetch only */
  readonly asked: Set<OpenStatePart>
  /** the furthest position the board's stream has shown since this was asked for (null: none yet) */
  seen: Position | null
  /** the stream showed a position that cannot be placed (another api process, none, unreadable) */
  blind: boolean
  /** awaitOpenState calls waiting for the request to settle */
  readonly waiters: Set<() => void>
}

let entry: Entry | null = null
/** The api answered 404: it has no such route (an older api). Not asked again in this tab. */
let noRoute = false
/** A server error: not asked again before this time (ms, the deps' clock). */
let pausedUntil = Number.NEGATIVE_INFINITY

export interface OpenStateDeps {
  fetch(boardId: string): Promise<OpenStateBody>
  now(): number
}

const defaultDeps: OpenStateDeps = {
  fetch: (boardId) => api.request('GET', openStatePath(boardId), { schema: OpenStateBody }),
  now: () => Date.now(),
}

/** Nothing used it yet: a second render's preload (or a stream closed before it said anything) leaves it be. */
const untouched = (e: Entry) => e.asked.size === 0 && e.seen === null && !e.blind

/** Forgets `e` (when it is the current entry) and wakes its waiters, which then get nothing. */
function drop(e: Entry): void {
  if (entry === e) entry = null
  settle(e)
}

function settle(e: Entry): void {
  e.settled = true
  for (const w of [...e.waiters]) w()
}

/**
 * Asks for the board's open state (idempotent while an untouched answer for the same board is fresh or on its way).
 * Never rejects: a failure leaves nothing to take (every feature reads its own route).
 */
export function preloadOpenState(boardId: string, deps: OpenStateDeps = defaultDeps): void {
  if (noRoute) return
  const now = deps.now()
  if (now < pausedUntil) return
  const prev = entry
  if (prev && prev.boardId === boardId && now - prev.at < OPEN_STATE_TTL_MS && untouched(prev)) return
  const e: Entry = {
    boardId,
    at: now,
    now: deps.now,
    answer: null,
    settled: false,
    asked: new Set(),
    seen: null,
    blind: false,
    waiters: new Set(),
  }
  entry = e
  if (prev) drop(prev)
  let p: Promise<OpenStateBody>
  try {
    p = deps.fetch(boardId)
  } catch {
    settle(e)
    return
  }
  p.then(
    (body) => {
      if (entry === e) e.answer = body
      settle(e)
    },
    (err: unknown) => {
      if (isApiError(err)) {
        // an api from before wave M: the separate reads, as before, for the rest of this tab's life
        if (err.status === 404) noRoute = true
        // a server error: the separate reads for a minute (a broken part fails the whole answer)
        else if (err.status >= 500) pausedUntil = deps.now() + OPEN_STATE_PAUSE_MS
      }
      settle(e)
    },
  )
}

/** The part of `e`'s answer, if it still holds now (nothing about whether it was asked for). */
function handOut<P extends OpenStatePart>(e: Entry, part: P, now: number): OpenState[P] | undefined {
  if (entry !== e || !e.answer || e.blind) return undefined
  if (now - e.at >= OPEN_STATE_TTL_MS) return undefined
  // the stream has shown a position the answer is not at or after: it may lack an event the page heard of
  if (e.seen && !atOrAfter(e.answer.eventsSeq, e.seen)) return undefined
  return e.answer[part] as OpenState[P]
}

/** The entry for `boardId` when this is the first call for `part` (which it consumes), else null. */
function firstCall(boardId: string, part: OpenStatePart): Entry | null {
  const e = entry
  if (!e || e.boardId !== boardId || e.asked.has(part)) return null
  e.asked.add(part)
  return e
}

/**
 * A feature's first fetch, synchronously: its part if the answer is already there (see the header). The call
 * consumes the part whatever it returns.
 */
export function takeOpenState<P extends OpenStatePart>(
  boardId: string,
  part: P,
  now: number = Date.now(),
): OpenState[P] | undefined {
  const e = firstCall(boardId, part)
  return e ? handOut(e, part, now) : undefined
}

/**
 * A feature's first fetch, for a feature that would send a request anyway: its part as soon as the answer on its
 * way lands, at most OPEN_STATE_WAIT_MS from now (or at once when there is nothing to wait for). Never rejects; an
 * abort of `signal` ends the wait with undefined. The call consumes the part whatever it resolves.
 */
export function awaitOpenState<P extends OpenStatePart>(
  boardId: string,
  part: P,
  signal?: AbortSignal,
): Promise<OpenState[P] | undefined> {
  const e = firstCall(boardId, part)
  if (!e) return Promise.resolve(undefined)
  return waitFor(e, part, signal)
}

/**
 * The takers' fetch in one call: the part (as awaitOpenState gives it), else `route()`. With nothing to wait for or
 * take (no answer asked for, another board, the part asked for before) `route()` is called synchronously, exactly
 * as the feature called it before wave M. A refused (null) part asks the route too, which answers its own refusal.
 */
export function openStateOrRoute<P extends OpenStatePart>(
  boardId: string,
  part: P,
  route: () => Promise<NonNullable<OpenState[P]>>,
  signal?: AbortSignal,
): Promise<NonNullable<OpenState[P]>> {
  const e = firstCall(boardId, part)
  if (!e) return route()
  if (e.settled) {
    const v = handOut(e, part, e.now())
    return v ? Promise.resolve(v) : route()
  }
  return waitFor(e, part, signal).then((v) => v ?? route())
}

function waitFor<P extends OpenStatePart>(
  e: Entry,
  part: P,
  signal?: AbortSignal,
): Promise<OpenState[P] | undefined> {
  if (e.settled) return Promise.resolve(handOut(e, part, e.now()))
  if (signal?.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (value: OpenState[P] | undefined) => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      e.waiters.delete(landed)
      signal?.removeEventListener('abort', aborted)
      resolve(value)
    }
    const landed = () => finish(handOut(e, part, e.now()))
    const aborted = () => finish(undefined)
    e.waiters.add(landed)
    signal?.addEventListener('abort', aborted, { once: true })
    // the wait is over: the route now; an answer landing later goes to nobody (the part was asked for)
    timer = setTimeout(() => finish(undefined), OPEN_STATE_WAIT_MS)
  })
}

/** Moves `e`'s furthest seen position to `p` (null: one that cannot be placed). */
function noteSeen(e: Entry, p: Position | null): void {
  if (!p) e.blind = true
  else if (!e.seen) e.seen = { ...p }
  else if (e.seen.process !== p.process) e.blind = true
  else e.seen.seq = Math.max(e.seen.seq, p.seq)
}

/**
 * The board stream said hello (features/events.ts, every hello, before its resync listeners run): where the board's
 * events stood when that connection was subscribed (`data.eventsSeq`).
 */
export function noteBoardHello(boardId: string, eventsSeq: unknown): void {
  const e = entry
  if (!e || e.boardId !== boardId) return
  noteSeen(e, parsePosition(eventsSeq))
}

/**
 * The board stream delivered an event (features/events.ts, before its listeners run): its `seq` is the board's
 * position after it, in the process of the stream's hello. A message without one (hello, ping) is ignored.
 */
export function noteBoardEvent(boardId: string, seq: unknown): void {
  const e = entry
  if (!e || e.boardId !== boardId) return
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return
  // an event before any hello since this was asked for cannot be placed
  if (!e.seen) e.blind = true
  else e.seen.seq = Math.max(e.seen.seq, seq)
}

/**
 * The board's event stream closed (features/events.ts close(): the board page unmounted): an entry anything used is
 * forgotten (a stream closed before it said anything, as React's development double effect does, leaves it).
 */
export function noteBoardStreamClosed(boardId: string): void {
  const e = entry
  if (!e || e.boardId !== boardId || untouched(e)) return
  drop(e)
}

function parsePosition(s: unknown): Position | null {
  if (typeof s !== 'string') return null
  const [process, seq, rest] = s.split('.')
  if (!process || seq === undefined || rest !== undefined || !/^\d+$/.test(seq)) return null
  const n = Number(seq)
  return Number.isSafeInteger(n) ? { process, seq: n } : null
}

/** Whether position `a` is `b` or later, in the same api process (anything unreadable: no). */
function atOrAfter(a: string | undefined, b: Position): boolean {
  const pa = parsePosition(a)
  return pa !== null && pa.process === b.process && pa.seq >= b.seq
}

/** Another person signed in in this tab (lib/prefetch-board.ts noteSessionUser): nothing of the last one's is kept. */
export function forgetOpenState(): void {
  if (entry) drop(entry)
  entry = null
}

/** Tests only. */
export function resetOpenStateForTests(): void {
  forgetOpenState()
  noRoute = false
  pausedUntil = Number.NEGATIVE_INFINITY
}
