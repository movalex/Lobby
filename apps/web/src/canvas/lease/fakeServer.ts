// A local stand-in for the sync server's lease table (spike A only; spike B has the real ElementRoom).
// It speaks the plan's message shapes (./protocol.ts), validates what the client sends with the same
// strict schema a server would use, and answers in request order (the per-session FIFO, §2.4.3).
//
//  - `delayMs`: answer each acquire after this many milliseconds, or 'manual' to hold every answer
//    until the test calls `flush()` (so a test can look at the page "before the grant").
//  - `holdByOther(id, holder)`: the id is leased by someone else; an acquire for it is denied.
//  - Everything else is granted (an id this fake has never seen counts as free, which also covers the
//    "New element" rule of §2.9.2).

import {
  LEASE_TTL_MS,
  type LeaseClientMessage,
  type LeaseHolder,
  type LeaseServerMessage,
  leaseClientMessage,
} from './protocol.ts'

export interface LeaseTransport {
  send(message: LeaseClientMessage): void
}

export interface LeaseLogEntry {
  dir: 'up' | 'down'
  at: number
  message: LeaseClientMessage | LeaseServerMessage
}

export interface FakeLeaseServerOptions {
  /** This session (the one the client speaks for). */
  me: LeaseHolder
  delayMs?: number | 'manual'
  now?: () => number
  /** Timer hooks (tests pass fake timers; the browser uses window.setTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown
}

export class FakeLeaseServer {
  readonly me: LeaseHolder
  delayMs: number | 'manual'
  /** Every message in both directions, in order. */
  readonly log: LeaseLogEntry[] = []
  private readonly held = new Map<string, LeaseHolder>()
  private readonly others = new Map<string, LeaseHolder>()
  private readonly queue: (() => void)[] = []
  private deliver: (message: LeaseServerMessage) => void = () => {}
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  /** When the last scheduled answer is due (timer mode), to keep FIFO order across delays. */
  private lastDue = 0

  constructor(opts: FakeLeaseServerOptions) {
    this.me = opts.me
    this.delayMs = opts.delayMs ?? 0
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** Connects the client side: returns its transport; `onMessage` receives the server's messages. */
  connect(onMessage: (message: LeaseServerMessage) => void): LeaseTransport {
    this.deliver = onMessage
    return { send: (message) => this.receive(message) }
  }

  holdByOther(id: string, holder: LeaseHolder): void {
    this.others.set(id, holder)
    this.held.set(id, holder)
    this.emit({ type: 'lease', id, holder })
  }

  clearOther(id: string): void {
    if (!this.others.delete(id)) return
    this.held.delete(id)
    this.emit({ type: 'lease', id, holder: null })
  }

  /** Who holds `id` now (null: free). */
  holderOf(id: string): LeaseHolder | null {
    return this.held.get(id) ?? null
  }

  /** 'manual' mode: answers still held back. */
  pendingCount(): number {
    return this.queue.length
  }

  /** 'manual' mode: delivers the next `n` held answers (all by default), in request order. */
  flush(n = Number.POSITIVE_INFINITY): number {
    let done = 0
    while (done < n && this.queue.length > 0) {
      this.queue.shift()?.()
      done++
    }
    return done
  }

  private receive(raw: LeaseClientMessage): void {
    const message = leaseClientMessage.parse(raw) // a malformed frame throws, as a server would refuse it
    this.log.push({ dir: 'up', at: this.now(), message })
    if (message.type === 'lease.release') {
      // A release takes effect in order behind earlier requests (same queue, §2.4.3 stage 1).
      this.schedule(() => {
        const current = this.held.get(message.id)
        if (current && current.sid === this.me.sid) {
          this.held.delete(message.id)
          this.emit({ type: 'lease', id: message.id, holder: null })
        }
      })
      return
    }
    this.schedule(() => {
      const current = this.held.get(message.id)
      if (current && current.sid !== this.me.sid) {
        this.emit({ type: 'lease.deny', req: message.req, id: message.id, holder: current })
        return
      }
      const wasHeld = current?.sid === this.me.sid
      this.held.set(message.id, this.me)
      this.emit({ type: 'lease.grant', req: message.req, id: message.id, ttlMs: LEASE_TTL_MS })
      if (!wasHeld) this.emit({ type: 'lease', id: message.id, holder: this.me })
    })
  }

  private schedule(answer: () => void): void {
    if (this.delayMs === 'manual') {
      this.queue.push(answer)
      return
    }
    // FIFO even if the delay changes between requests: an answer is never due before the previous one.
    const now = this.now()
    const due = Math.max(this.lastDue, now + this.delayMs)
    this.lastDue = due
    this.setTimer(answer, due - now)
  }

  private emit(message: LeaseServerMessage): void {
    this.log.push({ dir: 'down', at: this.now(), message })
    this.deliver(message)
  }
}
