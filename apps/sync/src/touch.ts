// "Edited N min ago" for canvas edits (RETRO-19). The API owns boards.updated_at, but canvas writes
// only reach this process. After an accepted document write, the board's last write time is reported
// to the API, throttled to at most one call per board per interval (default 60 s): the first write
// after a quiet period is reported at once, later ones at the end of the window (the latest time
// only). Fire-and-forget with a short timeout: a slow or unreachable API never delays the sync loop,
// and a failure only means the dashboard shows an older "Edited" time.
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'

export interface TouchClient {
  /** Tells the API that `boardId`'s document last changed at `at` (epoch ms). Rejects on failure. */
  touched(boardId: string, at: number): Promise<void>
}

export interface ApiTouchClientOptions {
  /** DRAFTROOM_API_INTERNAL_URL (no trailing slash). */
  baseUrl: string
  internalSecret: string
  /** Default 3000. */
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * GET <api>/internal/boards/:bid/touched?at=<ms> with the internal secret. A GET because the API's
 * root CSRF hook refuses every POST whose Origin is not the web origin (server-to-server calls have
 * none); the call is idempotent (updated_at only ever moves forward to `at`).
 */
export function createApiTouchClient(opts: ApiTouchClientOptions): TouchClient {
  const doFetch = opts.fetch ?? fetch
  return {
    async touched(boardId, at) {
      const url = `${opts.baseUrl}/internal/boards/${encodeURIComponent(boardId)}/touched?${new URLSearchParams({ at: String(Math.trunc(at)) })}`
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

export interface TouchReporterOptions {
  client: TouchClient
  /** At most one report per board per this many ms. Default 60 000. */
  intervalMs?: number
  now?: () => number
  log?: (...a: unknown[]) => void
}

export interface TouchReporter {
  /** An accepted document write on `boardId` just happened. Never throws, never blocks. */
  touched(boardId: string): void
  /** Sends every pending (trailing) report now and waits for the calls in flight (shutdown). */
  flush(): Promise<void>
  stop(): void
}

interface BoardState {
  lastSentAt: number
  /** Time of the newest write not reported yet. */
  pendingAt: number | null
  timer: ReturnType<typeof setTimeout> | null
}

const PRUNE_ABOVE = 500

export function createTouchReporter(opts: TouchReporterOptions): TouchReporter {
  const interval = opts.intervalMs ?? 60_000
  const now = opts.now ?? Date.now
  const boards = new Map<string, BoardState>()
  const inflight = new Set<Promise<void>>()
  let stopped = false
  let lastErrorLogAt = Number.NEGATIVE_INFINITY

  const send = (boardId: string, at: number) => {
    let p: Promise<void>
    try {
      p = opts.client.touched(boardId, at)
    } catch (e) {
      p = Promise.reject(e)
    }
    const tracked = p.catch((e: unknown) => {
      // One line per minute at most: an API outage must not flood the log.
      const t = now()
      if (t - lastErrorLogAt >= 60_000) {
        lastErrorLogAt = t
        opts.log?.(`[touch] could not report a board edit to the api (${(e as Error)?.message ?? 'error'})`)
      }
    })
    inflight.add(tracked)
    void tracked.finally(() => inflight.delete(tracked))
  }

  const fireTrailing = (boardId: string, s: BoardState) => {
    s.timer = null
    if (s.pendingAt === null || stopped) return
    const at = s.pendingAt
    s.pendingAt = null
    s.lastSentAt = now()
    send(boardId, at)
  }

  const prune = (t: number) => {
    for (const [id, s] of boards)
      if (!s.timer && s.pendingAt === null && t - s.lastSentAt >= interval) boards.delete(id)
  }

  return {
    touched(boardId) {
      if (stopped) return
      const t = now()
      const s = boards.get(boardId)
      if (!s || t - s.lastSentAt >= interval) {
        if (s?.timer) clearTimeout(s.timer)
        boards.set(boardId, { lastSentAt: t, pendingAt: null, timer: null })
        if (boards.size > PRUNE_ABOVE) prune(t)
        send(boardId, t)
        return
      }
      s.pendingAt = t
      if (!s.timer) {
        s.timer = setTimeout(() => fireTrailing(boardId, s), Math.max(0, s.lastSentAt + interval - t))
        s.timer.unref?.()
      }
    },
    async flush() {
      for (const [id, s] of boards) {
        if (s.timer) clearTimeout(s.timer)
        fireTrailing(id, s)
      }
      await Promise.allSettled([...inflight])
    },
    stop() {
      stopped = true
      for (const s of boards.values()) if (s.timer) clearTimeout(s.timer)
      boards.clear()
    },
  }
}
