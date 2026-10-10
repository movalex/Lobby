// Live-session access re-validation (docs/M1-CONTRACTS.md §7). Tickets only gate admission; this
// module notices revocations and role changes while sockets stay open.
//
// RT-01 (realtime audit, wave J3): ended sign-ins too. Before, "Sign out everywhere", a ban or a deleted
// account (the api ends every session of the person) and an expired session left the person's open board
// sockets served: the grants were still there, so the re-check kept answering a role. Now:
//  - the api's answer carries `signedInSince`: when the person's oldest live session started (the api's
//    clock), or null when they have none. A socket of someone with no live session closes 4099
//    NOT_AUTHENTICATED (terminal; the web shows the sign-in page and keeps the unsent edits for the same
//    person's next sign-in). A socket whose ticket was issued before every live session of theirs began
//    came from a session that has ended since (e.g. "Sign out everywhere", then a new sign-in before this
//    server heard of it): it closes 4000 RECONNECT, so the client fetches a new ticket, which needs a live
//    session: a browser that signed in again carries on, one whose session ended gets a 401 and shows
//    the sign-in page. The new session's sockets stay. An api from before J3 sends no `signedInSince`:
//    only the role rules apply.
//  - the api tells this process as soon as it ends sessions: POST /internal/access-changed `{ userId }`
//    (no boardId) re-checks that person on every open board (`userChanged`), like a per-board change.
//    The periodic round is the backstop (an expiry has no event; a lost push).
// What stays: a ticket does not name the session it came from, so when the person still has an OLDER
// live session (another device), a socket of the session that ended is indistinguishable from that one's
// and stays open until it reconnects (its new ticket needs a live session). The precise fix is a session
// claim in the ticket (packages/auth-tickets), outside this workstream.
//
// Wave M (M7-1, CAP-SYNC-RECHECK): the periodic round is ONE request, POST <api>/internal/access-many with every
// open (board, user) pair (chunks of ACCESS_MANY_MAX_PAIRS, one after another), instead of one GET per pair fired
// all at once every interval (2 queries per pair on the database). Each answer is applied exactly as the per-pair
// one (`apply`), against the sessions admitted before the request was sent. Unchanged:
//  - forced checks (`accessChanged`, `userChanged`, an admission with a ticket older than a change) stay per pair
//    and immediate; one asked while a round's batch is in flight for that pair runs again right after it, as it
//    does behind a per-pair check (`again`), so its answer is never older than the change;
//  - fail open: a batch the api cannot answer (timeout, 5xx, a malformed answer) keeps every session of the round,
//    and is logged once, without ids;
//  - a pair whose ids the contract would refuse (not `usr_…` ids: tests, dev) goes per pair, as before.
// Downgrade: an api without the route (before wave M) does not answer it with 404 but with 403 FORBIDDEN "Cross-
// origin request refused.": its web-Origin (CSRF) hook runs before its not-found answer, and this server-to-server
// POST carries no Origin. Either status means "no batch route"; that round's pairs are checked per pair, and
// later rounds use the per-pair route until BATCH_REPROBE_MS has passed (then the batch is tried again). The
// interval is jittered by ±ACCESS_JITTER so the round never lands at the same instant as everything else.
// The monitor reports whether its last round reached the api (`lastRound`, the deep health check's `api`).
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import {
  ACCESS_MANY_MAX_PAIRS,
  ACCESS_MANY_PATH,
  AccessManyPair,
  AccessManyResponse,
} from '@draftroom/contracts'
import type { SessionDirectory } from './engine-switch.ts'
import { BOARD_ROLES, type BoardRole } from './permissions.ts'

/** The periodic round's interval is jittered by this fraction either way (±20 %). */
export const ACCESS_JITTER = 0.2
/** After a 404 from the batch route (an older api), the per-pair route is used this long before trying again. */
export const BATCH_REPROBE_MS = 60 * 60_000
/** A batch may take a little longer than one pair (default timeout of the batch request). */
export const BATCH_TIMEOUT_MS = 5_000

/** The delay before the next periodic round: `intervalMs` jittered by ±`jitter` (`random` in [0, 1)). */
export function jitteredDelay(
  intervalMs: number,
  random: () => number = Math.random,
  jitter = ACCESS_JITTER,
): number {
  const r = Math.min(Math.max(random(), 0), 1)
  return Math.max(1, Math.round(intervalMs * (1 - jitter + 2 * jitter * r)))
}

