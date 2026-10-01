/**
 * The board socket as a `Transport` (docs/EXCALIDRAW-MIGRATION.md §2.4.2, §2.5.6): one WebSocket to
 * `/connect/:boardId?sessionId=…&ticket=…`, reconnected with backoff, for the browser (window.WebSocket)
 * and Node 24 (the global WebSocket) alike.
 *
 * Inbound frames are parsed and validated before `onMessage` (the frozen `ServerMessage` schema; the one
 * binary frame, the gzip snapshot after a reset welcome, through `decodeSnapshotFrame`), strictly in
 * arrival order: the snapshot decode is asynchronous, so later frames wait behind it. A frame that fails
 * the schema is logged by type only and dropped (never shown, never applied).
 *
 * Closes: 4099 is terminal (no reconnect: NOT_AUTHENTICATED, FORBIDDEN, INVALID_MESSAGE, …); anything
 * else reconnects with a fresh URL (a fresh ticket in the browser). `close()` stops for good. The room
 * announces every terminal close in band first (`notice` CLOSING, `detail` = the reason; CONTRACTS_REV 9,
 * SMK-2): through the Render edge a refused socket got an EMPTY close frame (no 4099, no reason), so the
 * close that follows the notice on the same socket is reported as 4099 with the announced reason whatever
 * the frame carries, and the board page's reason screens ("Lobby is updating", a refused ticket) work.
 *
 * Heartbeat (wave 5): every `heartbeatMs` an open socket sends a `ping` (the room answers `pong` at
 * once); a ping whose pong has not arrived when the next one is due means the socket is dead (a half-open
 * connection: the server or the network went away without a close, or only this socket's upstream is
 * gone while the server's frames still arrive) and it is dropped as a close 4000 `heartbeat`, so the page
 * reconnects. Before, a silent socket stayed open, and every push made on it was "in flight" until the
 * browser gave up on it, which widened the lost-push window (V1 re-check, R8); and the ping went out only
 * after silence, so a socket whose upstream was dead while other users' changes kept arriving was never
 * found: a push stayed in flight on it for as long as the others kept working (V1 re-check round 3, H2).
 *
 * NODE-SAFE (CONTRACTS.md): no DOM types; the socket is a structural `WebSocketLike`.
 */
import {
  CLOSE_TERMINAL,
  type ClientMessage,
  decodeSnapshotFrame,
  ServerMessage,
} from '@draftroom/canvas-schema/protocol'
import type { ServerInbound, Transport, TransportClose, TransportState } from '../types.ts'

/** The part of a WebSocket the transport uses (browser `WebSocket` and Node's global one both fit). */
export interface WebSocketLike {
  readonly readyState: number
  binaryType: string
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { readonly data: unknown }) => void) | null
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type WebSocketCtor = new (url: string) => WebSocketLike

export interface SocketTransportOptions {
  /** the connect URL for each attempt (the browser fetches a fresh ticket per attempt) */
  readonly url: () => string | Promise<string>
  readonly WebSocketImpl: WebSocketCtor
  /** reconnect after a non-terminal close (default true) */
  readonly reconnect?: boolean
  readonly backoffMs?: readonly number[]
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  /** every inbound frame, decoded (the headless client's `received()`), before validation drops anything */
  readonly onRaw?: (message: ServerInbound) => void
  /** the ping cadence, and how long a ping may stay unanswered before the socket counts as dead (default 15 s; 0: no heartbeat) */
  readonly heartbeatMs?: number
  readonly now?: () => number
  readonly log?: (event: string, detail: Readonly<Record<string, unknown>>) => void
}

export interface SocketTransport extends Transport {
  /** opens the first socket (idempotent) */
  connect(): void
  /** sends any frame as is, bypassing the schema (forged frames, protocol tests) */
  sendRaw(frame: ClientMessage | string): void
  /** the number of sockets opened so far */
  readonly attempts: number
}

const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 4000, 5000] as const
/** The close a dead (silent) socket is reported with. */
export const HEARTBEAT_CLOSE = { code: 4000, reason: 'heartbeat' } as const
export const HEARTBEAT_MS = 15_000
const OPEN = 1

