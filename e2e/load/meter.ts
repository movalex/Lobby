// Byte and message accounting for one load session (docs/EXCALIDRAW-MIGRATION.md §8.3 B9 "Network":
// bytes out in total, per session, split into presence (cursors) / drag relay (id lists and deltas
// separately) / changes / welcome; welcome bytes and the tombstones' share).
//
// `meteredWebSocket(meter)` is a WebSocket class for the headless client's `WebSocketImpl` option: it is
// Node 24's own WebSocket, with a listener that counts every frame before the client sees it, and a
// `send` that counts every frame the client sends. Server bytes OUT are measured here as bytes IN at the
// clients (sync's own byte counters come from /internal/metrics).
import { Recorder } from './stats.ts'

export interface ChannelBytes {
  bytes: number
  frames: number
}

export interface MeterSnapshot {
  readonly in: Readonly<Record<string, ChannelBytes>>
  readonly out: Readonly<Record<string, ChannelBytes>>
  /** presence frames' `drags` entries split: first frames with ids, and delta-only frames */
  readonly dragIdsBytes: number
  readonly dragDeltaBytes: number
  readonly dragStartsSeen: number
  /** peers' cursor entries in presence frames (the rest of a presence frame's bytes) */
  readonly cursorBytes: number
  /** the binary snapshot frame(s) after a reset welcome */
  readonly snapshotBytes: number
}

export type ChangesListener = (ops: readonly { id: string; v: number }[], at: number) => void

/**
 * The presence probe (session.ts): one session per measured board moves its cursor inside a region no
 * other cursor enters (so the 40-cursor cap, which prefers peers inside the recipient's view, keeps it
 * for the measuring sessions, whose view is that region), with its send time mod 1,000,000 ms in the
 * position: x = origin + t mod 1000, y = origin + floor(t / 1000) mod 1000.
 */
export const PROBE_ORIGIN = 50_000
export const PROBE_VIEW = { x: PROBE_ORIGIN, y: PROBE_ORIGIN, w: 1_000, h: 1_000 } as const
export function probePointer(t: number): { x: number; y: number } {
  return { x: PROBE_ORIGIN + (t % 1_000), y: PROBE_ORIGIN + (Math.floor(t / 1_000) % 1_000) }
}
export function probeSentAt(p: { x: number; y: number }): number {
  return (Math.round(p.y) - PROBE_ORIGIN) * 1_000 + (Math.round(p.x) - PROBE_ORIGIN)
}

export class Meter {
  readonly in = new Map<string, ChannelBytes>()
  readonly out = new Map<string, ChannelBytes>()
  dragIdsBytes = 0
  dragDeltaBytes = 0
  dragStartsSeen = 0
  cursorBytes = 0
  snapshotBytes = 0
  /** the size of every welcome's snapshot frame and JSON, per join */
  readonly welcomes: { at: number; jsonBytes: number; snapshotBytes: number }[] = []
  /** every close of the session's socket (the sync kill, backpressure closes) */
  readonly closes: { at: number; code: number }[] = []
  /** parses presence frames for the drag split (costly: sample sessions only) */
  parsePresence: boolean
  /** parses `changes` frames and tells this listener which (id, v) arrived (visibility) */
  onChanges: ChangesListener | null = null
  readonly presenceGap = new Recorder(5_000)
  /** the probe's session id on this board (its cursor carries its send time) */
  probeSid: string | null = null
  /** presence delay of the probe's cursor (send → this socket), ms; only when `parsePresence` */
  readonly presenceDelay = new Recorder(20_000)
  private lastPresenceAt = 0

  constructor(opts: { parsePresence?: boolean } = {}) {
    this.parsePresence = opts.parsePresence ?? false
  }

  private add(map: Map<string, ChannelBytes>, key: string, bytes: number) {
    const c = map.get(key) ?? { bytes: 0, frames: 0 }
    c.bytes += bytes
    c.frames++
    map.set(key, c)
  }