/** The api's answer for one person on one board (GET <api>/internal/access). */
export interface AccessAnswer {
  /** The person's current role on the board, or null for no access. */
  role: BoardRole | null
  /**
   * RT-01: when the person's oldest live session started (epoch ms, the api's clock), or null when they
   * have none (signed out everywhere, every session expired, banned, deleted). Undefined: an api from
   * before J3 (no session rule).
   */
  signedInSince?: number | null
}

export interface AccessClient {
  /** The user's current role on the board, or null for no access. Throws when the API cannot answer. */
  getRole(boardId: string, userId: string): Promise<BoardRole | null>
  /**
   * The whole answer (RT-01: the role and `signedInSince`). Throws when the API cannot answer. Optional:
   * a client without it (tests) is read through `getRole` (no session rule).
   */
  getAccess?(boardId: string, userId: string): Promise<AccessAnswer>
  /**
   * M7-1: the answers for many pairs in one request (at most ACCESS_MANY_MAX_PAIRS), in the pairs' order, each
   * as `getAccess` would answer it. Throws AccessBatchUnsupportedError when the api has no such route (a 404:
   * an api from before wave M), AccessUnavailableError when it cannot answer. Optional: a client without it is
   * asked per pair, as before.
   */
  getAccessMany?(pairs: readonly AccessPair[]): Promise<AccessAnswer[]>
}

/** One (board, user) pair the periodic round asks about. */
export interface AccessPair {
  boardId: string
  userId: string
}

export class AccessUnavailableError extends Error {}
/**
 * The api has no batch route: it answered 404, or the 403 its web-Origin check gives an Origin-less POST to a
 * route it does not know (every api before wave M). The per-pair route still works.
 */
export class AccessBatchUnsupportedError extends Error {}

export interface ApiAccessClientOptions {
  /** DRAFTROOM_API_INTERNAL_URL (no trailing slash). */
  baseUrl: string
  internalSecret: string
  /** Short on purpose: a slow API must not delay the next round. Default 3000. */
  timeoutMs?: number
  /** The batched round's request (M7-1). Default BATCH_TIMEOUT_MS. */
  batchTimeoutMs?: number
  fetch?: typeof fetch
}

/**
 * GET <api>/internal/access?boardId=&userId= with the internal secret ->
 * { role: BoardRole | null, signedInSince?: number | null }.
 */
