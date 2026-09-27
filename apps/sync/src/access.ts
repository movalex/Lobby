// Live-session access re-validation (docs/M1-CONTRACTS.md §7). Tickets only gate admission; this
// module notices revocations and role changes while sockets stay open.
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { TLSyncErrorCloseEventReason } from '@tldraw/sync-core'
import { BOARD_ROLES, type BoardRole } from './permissions.ts'
import type { RoomRegistry } from './rooms.ts'

export interface AccessClient {
  /** The user's current role on the board, or null for no access. Throws when the API cannot answer. */
  getRole(boardId: string, userId: string): Promise<BoardRole | null>
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

/** GET <api>/internal/access?boardId=&userId= with the internal secret -> { role: BoardRole | null }. */
export function createApiAccessClient(opts: ApiAccessClientOptions): AccessClient {
  const doFetch = opts.fetch ?? fetch
  return {
    async getRole(boardId, userId) {
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
      const role = (body as { role?: unknown } | null)?.role
      if (role === null) return null
      if (typeof role === 'string' && (BOARD_ROLES as readonly string[]).includes(role))
        return role as BoardRole
      throw new AccessUnavailableError('unexpected response shape')
    },
  }
}

export interface AccessMonitorOptions {
  registry: RoomRegistry
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
  /** One periodic round (exposed for tests). */
  checkAll(): Promise<void>
}

// Ticket lifetime (60 s) + verifier clock skew (5 s): a ticket issued before an access change can
// still be presented this long after it.
const CHANGE_MEMORY_MS = 65_000
const CLOCK_SKEW_MS = 5_000

interface PairState {
  running: Promise<void> | null
  /** Another check was requested while one was in flight: its answer may predate the change. */
  again: boolean
}

export function createAccessMonitor(opts: AccessMonitorOptions): AccessMonitor {
  const { registry, client, log } = opts
  const pairs = new Map<string, PairState>()
  // Admission order: a check only acts on sessions admitted before it asked the API, so an answer
  // that predates a re-grant cannot close a session admitted with a newer ticket.
  const admissions = new Map<string, number>()
  let admissionSeq = 0
  // Last access change per board and per board/user, to catch tickets minted before the change.
  const changes = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  const pairKey = (boardId: string, userId: string) => `${boardId}\n${userId}`
  const sessionKey = (boardId: string, sessionId: string) => `${boardId}\n${sessionId}`

  async function runCheck(boardId: string, userId: string): Promise<void> {
    const askedAt = admissionSeq
    let role: BoardRole | null
    try {
      role = await client.getRole(boardId, userId)
    } catch (e) {
      // Fail open: the ticket already bounded admission, and an API outage must not end every session.
      const reason = e instanceof AccessUnavailableError ? e.message : 'error'
      log(`[access] check failed for board ${boardId}; keeping its sessions (${reason})`)
      return
    }
    if (stopped) return
    const room = registry.roomIfOpen(boardId)
    if (!room) return
    for (const s of registry.sessionsOf(boardId)) {
      if (s.meta.userId !== userId) continue
      const seq = admissions.get(sessionKey(boardId, s.sessionId))
      if (seq !== undefined && seq > askedAt) continue
      if (role === null) {
        log(`[access] revoked: closing a session on board ${boardId}`)
        room.closeSession(s.sessionId, TLSyncErrorCloseEventReason.FORBIDDEN)
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
      admissions.set(sessionKey(boardId, sessionId), ++admissionSeq)
      const changedAt = Math.max(
        changes.get(boardId) ?? Number.NEGATIVE_INFINITY,
        changes.get(pairKey(boardId, userId)) ?? Number.NEGATIVE_INFINITY,
      )
      // The ticket may carry the role from before the change (or predate a revocation). The margin
      // absorbs clock skew between the API (which stamps iat) and this process.
      if (ticketIssuedAt <= changedAt + CLOCK_SKEW_MS) void check(boardId, userId, true)
    },
    removed(boardId, sessionId) {
      admissions.delete(sessionKey(boardId, sessionId))
    },
    async accessChanged(boardId, userId) {
      const now = Date.now()
      pruneChanges(now)
      changes.set(userId === undefined ? boardId : pairKey(boardId, userId), now)
      const users = userId === undefined ? usersOn(boardId) : usersOn(boardId).filter((u) => u === userId)
      await Promise.all(users.map((u) => check(boardId, u, true)))
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
