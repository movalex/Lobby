// api -> sync "access changed" push (docs/M1-CONTRACTS.md §7). Called AFTER the change commits (the
// sync server re-reads access from us immediately, so a notification sent inside the transaction
// would be answered with the old state). Fire-and-forget: a slow or down sync server never fails or
// delays the API request; the sync server's periodic re-check is the backstop.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'

/** Whoever made a change of access: the authenticated session's user (never taken from a request body). */
export interface AccessActor {
  id: string
  name: string
}

/** The actor of a change, from the session user (REVIEW-6): only the id and the display name. */
export const actorOf = (user: AccessActor): AccessActor => ({ id: user.id, name: user.name })

export interface AccessChange {
  boardId: string
  /** Omitted: every user on the board may be affected (visibility or status change). */
  userId?: string
  /**
   * REVIEW-6: who changed it, for the "your access changed" toast to name (a change by someone else, never
   * by the person themselves). Only this process's board event streams hear it, and only the display name
   * goes on the wire to the affected person: `fanOutAccessChanges` takes it off before the sync server is told.
   */
  actor?: AccessActor
}

/** What the sync server is told (docs/M1-CONTRACTS.md §7): which board, and whose access when it is one person's. */
export type SyncAccessChange = Pick<AccessChange, 'boardId' | 'userId'>

/** The part of a change the sync server may see: never the actor. */
function forSync(change: AccessChange): SyncAccessChange {
  return change.userId === undefined
    ? { boardId: change.boardId }
    : { boardId: change.boardId, userId: change.userId }
}

export interface SyncNotifier {
  accessChanged(change: AccessChange): void
  /** Resolves when in-flight notifications have finished (each is bounded by its timeout). */
  drain(): Promise<void>
}

export interface NotifierLog {
  warn(obj: object, msg: string): void
}

export function createHttpSyncNotifier(opts: {
  baseUrl: string
  secret: string
  log: NotifierLog
  timeoutMs?: number
  fetch?: typeof fetch
}): SyncNotifier {
  const doFetch = opts.fetch ?? fetch
  const inflight = new Set<Promise<void>>()
  const url = `${opts.baseUrl}/internal/access-changed`

  async function send(change: SyncAccessChange): Promise<void> {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_SECRET_HEADER]: opts.secret },
        body: JSON.stringify(change),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
        redirect: 'error', // never forward the secret anywhere else
      })
      await res.body?.cancel()
      if (!res.ok)
        opts.log.warn({ boardId: change.boardId, status: res.status }, 'sync access-changed refused')
    } catch (e) {
      const reason = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable'
      opts.log.warn({ boardId: change.boardId, reason }, 'sync access-changed not delivered')
    }
  }

  return {
    accessChanged(change) {
      const p = send(forSync(change))
      inflight.add(p)
      void p.finally(() => inflight.delete(p))
    },
    async drain() {
      await Promise.all([...inflight])
    },
  }
}

/**
 * One notifier for every "access changed" (docs/SECURITY-REVIEW-2026-09-27.md authz-005): the sync
 * server (canvas sockets) AND this process's board event streams (EventHub) hear about it from the
 * same call, so no route can tell one and forget the other. The local hook runs first and never
 * throws into the caller.
 */
export function fanOutAccessChanges(
  sync: SyncNotifier,
  local: { accessChanged(change: AccessChange): void },
): SyncNotifier {
  return {
    accessChanged(change) {
      try {
        local.accessChanged(change)
      } catch {
        // the periodic stream re-check is the backstop
      }
      sync.accessChanged(forSync(change))
    },
    drain: () => sync.drain(),
  }
}

/** Records calls instead of sending them (tests, and tools that run the API without a sync server). */
export function createRecordingNotifier(): SyncNotifier & { calls: SyncAccessChange[] } {
  const calls: SyncAccessChange[] = []
  return {
    calls,
    // what the sync server would be told: the actor stays in this process (the tests read it off the streams)
    accessChanged: (change) => {
      calls.push(forSync(change))
    },
    drain: async () => {},
  }
}