export function createApiAccessClient(opts: ApiAccessClientOptions): AccessClient {
  const doFetch = opts.fetch ?? fetch
  async function getAccess(boardId: string, userId: string): Promise<AccessAnswer> {
    const url = `${opts.baseUrl}/internal/access?${new URLSearchParams({ boardId, userId })}`
    let res: Response
    try {
      res = await doFetch(url, {
        headers: { [INTERNAL_SECRET_HEADER]: opts.internalSecret, accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
        redirect: 'error', // never forward the secret anywhere else
      })
    } catch (e) {
      const name = (e as Error)?.name
      throw new AccessUnavailableError(name === 'TimeoutError' ? 'timed out' : 'unreachable')
    }
    // Only an explicit answer counts. Any other status (a 404 from a wrong URL, a 5xx, a rejected
    // secret) is "cannot tell", which keeps sessions open rather than kicking everyone.
    if (res.status !== 200) {
      await res.body?.cancel()
      throw new AccessUnavailableError(`HTTP ${res.status}`)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new AccessUnavailableError('invalid JSON')
    }
    const o = (body && typeof body === 'object' ? body : {}) as { role?: unknown; signedInSince?: unknown }
    let role: BoardRole | null
    if (o.role === null) role = null
    else if (typeof o.role === 'string' && (BOARD_ROLES as readonly string[]).includes(o.role))
      role = o.role as BoardRole
    else throw new AccessUnavailableError('unexpected response shape')
    if (!('signedInSince' in o) || o.signedInSince === undefined) return { role }
    const since = o.signedInSince
    // A value that is neither null nor a time is "cannot tell" too: never a reason to close.
    if (since !== null && (typeof since !== 'number' || !Number.isFinite(since) || since < 0))
      throw new AccessUnavailableError('unexpected response shape')
    return { role, signedInSince: since }
  }
  /**
   * M7-1: POST <api>/internal/access-many {pairs} -> AccessManyResponse. Only a 200 whose results name exactly
   * the asked pairs, in order, counts; a 404 is an api that predates the route; anything else is "cannot tell".
   */
  async function getAccessMany(pairs: readonly AccessPair[]): Promise<AccessAnswer[]> {
    let res: Response
    try {
      res = await doFetch(`${opts.baseUrl}${ACCESS_MANY_PATH}`, {
        method: 'POST',
        headers: {
          [INTERNAL_SECRET_HEADER]: opts.internalSecret,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pairs: pairs.map((p) => ({ boardId: p.boardId, userId: p.userId })) }),
        signal: AbortSignal.timeout(opts.batchTimeoutMs ?? BATCH_TIMEOUT_MS),
        redirect: 'error', // never forward the secret anywhere else
      })
    } catch (e) {
      const name = (e as Error)?.name
      throw new AccessUnavailableError(name === 'TimeoutError' ? 'timed out' : 'unreachable')
    }
    // an api from before wave M: 404, or (the real one) 403 from its web-Origin check, which runs before its 404
    if (res.status === 404 || res.status === 403) {
      await res.body?.cancel()
      throw new AccessBatchUnsupportedError(`HTTP ${res.status}`)
    }
    if (res.status !== 200) {
      await res.body?.cancel()
      throw new AccessUnavailableError(`HTTP ${res.status}`)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new AccessUnavailableError('invalid JSON')
    }
    const parsed = AccessManyResponse.safeParse(body)
    if (!parsed.success || parsed.data.results.length !== pairs.length)
      throw new AccessUnavailableError('unexpected response shape')
    const { results, signedInSince } = parsed.data
    return pairs.map((p, i) => {
      const r = results[i]
      if (!r || r.boardId !== p.boardId || r.userId !== p.userId)
        throw new AccessUnavailableError('unexpected response shape')
      return Object.hasOwn(signedInSince, p.userId)
        ? { role: r.role, signedInSince: signedInSince[p.userId] ?? null }
        : { role: r.role }
    })
  }
  return {
    getAccess,
    getAccessMany,
    async getRole(boardId, userId) {
      return (await getAccess(boardId, userId)).role
    },
  }
}

export interface AccessMonitorOptions {
  /** The ElementRoom service (a SessionDirectory). */
  registry: SessionDirectory
  client: AccessClient
  /** ACCESS_RECHECK_MS: the mean time between periodic rounds (each is jittered, `jitteredDelay`). */
  intervalMs: number
  log: (...a: unknown[]) => void
  /** Tests: the jitter's random source (default Math.random). */
  random?: () => number
  /** Tests: the clock the 404 re-probe and `lastRound` use (default Date.now). */
  now?: () => number
}

/** The last periodic round (M7-6's `api` reason): when it ran and whether every request of it was answered. */
export interface AccessRound {
  /** when it started (ms) */
  at: number
  /** pairs it checked (a round with none sent nothing) */
  pairs: number
  /** api requests of the round that could not be answered (a batch counts once) */
  failed: number
  /** whether it used the batch route (false: per pair, an older api or ids the batch does not take) */
  batched: boolean
}

export interface AccessMonitor {
  start(): void
  stop(): void
  /** The last periodic round that finished, or null before the first one. */
  lastRound(): AccessRound | null
  /** Call right after a session is admitted (handleSocketConnect) with the ticket's issue time. */
  admitted(boardId: string, sessionId: string, userId: string, ticketIssuedAt: number): void
  /** Call when a session has left its room. */
  removed(boardId: string, sessionId: string): void
  /** Re-checks now: every user with live sessions on the board, or just `userId`. */
  accessChanged(boardId: string, userId?: string): Promise<void>
  /**
   * RT-01: the api ended sessions of `userId` (sign out, sign out everywhere, a ban): re-checks that
   * person now on every open board where they have a session.
   */
  userChanged(userId: string): Promise<void>
  /** One periodic round (exposed for tests). */
  checkAll(): Promise<void>
}

// Ticket lifetime (60 s) + verifier clock skew (5 s): a ticket issued before an access change can
// still be presented this long after it.
const CHANGE_MEMORY_MS = 65_000
const CLOCK_SKEW_MS = 5_000
/**
 * RT-01: a ticket issued less than this before the person's oldest live session started is given the
 * benefit of the doubt (both times are the api's, but a deploy overlap can run two api processes).
 */
