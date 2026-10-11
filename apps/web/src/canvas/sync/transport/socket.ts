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
  CLOSE_RECONNECT,
  CLOSE_TERMINAL,
  type ClientMessage,
  CONNECT_REV_PARAM,
  CONTRACTS_REV,
  decodeSnapshotFrame,
  Pong,
  ServerMessage,
} from '@draftroom/canvas-schema/protocol'
import type { ServerInbound, Transport, TransportClose, TransportState } from '../types.ts'
import { type SnapshotDecode, SnapshotDecodeLost } from './snapshot-protocol.ts'

/**
 * The connect URL's query beyond the ticket: the tab id (`sessionId`) and, since CONTRACTS_REV 12, the contracts
 * revision this build reads (`rev`), so the room serves this socket every frame in its form and writes its pushes
 * as its revision's from the first frame on (canvas-schema protocol.ts CONNECT_REV_PARAM). A rev-11 room ignores it.
 */
export function connectQuery(tab: string, extra: Readonly<Record<string, string>> = {}): URLSearchParams {
  return new URLSearchParams({ ...extra, sessionId: tab, [CONNECT_REV_PARAM]: String(CONTRACTS_REV) })
}

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
  /** the source of the reconnect jitter (tests); default Math.random */
  readonly random?: () => number
  /**
   * M6-5: whether this tab has changes the room has not acknowledged (unsent, in flight or queued): after a
   * restart close it then comes back within RESTART_SPREAD_UNSENT_MS instead of RESTART_SPREAD_MS
   */
  readonly hasUnsent?: () => boolean
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
  /** every inbound frame, decoded (the headless client's `received()`), before validation drops anything */
  readonly onRaw?: (message: ServerInbound) => void
  /** the ping cadence, and how long a ping may stay unanswered before the socket counts as dead (default 15 s; 0: no heartbeat) */
  readonly heartbeatMs?: number
  readonly now?: () => number
  readonly log?: (event: string, detail: Readonly<Record<string, unknown>>) => void
  /**
   * N1-1 (wave N): where the binary snapshot frame is decoded (./snapshot-decoder.ts: a module Worker, or the main
   * thread); absent: `decodeSnapshotFrame` here, as before. Its `warm()` runs at a reset welcome (the frame follows).
   */
  readonly decoder?: SnapshotDecode
}

/** N1-1: the close a socket is dropped with when the snapshot worker lost its frame (the next welcome resends it). */
export const DECODE_LOST_CLOSE = { code: 4000, reason: 'decode' } as const

export interface SocketTransport extends Transport {
  /** opens the first socket (idempotent) */
  connect(): void
  /** sends any frame as is, bypassing the schema (forged frames, protocol tests) */
  sendRaw(frame: ClientMessage | string): void
  /** the number of sockets opened so far */
  readonly attempts: number
}

const DEFAULT_BACKOFF = [250, 500, 1000, 2000, 4000, 5000] as const
/**
 * Each reconnect delay is drawn from [delay × (1 − JITTER), delay × (1 + JITTER)]: when the server goes
 * away, every open tab loses its socket in the same instant, and without jitter they all come back in
 * the same few milliseconds (B9: 260 sessions, one burst of 260 hellos and 260 welcomes in the restart's
 * first second on a 0.5 CPU container). Spread by ±30 %, the fourth attempt (2 s) lands over about 1.2 s
 * and the storm is a ramp. The longest wait stays under 7 s (5 s × 1.3), well inside §2.13's 30 s.
 */
export const RECONNECT_JITTER = 0.3
/** `delay` with the jitter applied (`random` in [0, 1); Math.random by default). */
export function jitteredDelay(delay: number, random: () => number = Math.random): number {
  return Math.round(delay * (1 - RECONNECT_JITTER + random() * 2 * RECONNECT_JITTER))
}
/** The close a dead (silent) socket is reported with. */
export const HEARTBEAT_CLOSE = { code: 4000, reason: 'heartbeat' } as const
/**
 * M6-5 (wave M, CAP-RESTART): a sync restart or deploy closes every room's sockets at once with 4000 RECONNECT
 * (element-room.ts close-all), and every tab used to come back within the first backoff step (250 ms ± 30 %): one
 * burst of hellos and welcomes that kept the 0.5 CPU at 98-102 % (CAP-L1). After such a close the first reconnect
 * waits a uniform random 0 to RESTART_SPREAD_MS instead, or 0 to RESTART_SPREAD_UNSENT_MS when this tab holds
 * changes not yet acknowledged (they should land soon). Anything later is the backoff table as before. A close the
 * room announced with a CLOSING notice is terminal (no reconnect at all), and the client's own heartbeat drop (4000
 * `heartbeat`) is not the room's: both keep their behaviour.
 */
export const RESTART_SPREAD_MS = 3000
export const RESTART_SPREAD_UNSENT_MS = 500
/** Whether a close is the room's 4000 RECONNECT (a restart, a role change, a reopened room), not our heartbeat's. */
export const isRestartClose = (close: TransportClose): boolean =>
  close.code === CLOSE_RECONNECT && close.reason !== HEARTBEAT_CLOSE.reason
