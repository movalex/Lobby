// RT-01 (realtime audit, wave J3): ended sessions reach the canvas sockets. When this store revokes
// sessions (logout, "Sign out everywhere", a sign-in that replaces this browser's session, an identity
// refresh that finds the account banned or deleted), the sync server is told whose they were:
// POST <sync>/internal/access-changed `{ userId }` (no boardId). It re-checks that person on every open
// board right away; GET /internal/access answers `signedInSince` (session.ts): a socket of someone with
// no live session closes 4099 NOT_AUTHENTICATED, and one whose ticket is older than every live session of
// theirs closes 4000 RECONNECT (its new ticket needs a live session). The person can sign in again at
// once: the new session's tickets are newer.
//
// Called AFTER the revocation committed (the sync server reads the state back from us). Fire-and-forget
// like notifier.ts: a slow or down sync server never fails or delays the request, and its periodic
// re-check (ACCESS_RECHECK_MS, 10 s) applies the same rule. A sync from before J3 answers 400 to this
// body (logged here once a minute at most) and ignores `signedInSince`: there, nothing changes until it
// is deployed too (either may go first).

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'

export interface SessionEndNotifier {
  /** These people's sessions just ended (after the revocation committed). Never throws. */
  ended(userIds: readonly string[]): void
  /** Resolves when the notifications in flight have finished (each is bounded by its timeout). */
  drain(): Promise<void>
}

export interface SessionEndLog {
  warn(obj: object, msg: string): void
}

export function createHttpSessionEndNotifier(opts: {
  /** DRAFTROOM_SYNC_INTERNAL_URL (no trailing slash). */
  baseUrl: string
  secret: string
  log: SessionEndLog
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}): SessionEndNotifier {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const inflight = new Set<Promise<void>>()
  const url = `${opts.baseUrl}/internal/access-changed`
  let lastWarnAt = Number.NEGATIVE_INFINITY

  // One line a minute at most: a sync outage (or a sync from before J3) must not flood the log.
  const warn = (obj: object, msg: string) => {
    const t = now()
    if (t - lastWarnAt < 60_000) return
    lastWarnAt = t
    opts.log.warn(obj, msg)
  }

  async function send(userId: string): Promise<void> {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_SECRET_HEADER]: opts.secret },
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
        redirect: 'error', // never forward the secret anywhere else
      })
      await res.body?.cancel()
      if (!res.ok) warn({ status: res.status }, 'sync session-end refused')
    } catch (e) {
      const reason = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable'
      warn({ reason }, 'sync session-end not delivered')
    }
  }

  return {
    ended(userIds) {
      for (const userId of new Set(userIds)) {
        if (!userId) continue
        const p = send(userId)
        inflight.add(p)
        void p.finally(() => inflight.delete(p))
      }
    },
    async drain() {
      await Promise.all([...inflight])
    },
  }
}

/** Records the people instead of telling a sync server (tests, and tools that run the api alone). */
export function createRecordingSessionEndNotifier(): SessionEndNotifier & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ended(userIds) {
      for (const u of new Set(userIds)) if (u) calls.push(u)
    },
    drain: async () => {},
  }
}
