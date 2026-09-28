// "The last editor left after changes" (docs/WAVE4-CONTRACTS.md checkpoints-2, REV-10): the API saves
// an automatic checkpoint when that happens, but only this process knows who is in a room. So, like the
// edit reports (touch.ts), it tells the API: after an accepted document write, a board is marked
// changed; when a session that could edit leaves and no session that can edit remains, a changed board
// is reported once (GET <api>/internal/boards/:bid/session-ended?at=<ms>) and is no longer marked.
//
// Fire-and-forget with a short timeout: a slow or unreachable API never delays the room, and a lost
// report only means the checkpoint comes with the API's hourly pass instead (the edit reports keep the
// API's own record of unsaved changes). Viewers and commenters leaving never report anything; neither
// does a room closing at shutdown (the sessions are gone before this is asked).
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { canEditCanvas } from './permissions.ts'
import type { SessionMeta } from './rooms.ts'

export interface SessionEndClient {
  /** Tells the API that the last editor left `boardId` at `at` (epoch ms) after changes. Rejects on failure. */
  ended(boardId: string, at: number): Promise<void>
}

export interface ApiSessionEndClientOptions {
  /** DRAFTROOM_API_INTERNAL_URL (no trailing slash). */
  baseUrl: string
  internalSecret: string
  /** Default 3000. */
  timeoutMs?: number
  fetch?: typeof fetch
}

/** A GET for the same reason as touch.ts: the API's CSRF hook refuses POSTs without the web Origin. */
export function createApiSessionEndClient(opts: ApiSessionEndClientOptions): SessionEndClient {
  const doFetch = opts.fetch ?? fetch
  return {
    async ended(boardId, at) {
      const url = `${opts.baseUrl}/internal/boards/${encodeURIComponent(boardId)}/session-ended?${new URLSearchParams({ at: String(Math.trunc(at)) })}`
      const res = await doFetch(url, {
        headers: { [INTERNAL_SECRET_HEADER]: opts.internalSecret, accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
        redirect: 'error', // never forward the secret anywhere else
      })
      await res.body?.cancel()
      if (res.status !== 204 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
    },
  }
}

export interface SessionEndReporterOptions {
  client: SessionEndClient
  /** Whether a session that can edit the canvas is still in the board's room. */
  hasEditors(boardId: string): boolean
  now?: () => number
  log?: (...a: unknown[]) => void
}

export interface SessionEndReporter {
  /** An accepted document write on `boardId` just happened. Never throws, never blocks. */
  changed(boardId: string): void
  /** A session left `boardId`'s room (it is already gone from the room's sessions). Never throws. */
  removed(boardId: string, meta: SessionMeta): void
  /** Waits for the reports in flight (shutdown). */
  flush(): Promise<void>
  stop(): void
}

/** More changed boards than this are unusual (each is an open room); past it the oldest marks are dropped. */
const MAX_TRACKED = 5_000

export function createSessionEndReporter(opts: SessionEndReporterOptions): SessionEndReporter {
  const now = opts.now ?? Date.now
  const changed = new Set<string>()
  const inflight = new Set<Promise<void>>()
  let stopped = false
  let lastErrorLogAt = Number.NEGATIVE_INFINITY

  const send = (boardId: string) => {
    let p: Promise<void>
    try {
      p = opts.client.ended(boardId, now())
    } catch (e) {
      p = Promise.reject(e)
    }
    const tracked = p.catch((e: unknown) => {
      // One line per minute at most: an API outage must not flood the log.
      const t = now()
      if (t - lastErrorLogAt >= 60_000) {
        lastErrorLogAt = t
        opts.log?.(
          `[session-end] could not report a finished session to the api (${(e as Error)?.message ?? 'error'})`,
        )
      }
    })
    inflight.add(tracked)
    void tracked.finally(() => inflight.delete(tracked))
  }

  return {
    changed(boardId) {
      if (stopped || changed.has(boardId)) return
      if (changed.size >= MAX_TRACKED) {
        const oldest = changed.values().next().value
        if (oldest !== undefined) changed.delete(oldest)
      }
      changed.add(boardId)
    },
    removed(boardId, meta) {
      if (stopped || !changed.has(boardId) || !canEditCanvas(meta.role)) return
      try {
        if (opts.hasEditors(boardId)) return
      } catch (e) {
        opts.log?.('[session-end] editor lookup failed', boardId, (e as Error)?.message)
        return
      }
      changed.delete(boardId)
      send(boardId)
    },
    async flush() {
      await Promise.allSettled([...inflight])
    },
    stop() {
      stopped = true
      changed.clear()
    },
  }
}
