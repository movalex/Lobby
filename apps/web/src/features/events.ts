// Client for GET /api/boards/:bid/events (server-sent events; see apps/api/src/events). One stream
// per open board, shared by every feature. Events are hints: on every (re)open the stream emits
// 'hello' and features re-fetch their authoritative state through onResync.

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
  /** Server time minus local time in ms (from the last 'hello'); use for countdowns. */
  serverOffsetMs(): number
  /** Server-side access loss (the stream says so before closing). */
  onAccessLost(listener: () => void): () => void
  close(): void
}

export function createBoardEvents(boardId: string, opts: { url?: string } = {}): BoardEvents {
  const url = opts.url ?? `/api/boards/${encodeURIComponent(boardId)}/events`
  const listeners = new Map<string, Set<Listener>>()
  const resync = new Set<() => void>()
  const lost = new Set<() => void>()
  let offset = 0
  let connected = false
  let closed = false
  let source: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryMs = 1_000

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
    if (closed || typeof EventSource === 'undefined') return
    // Same-origin: the session cookie goes with the request; no credentials flag needed.
    const es = new EventSource(url)
    source = es
    es.onmessage = (ev) => {
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
      // EventSource retries by itself for network errors, but gives up on HTTP errors (401/404):
      // take over with our own bounded backoff so a restarted API is picked up again.
      connected = false
      if (es.readyState === EventSource.CLOSED) {
        source = null
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
      source?.close()
      source = null
      listeners.clear()
      resync.clear()
      lost.clear()
    },
  }
}
