// Client for GET /api/boards/:bid/events (server-sent events; see apps/api/src/events). One stream
// per open board, shared by every feature. Events are hints: on every (re)open the stream emits
// 'hello' and features re-fetch their authoritative state through onResync.
//
// Liveness: the api sends a data 'ping' every 15 s. A proxy between the browser and the api (vite
// dev/preview, a static-site rewrite) can keep the browser's side open after the api died, and an
// SSE comment never reaches JS, so a stream that delivers nothing for `staleMs` is treated as dead
// and replaced by a fresh one (whose 'hello' makes every feature refetch).

export interface BoardEventMessage {
  type: string
  data: unknown
  seq: number
  at?: string
}

type Listener = (data: unknown, message: BoardEventMessage) => void

export interface BoardEvents {
  /** Subscribe to one event type; returns an unsubscribe function. */
  on(type: string, listener: Listener): () => void
  /** Called after every (re)connect (and immediately if already connected): refetch your state. */
  onResync(listener: () => void): () => void
  /**
   * Server time minus local time in ms, from the last 'hello': serverNow minus the local time the
   * message was handled. One-way, so it also absorbs every delay before handling (network, a busy
   * main thread); a countdown that must agree across people should measure a round trip instead
   * (features/workshops/store.ts does).
   */
  serverOffsetMs(): number
  /** Server-side access loss (the stream says so before closing). */
  onAccessLost(listener: () => void): () => void
  close(): void
}

/** Nothing received for this long (the api pings every 15 s) => the stream is dead: reopen it. */
export const STALE_STREAM_MS = 40_000

export function createBoardEvents(
  boardId: string,
  opts: { url?: string; staleMs?: number } = {},
): BoardEvents {
  const url = opts.url ?? `/api/boards/${encodeURIComponent(boardId)}/events`
  const staleMs = opts.staleMs ?? STALE_STREAM_MS
  const listeners = new Map<string, Set<Listener>>()
  const resync = new Set<() => void>()
  const lost = new Set<() => void>()
  let offset = 0
  let connected = false
  let closed = false
  let source: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryMs = 1_000
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  const clearStale = () => {
    if (staleTimer) clearTimeout(staleTimer)
    staleTimer = null
  }

  const emit = (msg: BoardEventMessage) => {
    for (const l of listeners.get(msg.type) ?? []) {
      try {
        l(msg.data, msg)
      } catch (e) {
        console.error('board event listener failed', msg.type, e)
      }
    }
  }

  const open = () => {
    retryTimer = null
    if (closed || typeof EventSource === 'undefined') return
    // Same-origin: the session cookie goes with the request; no credentials flag needed.
    const es = new EventSource(url)
    source = es
    // Armed on open and re-armed by every message.
    const armStale = () => {
      clearStale()
      staleTimer = setTimeout(() => {
        staleTimer = null
        if (closed || source !== es) return
        es.close()
        source = null
        connected = false
        open()
      }, staleMs)
    }
    armStale()
    es.onmessage = (ev) => {
      if (source !== es) return
      armStale()
      let msg: BoardEventMessage
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'hello') {
        const serverNow = Date.parse((msg.data as { serverNow?: string } | null)?.serverNow ?? '')
        if (!Number.isNaN(serverNow)) offset = serverNow - Date.now()
        connected = true
        retryMs = 1_000
        for (const r of resync) r()
      } else if (msg.type === 'access-lost') {
        for (const l of lost) l()
      }
      emit(msg)
    }
    es.onerror = () => {
      if (source !== es) return
      // EventSource retries by itself for network errors, but gives up on HTTP errors (401/404):
      // take over with our own bounded backoff so a restarted API is picked up again.
      connected = false
      if (es.readyState === EventSource.CLOSED) {
        source = null
        clearStale()
        if (!closed) {
          retryTimer = setTimeout(open, retryMs)
          retryMs = Math.min(retryMs * 2, 30_000)
        }
      }
    }
  }
  open()

  return {
    on(type, listener) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => void set?.delete(listener)
    },
    onResync(listener) {
      resync.add(listener)
      if (connected) listener()
      return () => void resync.delete(listener)
    },
    serverOffsetMs: () => offset,
    onAccessLost(listener) {
      lost.add(listener)
      return () => void lost.delete(listener)
    },
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      clearStale()
      source?.close()
      source = null
      listeners.clear()
      resync.clear()
      lost.clear()
    },
  }
}