export const SESSION_START_MARGIN_MS = 1_000

/**
 * The session rule (RT-01), from the api's `signedInSince` and the socket's ticket time: 'signed-out'
 * (no live session at all: closed 4099 NOT_AUTHENTICATED), 'stale' (the ticket is older than every live
 * session: closed 4000 RECONNECT, its new ticket needs a live session) or null (nothing to do).
 */
export function signInEnded(
  signedInSince: number | null | undefined,
  ticketIssuedAt: number | undefined,
): 'signed-out' | 'stale' | null {
  if (signedInSince === null) return 'signed-out'
  if (
    typeof signedInSince === 'number' &&
    ticketIssuedAt !== undefined &&
    ticketIssuedAt < signedInSince - SESSION_START_MARGIN_MS
  )
    return 'stale'
  return null
}

interface PairState {
  running: Promise<void> | null
  /** Another check was requested while one was in flight: its answer may predate the change. */
  again: boolean
}

interface Admission {
  seq: number
  /** the ticket's `iat` (the api's clock) */
  iat: number
}

/** One chunk's outcome in a batched round (M7-1). */
type ChunkAnswer =
  | { kind: 'ok'; answers: AccessAnswer[] }
  /** a 404 (an older api), or the batch is off until its re-probe: these pairs are checked per pair */
  | { kind: 'unsupported' }
  /** the api could not answer: fail open (every session of these pairs stays) */
  | { kind: 'failed' }

/** What one round counted (`AccessRound`). */
interface RoundTally {
  failed: number
}

