// Roster events of one room, batched per macrotask (docs/EXCALIDRAW-MIGRATION.md §2.7 "roster: join,
// leave and update events, uncapped, on change"; B9's reconnect storm): a join or leave is queued and the
// batch goes out on the next setImmediate as ONE `roster` frame with every event in order, instead of one
// broadcast per event. The hello queue welcomes several sessions per slice (element-room.ts HELLO_SLICE_MS),
// so 260 reconnects after a SIGKILL cost about 260 × (sessions back so far) socket writes for the joins
// alone (about 20,000 on a 200-session board); batched, they cost one frame per recipient per slice.
//
// Order is kept: a join and a leave of the same session stay in the order they happened, in the same
// frame or in later ones. A session whose own join is in the batch gets the frame without its own event
// (its welcome's roster already names it), serialized once for every recipient outside the batch.

import type { RosterEvent as RosterEventSchema } from '@draftroom/canvas-schema/protocol'
import type { z } from 'zod'

/** A roster event as the protocol defines it (join, leave, update). */
export type RosterEvent = z.infer<typeof RosterEventSchema>

export interface RosterRecipient {
  readonly sid: string
  send(frame: string): void
}

export class RosterBatch {
  private pending: RosterEvent[] = []
  private timer: ReturnType<typeof setImmediate> | null = null
  private readonly recipients: () => Iterable<RosterRecipient>
  private readonly schedule: (fn: () => void) => ReturnType<typeof setImmediate>
  /** frames sent (tests, metrics) */
  frames = 0

  constructor(
    recipients: () => Iterable<RosterRecipient>,
    schedule: (fn: () => void) => ReturnType<typeof setImmediate> = (fn) => setImmediate(fn),
  ) {
    this.recipients = recipients
    this.schedule = schedule
  }

  push(ev: RosterEvent): void {
    this.pending.push(ev)
    if (!this.timer) this.timer = this.schedule(() => this.flush())
  }

  /** Sends what is queued now (the scheduled flush, or a caller that needs the order kept before its own frame). */
  flush(): void {
    this.timer = null
    if (!this.pending.length) return
    const events = this.pending
    this.pending = []
    const joined = new Set<string>()
    for (const e of events) if (e.k === 'join') joined.add(e.p.sid)
    const shared = JSON.stringify({ type: 'roster', events })
    for (const r of this.recipients()) {
      if (!joined.has(r.sid)) {
        r.send(shared)
        this.frames++
        continue
      }
      const own = events.filter((e) => !(e.k === 'join' && e.p.sid === r.sid))
      if (!own.length) continue
      r.send(JSON.stringify({ type: 'roster', events: own }))
      this.frames++
    }
  }

  close(): void {
    if (this.timer) clearImmediate(this.timer)
    this.timer = null
    this.pending = []
  }

  get queued(): number {
    return this.pending.length
  }
}
