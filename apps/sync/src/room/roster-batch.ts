// Roster events of one room, batched (docs/EXCALIDRAW-MIGRATION.md §2.7 "roster: join, leave and update
// events, uncapped, on change"; B9's reconnect storm): a join or leave is queued and the batch goes out as ONE
// `roster` frame with every event in order, instead of one broadcast per event, at most ROSTER_FLUSH_MS
// later (the room's presence tick flushes it first, element-room.ts presenceTick, so a peer's join reaches
// everyone before its first cursor does). 260 reconnects after a SIGKILL cost about 260 × (sessions back so
// far) socket writes for the joins alone (about 20,000 on a 200-session board). Batched per macrotask (wave
// C), they cost one frame per recipient per hello slice, which helps only while the joins arrive together:
// CAP-L1 (wave J) found a restart whose reconnects came back spread over seconds (the clients' backoff) paying
// one flush per join, 320 ms of socket writes in its first seconds on the workstation. Batched per 100 ms,
// a storm costs at most ten frames per recipient a second, however its joins are spread; a join is seen by the
// others at most 100 ms later.
//
// Order is kept: a join and a leave of the same session stay in the order they happened, in the same
// frame or in later ones. A session whose own join is in the batch gets the frame without its own event
// (its welcome's roster already names it), serialized once for every recipient outside the batch.

import type { RosterEvent as RosterEventSchema } from '@draftroom/canvas-schema/protocol'
import type { z } from 'zod'
import { frameOf, type RoomFrame } from './reader-frames.ts'

/** A roster event as the protocol defines it (join, leave, update). */
export type RosterEvent = z.infer<typeof RosterEventSchema>

export interface RosterRecipient {
  readonly sid: string
  /** the session's send point (element-room.ts Session.send: in its revision's form) */
  send(frame: RoomFrame): void
}

/** The longest a roster event waits for its frame (CAP-L1; the presence tick's period, 100 ms). */
export const ROSTER_FLUSH_MS = 100

const laterFlush = (fn: () => void): unknown => {
  const t = setTimeout(fn, ROSTER_FLUSH_MS)
  t.unref?.()
  return t
}

export class RosterBatch {
  private pending: RosterEvent[] = []
  private timer: unknown = null
  private readonly recipients: () => Iterable<RosterRecipient>
  private readonly schedule: (fn: () => void) => unknown
  private readonly cancel: (handle: unknown) => void
  /** frames sent (tests, metrics) */
  frames = 0

  constructor(
    recipients: () => Iterable<RosterRecipient>,
    schedule: (fn: () => void) => unknown = laterFlush,
    cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {
    this.recipients = recipients
    this.schedule = schedule
    this.cancel = cancel
  }

  push(ev: RosterEvent): void {
    this.pending.push(ev)
    if (!this.timer) this.timer = this.schedule(() => this.flush())
  }

  /** Sends what is queued now (the scheduled flush, or a caller that needs the order kept before its own frame). */
  flush(): void {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
    if (!this.pending.length) return
    const events = this.pending
    this.pending = []
    const joined = new Set<string>()
    for (const e of events) if (e.k === 'join') joined.add(e.p.sid)
    const shared = frameOf({ type: 'roster', events })
    for (const r of this.recipients()) {
      if (!joined.has(r.sid)) {
        r.send(shared)
        this.frames++
        continue
      }
      const own = events.filter((e) => !(e.k === 'join' && e.p.sid === r.sid))
      if (!own.length) continue
      r.send(frameOf({ type: 'roster', events: own }))
      this.frames++
    }
  }

  close(): void {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
    this.pending = []
  }

  get queued(): number {
    return this.pending.length
  }
}