export function createAccessMonitor(opts: AccessMonitorOptions): AccessMonitor {
  const { registry, client, log } = opts
  const clock = opts.now ?? (() => Date.now())
  const pairs = new Map<string, PairState>()
  // Admission order: a check only acts on sessions admitted before it asked the API, so an answer
  // that predates a re-grant cannot close a session admitted with a newer ticket. A list per session
  // id, oldest first: a replaced socket (same id) leaves its room after its successor was admitted.
  const admissions = new Map<string, Admission[]>()
  let admissionSeq = 0
  // Last access change per board, per board/user and per user (RT-01), to catch tickets minted before it.
  const changes = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  /** M7-1: the batch route is not used before this time (after a 404 from an older api) */
  let batchOffUntil = Number.NEGATIVE_INFINITY
  let last: AccessRound | null = null

  const pairKey = (boardId: string, userId: string) => `${boardId}\n${userId}`
  // a board id never starts with a newline and a pair key always has a board id first: no collisions
  const userKey = (userId: string) => `\n${userId}`
  const sessionKey = (boardId: string, sessionId: string) => `${boardId}\n${sessionId}`
  const latest = (boardId: string, sessionId: string): Admission | undefined =>
    admissions.get(sessionKey(boardId, sessionId))?.at(-1)

  const read = (boardId: string, userId: string): Promise<AccessAnswer> =>
    client.getAccess
      ? client.getAccess(boardId, userId)
      : client.getRole(boardId, userId).then((role) => ({ role }))

  async function runCheck(boardId: string, userId: string, tally?: RoundTally): Promise<void> {
    const askedAt = admissionSeq
    let answer: AccessAnswer
    try {
      answer = await read(boardId, userId)
    } catch (e) {
      // Fail open: the ticket already bounded admission, and an API outage must not end every session.
      const reason = e instanceof AccessUnavailableError ? e.message : 'error'
      if (tally) tally.failed++
      log(`[access] check failed for board ${boardId}; keeping its sessions (${reason})`)
      return
    }
    apply(boardId, userId, answer, askedAt)
  }

  /** One pair's answer, asked when `askedAt` was the latest admission: closes what it says to close. */
  function apply(boardId: string, userId: string, answer: AccessAnswer, askedAt: number): void {
    if (stopped) return
    const room = registry.roomIfOpen(boardId)
    if (!room) return
    const { role } = answer
    for (const s of registry.sessionsOf(boardId)) {
      if (s.meta.userId !== userId) continue
      const adm = latest(boardId, s.sessionId)
      if (adm !== undefined && adm.seq > askedAt) continue
      const ended = signInEnded(answer.signedInSince, adm?.iat)
      if (role === null) {
        // First: access lost is the stronger statement (the web purges this board's unsent edits).
        log(`[access] revoked: closing a session on board ${boardId}`)
        room.closeSession(s.sessionId, 'FORBIDDEN')
      } else if (ended === 'signed-out') {
        // RT-01: terminal; the web shows the sign-in page and keeps the unsent edits for the next sign-in.
        log(`[access] signed out: closing a session on board ${boardId}`)
        room.closeSession(s.sessionId, 'NOT_AUTHENTICATED')
      } else if (ended === 'stale') {
        // RT-01: its session ended, but the person is signed in somewhere: the reconnect's ticket decides
        // (a browser that signed in again carries on; one whose session ended gets a 401: signed out).
        log(`[access] sign-in ended: closing a session on board ${boardId}`)
        room.closeSession(s.sessionId)
      } else if (role !== s.meta.role) {
        // Not fatal: the client reconnects and its new ticket carries the new role.
        log(`[access] role changed (${s.meta.role} -> ${role}): closing a session on board ${boardId}`)
        room.closeSession(s.sessionId)
      }
    }
  }

  function check(boardId: string, userId: string, force: boolean, tally?: RoundTally): Promise<void> {
    const key = pairKey(boardId, userId)
    let state = pairs.get(key)
    if (state?.running) {
      // A periodic round never piles up behind a slow API; an access change always gets a fresh answer.
      if (force) state.again = true
      return state.running
    }
    state = { running: null, again: false }
    pairs.set(key, state)
    const s = state
    s.running = (async () => {
      try {
        let first = true
        do {
          s.again = false
          await runCheck(boardId, userId, first ? tally : undefined)
          first = false
        } while (s.again && !stopped)
      } finally {
        s.running = null
        if (pairs.get(key) === s) pairs.delete(key)
      }
    })()
    return s.running
  }

  /** M7-1: one chunk of a batched round (never throws). */
  async function askChunk(chunk: readonly AccessPair[], tally: RoundTally): Promise<ChunkAnswer> {
    const getMany = client.getAccessMany
    if (stopped || !getMany) return { kind: 'failed' }
    if (clock() < batchOffUntil) return { kind: 'unsupported' }
    try {
      return { kind: 'ok', answers: await getMany.call(client, chunk) }
    } catch (e) {
      if (e instanceof AccessBatchUnsupportedError) {
        if (batchOffUntil === Number.NEGATIVE_INFINITY)
          log(
            `[access] the api has no batched access check (an older api): checking each pair, trying the batch again in ${Math.round(BATCH_REPROBE_MS / 60_000)} min`,
          )
        batchOffUntil = clock() + BATCH_REPROBE_MS
        return { kind: 'unsupported' }
      }
      tally.failed++
      const reason = e instanceof AccessUnavailableError ? e.message : 'error'
      // fail open; no ids in the line (one line per chunk, not per pair)
      log(`[access] batched check of ${chunk.length} pairs failed; keeping their sessions (${reason})`)
      return { kind: 'failed' }
    }
  }

  /**
   * M7-1: the periodic round's batchable pairs, ACCESS_MANY_MAX_PAIRS per request, one request after another.
   * Each pair is marked running for the round (a forced check meanwhile runs again after it), answered from its
   * chunk (or per pair when the chunk is unsupported), and its `again` loop runs as a per-pair check's does.
   */
  function batchRound(list: readonly AccessPair[], tally: RoundTally): Promise<void>[] {
    const askedAt = admissionSeq
    const chunks: Promise<ChunkAnswer>[] = []
    let prev: Promise<unknown> = Promise.resolve()
    for (let i = 0; i < list.length; i += ACCESS_MANY_MAX_PAIRS) {
      const chunk = list.slice(i, i + ACCESS_MANY_MAX_PAIRS)
      const asked = prev.then(() => askChunk(chunk, tally))
      chunks.push(asked)
      prev = asked
    }
    return list.map((p, i) => {
      const key = pairKey(p.boardId, p.userId)
      const s: PairState = { running: null, again: false }
      pairs.set(key, s)
      s.running = (async () => {
        try {
          const res = await (chunks[Math.floor(i / ACCESS_MANY_MAX_PAIRS)] as Promise<ChunkAnswer>)
          if (res.kind === 'ok') {
            const answer = res.answers[i % ACCESS_MANY_MAX_PAIRS]
            if (answer) apply(p.boardId, p.userId, answer, askedAt)
          } else if (res.kind === 'unsupported') await runCheck(p.boardId, p.userId, tally)
          while (s.again && !stopped) {
            s.again = false
            await runCheck(p.boardId, p.userId)
          }
        } finally {
          s.running = null
          if (pairs.get(key) === s) pairs.delete(key)
        }
      })()
      return s.running
    })
  }

  function usersOn(boardId: string): string[] {
    return [...new Set(registry.sessionsOf(boardId).map((s) => s.meta.userId))]
  }

  function pruneChanges(now: number) {
    for (const [k, at] of changes) if (now - at > CHANGE_MEMORY_MS) changes.delete(k)
  }

  /** The next round, `jitteredDelay` from now; the round after it is scheduled when this one starts. */
  function schedule(): void {
    if (stopped) return
    timer = setTimeout(
      () => {
        timer = null
        schedule()
        void monitor.checkAll()
      },
      jitteredDelay(opts.intervalMs, opts.random),
    )
    timer.unref?.()
  }

  const monitor: AccessMonitor = {
    start() {
      if (timer || stopped) return
      schedule()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    lastRound: () => (last ? { ...last } : null),
    admitted(boardId, sessionId, userId, ticketIssuedAt) {
      const key = sessionKey(boardId, sessionId)
      const list = admissions.get(key) ?? []
      list.push({ seq: ++admissionSeq, iat: ticketIssuedAt })
      // a session id has one live socket, and briefly the one it replaced: never more than a few
      if (list.length > 4) list.splice(0, list.length - 4)
      admissions.set(key, list)
      const changedAt = Math.max(
        changes.get(boardId) ?? Number.NEGATIVE_INFINITY,
        changes.get(pairKey(boardId, userId)) ?? Number.NEGATIVE_INFINITY,
        changes.get(userKey(userId)) ?? Number.NEGATIVE_INFINITY,
      )
      // The ticket may carry the role from before the change (or predate a revocation, or come from a
      // session that has just ended). The margin absorbs clock skew between the API (which stamps iat)
      // and this process.
      if (ticketIssuedAt <= changedAt + CLOCK_SKEW_MS) void check(boardId, userId, true)
    },
    removed(boardId, sessionId) {
      const key = sessionKey(boardId, sessionId)
      const list = admissions.get(key)
      if (!list) return
      list.shift() // the oldest: a replaced socket leaves after its successor was admitted
      if (list.length === 0) admissions.delete(key)
    },
    async accessChanged(boardId, userId) {
      const now = Date.now()
      pruneChanges(now)
      changes.set(userId === undefined ? boardId : pairKey(boardId, userId), now)
      const users = userId === undefined ? usersOn(boardId) : usersOn(boardId).filter((u) => u === userId)
      await Promise.all(users.map((u) => check(boardId, u, true)))
    },
    async userChanged(userId) {
      const now = Date.now()
      pruneChanges(now)
      changes.set(userKey(userId), now)
      const boards = registry
        .openBoards()
        .filter((b) => registry.sessionsOf(b).some((s) => s.meta.userId === userId))
      await Promise.all(boards.map((b) => check(b, userId, true)))
    },
    async checkAll() {
      if (stopped) return
      const at = clock()
      pruneChanges(Date.now())
      const tally: RoundTally = { failed: 0 }
      const work: Promise<void>[] = []
      const batchable: AccessPair[] = []
      const batchOn = client.getAccessMany !== undefined && at >= batchOffUntil
      let count = 0
      for (const boardId of registry.openBoards())
        for (const userId of usersOn(boardId)) {
          count++
          const running = pairs.get(pairKey(boardId, userId))?.running
          // a pair being checked (a forced check, or the last round's batch still on its way) is not asked again
          if (running) work.push(running)
          else if (batchOn && AccessManyPair.safeParse({ boardId, userId }).success)
            batchable.push({ boardId, userId })
          else work.push(check(boardId, userId, false, tally))
        }
      if (batchable.length) work.push(...batchRound(batchable, tally))
      await Promise.all(work)
      last = {
        at,
        pairs: count,
        failed: tally.failed,
        batched: batchable.length > 0 && clock() >= batchOffUntil,
      }
    },
  }
  return monitor
}
