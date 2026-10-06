// A concurrency gate with a BOUNDED queue (J4, LP-DNS-1): at most `concurrent` holders at once, at most
// `maxQueue` callers waiting for a place, and nobody waits longer than `maxWaitMs`. A caller that finds
// the queue full, or waits too long, is refused with a GateFull (the route answers 503 with a plain
// message), instead of a promise that stays pending behind slow work for as long as it takes. The place a
// finished holder frees goes straight to the first waiter (no moment in which a newcomer can take it).
//
// Used for the link previews' shared fetch slots (index.ts) and for the v1 conversion workers (the history
// feature's convert-v1.ts).

export type GateRefusal = 'full' | 'wait-timeout'

export class GateFull extends Error {
  readonly refusal: GateRefusal
  constructor(refusal: GateRefusal) {
    super(refusal === 'full' ? 'the queue is full' : 'waited too long for a place')
    this.name = 'GateFull'
    this.refusal = refusal
  }
}

export interface GateOptions {
  readonly concurrent: number
  /** callers that may wait for a place (0: a caller that finds every place taken is refused at once) */
  readonly maxQueue: number
  /** the longest a caller waits for a place; omitted: no limit besides the queue's size */
  readonly maxWaitMs?: number
}

interface Waiter {
  grant(release: () => void): void
  timer: ReturnType<typeof setTimeout> | null
}

export class Gate {
  private readonly opts: GateOptions
  private active = 0
  private readonly queue: Waiter[] = []

  constructor(opts: GateOptions) {
    if (!(opts.concurrent >= 1)) throw new Error('a gate holds at least one caller')
    this.opts = opts
  }

  /** Holders now. */
  get running(): number {
    return this.active
  }

  /** Callers waiting for a place now. */
  get waiting(): number {
    return this.queue.length
  }

  /** Resolves with the function that gives the place back (call it once, in a `finally`). Rejects GateFull. */
  acquire(): Promise<() => void> {
    if (this.active < this.opts.concurrent) {
      this.active++
      return Promise.resolve(this.releaser())
    }
    if (this.queue.length >= this.opts.maxQueue) return Promise.reject(new GateFull('full'))
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { grant: resolve, timer: null }
      if (this.opts.maxWaitMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const at = this.queue.indexOf(waiter)
          if (at === -1) return
          this.queue.splice(at, 1)
          reject(new GateFull('wait-timeout'))
        }, this.opts.maxWaitMs)
        waiter.timer.unref?.()
      }
      this.queue.push(waiter)
    })
  }

  /** Runs `fn` in a place of the gate. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private releaser(): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = this.queue.shift()
      if (!next) {
        this.active--
        return
      }
      // the place passes to the first waiter: `active` stays as it is
      if (next.timer) clearTimeout(next.timer)
      next.grant(this.releaser())
    }
  }
}