/** The first reconnect's wait after a restart close (`random` in [0, 1)). */
export function restartSpreadMs(unsent: boolean, random: () => number = Math.random): number {
  const span = unsent ? RESTART_SPREAD_UNSENT_MS : RESTART_SPREAD_MS
  return Math.min(span, Math.max(0, Math.round(random() * span)))
}
export const HEARTBEAT_MS = 15_000
const OPEN = 1
/** The longest text frame looked at for a pong at receipt (`{"type":"pong","n":…}` is far shorter). */
const PONG_MAX = 64

/** A text frame that is the room's `pong` (the schema's: `type` pong, an optional count, nothing else). */
function isPong(data: string): boolean {
  if (!data.includes('"pong"')) return false
  try {
    return Pong.safeParse(JSON.parse(data)).success
  } catch {
    return false
  }
}

/**
 * A user-timing mark, in a page only (headless clients of a load run, hundreds per process, never accumulate them, as
 * engine.ts `measure` does not); never throws.
 */
function mark(name: string): void {
  if (typeof (globalThis as { document?: unknown }).document === 'undefined') return
  try {
    globalThis.performance?.mark?.(name)
  } catch {
    // no user timing: no mark
  }
}

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
    // E2 (wave E, the D5 note): the room's pong is taken as it ARRIVES, not when the in-order chain reaches it.
    // Behind a slow frame (a large snapshot's decode, a busy page) the pong waited in the chain, the next
    // beat found the ping "unanswered" and tore down a healthy socket. Only a short frame is looked at (a
    // pong is ~15 bytes); it is still validated and delivered in order below.
    if (gen === generation && typeof data === 'string' && data.length <= PONG_MAX && isPong(data))
      awaitingPong = false
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
        // only the room's answer to this socket's ping proves the upstream path (other frames do not): taken
        // at receipt (onFrame above), not here
        // the close that follows is terminal with this reason, whatever its frame says (SMK-2)
        if (r.data.type === 'notice' && r.data.code === 'CLOSING' && gen === generation)
          announced = r.data.detail || 'UNKNOWN_ERROR'
        // N1-1: a reset welcome's snapshot frame follows: the decoder's worker starts while it downloads
        if (r.data.type === 'welcome' && r.data.reset) opts.decoder?.warm()
        opts.onRaw?.(r.data)
        deliver(r.data)
        return
      }
      const bytes = await bytesOf(data)
      if (!bytes) return
      try {
        // wave N (the N1 specs): the decode's window on the page's timeline
        mark('lobby.snapshot.received')
        const frame = await (opts.decoder ? opts.decoder.decode(bytes) : decodeSnapshotFrame(bytes))
        mark('lobby.snapshot.decoded')
        if (gen !== generation) return
        opts.onRaw?.(frame)
        deliver(frame)
      } catch (err) {
        if (err instanceof SnapshotDecodeLost && gen === generation && !stopped) {
          // the worker died with the frame (its bytes went with it): this socket goes, and the reconnect's welcome
          // brings the snapshot again (decoded on the main thread from then on)
          opts.log?.('snapshot_decode_lost', {})
          dropSocket(DECODE_LOST_CLOSE)
          return
        }
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
  /** Drops the current socket now (reported closed with `close`, then a reconnect), as the heartbeat's drop does. */
  const dropSocket = (close: TransportClose) => {
    const sock = ws
    generation++
    ws = null
    stopBeat()
    try {
      sock?.close(close.code, close.reason)
    } catch {
      // closing a dead socket may throw: it is gone either way
    }
    setState('closed', close)
    scheduleReconnect()
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
        // Reported and reconnected now, not behind the frame chain (E2, the D5 note): a frame still being
        // processed there (a snapshot's decode) belongs to the dead socket and is dropped when it finishes
        // (its generation is gone), so nothing of this socket can be delivered after this close; waiting for
        // it only held the reconnect, behind a decode that may be what made the page miss the pong.
        // A socket the room said it was closing and that never closed: terminal all the same.
        const close = closeOf(HEARTBEAT_CLOSE.code, HEARTBEAT_CLOSE.reason)
        setState('closed', close)
        if (close.code !== CLOSE_TERMINAL) scheduleReconnect()
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
    // a new socket's frames start a chain of their own: whatever the previous socket's chain still holds (a
    // decode a heartbeat drop left running) is dropped when it finishes, and the new welcome never waits for
    // it. A previous socket's close was reported before this reconnect was scheduled.
    chain = Promise.resolve()
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
        scheduleReconnect(isRestartClose(close))
      })
    }
  }

  const scheduleReconnect = (restart = false) => {
    if (stopped || timer !== null) return
    let unsent = false
    if (restart)
      try {
        unsent = opts.hasUnsent?.() === true
      } catch {
        unsent = false
      }
    const ms = restart
      ? restartSpreadMs(unsent, opts.random)
      : jitteredDelay(backoff[Math.min(failures, backoff.length - 1)] ?? 5000, opts.random)
    if (restart) opts.log?.('socket_restart_spread', { ms, unsent })
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