  received(data: unknown, at = Date.now()): void {
    if (typeof data !== 'string') {
      const bytes =
        data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : 0
      this.add(this.in, 'snapshot', bytes)
      this.snapshotBytes += bytes
      const w = this.welcomes.at(-1)
      if (w && w.snapshotBytes === 0) w.snapshotBytes = bytes
      return
    }
    const bytes = Buffer.byteLength(data)
    const type = messageType(data)
    this.add(this.in, type, bytes)
    if (type === 'welcome') this.welcomes.push({ at, jsonBytes: bytes, snapshotBytes: 0 })
    else if (type === 'presence') {
      if (this.lastPresenceAt) this.presenceGap.add(at - this.lastPresenceAt)
      this.lastPresenceAt = at
      if (this.parsePresence) this.splitPresence(data, at)
    } else if (type === 'changes' && this.onChanges) {
      try {
        const msg = JSON.parse(data) as {
          ops: { k: string; id?: string; v?: number; el?: { id: string; version: number } }[]
        }
        this.onChanges(
          msg.ops.map((op) =>
            op.k === 'c'
              ? { id: op.el?.id ?? '', v: op.el?.version ?? 0 }
              : { id: op.id ?? '', v: op.v ?? 0 },
          ),
          at,
        )
      } catch {
        // counted above; a frame that does not parse is the client's problem, not the meter's
      }
    }
  }

  private splitPresence(data: string, at: number): void {
    try {
      const msg = JSON.parse(data) as {
        peers?: { sid?: string; pointer?: { x: number; y: number } | null }[]
        drags?: { ids?: unknown[] }[]
      }
      for (const d of msg.drags ?? []) {
        const b = Buffer.byteLength(JSON.stringify(d))
        if (d.ids) {
          this.dragIdsBytes += b
          this.dragStartsSeen++
        } else this.dragDeltaBytes += b
      }
      for (const p of msg.peers ?? []) {
        this.cursorBytes += Buffer.byteLength(JSON.stringify(p))
        if (p.pointer && this.probeSid !== null && p.sid === this.probeSid)
          this.presenceDelay.add(
            ((((at % 1_000_000) - probeSentAt(p.pointer)) % 1_000_000) + 1_000_000) % 1_000_000,
          )
      }
    } catch {
      // ignore
    }
  }

  closed(code: number, at = Date.now()): void {
    this.closes.push({ at, code })
  }

  sent(data: unknown): void {
    const bytes =
      typeof data === 'string' ? Buffer.byteLength(data) : ArrayBuffer.isView(data) ? data.byteLength : 0
    this.add(this.out, typeof data === 'string' ? messageType(data) : 'binary', bytes)
  }

  snapshot(): MeterSnapshot {
    return {
      in: Object.fromEntries(this.in),
      out: Object.fromEntries(this.out),
      dragIdsBytes: this.dragIdsBytes,
      dragDeltaBytes: this.dragDeltaBytes,
      dragStartsSeen: this.dragStartsSeen,
      cursorBytes: this.cursorBytes,
      snapshotBytes: this.snapshotBytes,
    }
  }
}

/** The `type` of a JSON message, read from its first bytes without parsing it. */
export function messageType(text: string): string {
  const m = /"type"\s*:\s*"([a-z.]{1,32})"/.exec(text.slice(0, 120))
  return m?.[1] ?? 'unknown'
}

type WsCtor = new (url: string | URL, protocols?: string | string[]) => WebSocket

/** A WebSocket class that feeds `meter` (Node 24's global WebSocket underneath). */
export function meteredWebSocket(
  meter: Meter,
  Base: WsCtor = globalThis.WebSocket,
): new (
  url: string,
) => WebSocket {
  return class MeteredWebSocket extends Base {
    constructor(url: string) {
      super(url)
      this.addEventListener('message', (e: MessageEvent) => meter.received(e.data))
      this.addEventListener('close', (e: CloseEvent) => meter.closed(e.code))
    }
    override send(data: Parameters<WebSocket['send']>[0]): void {
      meter.sent(data)
      super.send(data)
    }
  }
}