async function bytesOf(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const blob = data as { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (blob && typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return null
}

export function createSocketTransport(opts: SocketTransportOptions): SocketTransport {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF
  const msgListeners = new Set<(m: ServerInbound) => void>()
  const stateListeners = new Set<(s: TransportState, c?: TransportClose) => void>()
  let state: TransportState = 'closed'
  let ws: WebSocketLike | null = null
  let stopped = false
  let started = false
  let failures = 0
  let attempts = 0
  let timer: unknown = null
  let chain: Promise<void> = Promise.resolve()
  let generation = 0
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const now = opts.now ?? (() => Date.now())
  let beat: unknown = null
  const stopBeat = () => {
    if (beat !== null) clearTimer(beat)
    beat = null
  }

  const setState = (s: TransportState, c?: TransportClose) => {
    state = s
    for (const l of [...stateListeners]) l(s, c)
  }
  const deliver = (m: ServerInbound) => {
    for (const l of [...msgListeners]) l(m)
  }

  const onFrame = (data: unknown, gen: number) => {
    lastFrameAt = now()
    chain = chain.then(async () => {
      if (gen !== generation) return
      if (typeof data === 'string') {
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          opts.log?.('server_frame_not_json', { bytes: data.length })
          return
        }
        const r = ServerMessage.safeParse(parsed)
        if (!r.success) {
          opts.log?.('server_frame_invalid', {
            type: (parsed as { type?: unknown } | null)?.type ?? null,
            issue: r.error.issues[0]?.message ?? '',
          })
          return
        }
        // only the room's answer to this socket's ping proves the upstream path (other frames do not)
        if (r.data.type === 'pong' && gen === generation) awaitingPong = false
        // the close that follows is terminal with this reason, whatever its frame says (SMK-2)
        if (r.data.type === 'notice' && r.data.code === 'CLOSING' && gen === generation)
          announced = r.data.detail || 'UNKNOWN_ERROR'
        opts.onRaw?.(r.data)
        deliver(r.data)
        return
      }
      const bytes = await bytesOf(data)
      if (!bytes) return
      try {
        const frame = await decodeSnapshotFrame(bytes)
        if (gen !== generation) return
        opts.onRaw?.(frame)
        deliver(frame)
      } catch (err) {
        opts.log?.('snapshot_frame_invalid', { error: String(err).slice(0, 200) })
      }
    })
  }

  let lastFrameAt = 0
  /** a ping is out and its pong has not come back */
  let awaitingPong = false
  /** the reason a `notice` CLOSING announced on the current socket, or null */
  let announced: string | null = null
  /** The close to report: the announced terminal one when the frame lost its code or reason on the way. */
  const closeOf = (code: number, reason: string): TransportClose => {
    if (announced === null || (code === CLOSE_TERMINAL && reason)) return { code, reason }
    opts.log?.('socket_close_announced', { code, reason: announced })
    return { code: CLOSE_TERMINAL, reason: announced }
  }
  /** Every heartbeatMs on an open socket: a ping; a drop when the previous ping got no pong in time. */
  const startBeat = (sock: WebSocketLike, gen: number) => {
    stopBeat()
    if (heartbeatMs <= 0) return
    lastFrameAt = now()
    awaitingPong = false
    const tick = () => {
      beat = null
      if (gen !== generation || stopped) return
      if (awaitingPong) {
        // a half-open socket (or one whose upstream is gone): no close will come, so it is dropped here
        // and the page reconnects
        opts.log?.('socket_heartbeat_dead', { silentMs: now() - lastFrameAt, unansweredMs: heartbeatMs })
        generation++
        ws = null
        try {
          sock.close(HEARTBEAT_CLOSE.code, HEARTBEAT_CLOSE.reason)
        } catch {
          // closing a dead socket may throw: it is gone either way
        }
        chain = chain.then(() => {
          if (stopped) return
          // a socket the room said it was closing and that never closed: terminal all the same
          const close = closeOf(HEARTBEAT_CLOSE.code, HEARTBEAT_CLOSE.reason)
          setState('closed', close)
          if (close.code !== CLOSE_TERMINAL) scheduleReconnect()
        })
        return
      }
      awaitingPong = true
      if (sock.readyState === OPEN) sock.send(JSON.stringify({ type: 'ping' }))
      beat = setTimer(tick, heartbeatMs)
    }
    beat = setTimer(tick, heartbeatMs)
  }

  const open = async () => {
    if (stopped) return
    const gen = ++generation
    setState('connecting')
    let url: string
    try {
      url = await opts.url()
    } catch (err) {
      opts.log?.('socket_url_failed', { error: String(err).slice(0, 200) })
      scheduleReconnect()
      return
    }
    if (stopped || gen !== generation) return
    attempts++
    const sock = new opts.WebSocketImpl(url)
    ws = sock
    announced = null
    sock.binaryType = 'arraybuffer'
    sock.onopen = () => {
      if (gen !== generation) return
      failures = 0
      startBeat(sock, gen)
      setState('open')
    }
    sock.onmessage = (ev) => onFrame(ev.data, gen)
    sock.onerror = () => {}
    sock.onclose = (ev) => {
      if (gen !== generation) return
      ws = null
      stopBeat()
      // frames already received are processed before the close is reported (a CLOSING notice among them)
      chain = chain.then(() => {
        if (gen !== generation) return
        const close = closeOf(ev.code, ev.reason)
        setState('closed', close)
        if (close.code === CLOSE_TERMINAL || stopped || opts.reconnect === false) return
        scheduleReconnect()
      })
    }
  }

  const scheduleReconnect = () => {
    if (stopped || timer !== null) return
    const ms = backoff[Math.min(failures, backoff.length - 1)] ?? 5000
    failures++
    timer = setTimer(() => {
      timer = null
      void open()
    }, ms)
  }

  return {
    get state() {
      return state
    },
    get attempts() {
      return attempts
    },
    connect() {
      if (started) return
      started = true
      void open()
    },
    send(message) {
      if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(message))
    },
    sendRaw(frame) {
      if (ws && ws.readyState === OPEN) ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
    },
    onMessage(l) {
      msgListeners.add(l)
      return () => msgListeners.delete(l)
    },
    onState(l) {
      stateListeners.add(l)
      return () => stateListeners.delete(l)
    },
    close(code = 1000, reason = '') {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
      stopBeat()
      const sock = ws
      ws = null
      generation++
      if (sock) sock.close(code, reason)
      setState('closed', { code, reason })
    },
  }
}
