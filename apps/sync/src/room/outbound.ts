// One ordered outbound queue per session (docs/EXCALIDRAW-MIGRATION.md §2.4.5 "Outbound"):
//  - frames leave in the order they were queued; an entry may be a promise (the gzip snapshot compressed
//    off the event loop, or a welcome that names its size), and later frames wait behind it, so the
//    prefix invariant (§2.4.3) holds by construction;
//  - above 256 KiB of `bufferedAmount` a session gets no cursor (presence) frames;
//  - above 8 MiB queued (socket buffer plus this queue) it is closed with 4000 RECONNECT and resyncs;
//  - the service enforces a global budget of 64 MiB across sessions (index.ts), closing the largest
//    buffer first.

import { CLOSE_RECONNECT } from '@draftroom/canvas-schema/protocol'
import type { ElementSocket } from '../engine-switch.ts'

export const OUTBOUND = {
  skipPresenceAbove: 256 * 1024,
  closeAbove: 8 * 1024 * 1024,
  globalBudget: 64 * 1024 * 1024,
} as const

type Frame = string | Uint8Array
type Entry = Frame | Promise<Frame | null>

const sizeOf = (f: Frame) => (typeof f === 'string' ? f.length : f.byteLength)

export class Outbound {
  private readonly queue: Entry[] = []
  private queuedBytes = 0
  private flushing = false
  closed = false
  /** bytes handed to the socket (metrics) */
  sentBytes = 0

  private readonly socket: ElementSocket
  private readonly onOverflow: () => void
  private readonly onSent: (bytes: number) => void
  constructor(socket: ElementSocket, onOverflow: () => void, onSent: (bytes: number) => void = () => {}) {
    this.socket = socket
    this.onOverflow = onOverflow
    this.onSent = onSent
  }

  /** Bytes waiting: the socket's buffer plus this queue. */
  get pending(): number {
    return (this.socket.bufferedAmount ?? 0) + this.queuedBytes
  }

  /** Whether cursor frames should be skipped (backpressure). */
  get congested(): boolean {
    return this.pending > OUTBOUND.skipPresenceAbove
  }

  send(entry: Entry): void {
    if (this.closed) return
    if (typeof entry === 'string' || entry instanceof Uint8Array) this.queuedBytes += sizeOf(entry)
    this.queue.push(entry)
    this.flush()
  }

  private flush(): void {
    if (this.flushing || this.closed) return
    while (this.queue.length) {
      const head = this.queue[0] as Entry
      if (head instanceof Promise) {
        this.flushing = true
        head.then(
          (f) => {
            this.flushing = false
            this.queue[0] = f ?? ''
            if (f) this.queuedBytes += sizeOf(f)
            this.flush()
          },
          () => {
            this.flushing = false
            this.queue.shift()
            this.flush()
          },
        )
        return
      }
      this.queue.shift()
      const n = sizeOf(head)
      this.queuedBytes -= n
      if (n === 0) continue
      if (this.socket.readyState !== 1) continue
      try {
        this.socket.send(head)
        this.sentBytes += n
        this.onSent(n)
      } catch {
        // a socket that failed mid-send is closing; its close handler cleans up
      }
    }
    if (this.pending > OUTBOUND.closeAbove) this.overflow()
  }

  /** Closes the session for backpressure (4000 RECONNECT: the client resyncs). */
  overflow(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.queuedBytes = 0
    try {
      this.socket.close(CLOSE_RECONNECT, 'RECONNECT')
    } catch {
      // already closed
    }
    this.onOverflow()
  }

  close(): void {
    this.closed = true
    this.queue.length = 0
    this.queuedBytes = 0
  }
}
