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
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import type { SessionDirectory } from './engine-switch.ts'
import { BOARD_ROLES, type BoardRole } from './permissions.ts'

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
}

export class AccessUnavailableError extends Error {}

export interface ApiAccessClientOptions {
  /** DRAFTROOM_API_INTERNAL_URL (no trailing slash). */
  baseUrl: string
  internalSecret: string
  /** Short on purpose: a slow API must not delay the next round. Default 3000. */
  timeoutMs?: number
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
  return {
    getAccess,
    async getRole(boardId, userId) {
      return (await getAccess(boardId, userId)).role
    },
  }
}

export interface AccessMonitorOptions {
  /** The ElementRoom service (a SessionDirectory). */
  registry: SessionDirectory
  client: AccessClient
  intervalMs: number
  log: (...a: unknown[]) => void
}

export interface AccessMonitor {
  start(): void
  stop(): void
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

export function createAccessMonitor(opts: AccessMonitorOptions): AccessMonitor {
  const { registry, client, log } = opts
  const pairs = new Map<string, PairState>()
  // Admission order: a check only acts on sessions admitted before it asked the API, so an answer
  // that predates a re-grant cannot close a session admitted with a newer ticket. A list per session
  // id, oldest first: a replaced socket (same id) leaves its room after its successor was admitted.
  const admissions = new Map<string, Admission[]>()
  let admissionSeq = 0
  // Last access change per board, per board/user and per user (RT-01), to catch tickets minted before it.
  const changes = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

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

  async function runCheck(boardId: string, userId: string): Promise<void> {
    const askedAt = admissionSeq
    let answer: AccessAnswer
    try {
      answer = await read(boardId, userId)
    } catch (e) {
      // Fail open: the ticket already bounded admission, and an API outage must not end every session.
      const reason = e instanceof AccessUnavailableError ? e.message : 'error'
      log(`[access] check failed for board ${boardId}; keeping its sessions (${reason})`)
      return
    }
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

  function check(boardId: string, userId: string, force: boolean): Promise<void> {
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
        do {
          s.again = false
          await runCheck(boardId, userId)
        } while (s.again && !stopped)
      } finally {
        s.running = null
        if (pairs.get(key) === s) pairs.delete(key)
      }
    })()
    return s.running
  }

  function usersOn(boardId: string): string[] {
    return [...new Set(registry.sessionsOf(boardId).map((s) => s.meta.userId))]
  }

  function pruneChanges(now: number) {
    for (const [k, at] of changes) if (now - at > CHANGE_MEMORY_MS) changes.delete(k)
  }

  const monitor: AccessMonitor = {
    start() {
      if (timer || stopped) return
      timer = setInterval(() => void monitor.checkAll(), opts.intervalMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    },
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
      pruneChanges(Date.now())
      const work: Promise<void>[] = []
      for (const boardId of registry.openBoards())
        for (const userId of usersOn(boardId)) work.push(check(boardId, userId, false))
      await Promise.all(work)
    },
  }
  return monitor
}
