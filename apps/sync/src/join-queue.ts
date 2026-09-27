// Join serialization (PERF-05). A TLSync `connect` message is the expensive part of joining a board:
// the room reads every record, builds the full diff for the newcomer and serializes it, all in one
// synchronous call (~20-60 ms on a few thousand records). Thirty people opening a workshop board in
// the same second used to run thirty of those back to back in one I/O callback and block the whole
// process (every room, every session) for up to 1.25 s.
//
// This queue lets at most ONE connect run per macrotask (setImmediate), so the messages of sessions
// that are already on a board (edits, presence) and of other rooms are handled between joins. A
// socket's own later messages are held behind its queued connect and delivered right after it, in
// the order they arrived: the room never sees a push before the connect it follows.

/** `{"type":"connect",…}` as the TLSync client serializes it (type is the first key). */
const CONNECT_RE = /^\s*\{\s*"type"\s*:\s*"connect"/
/** The first frame of a chunked message: "<remaining>_<payload>" with remaining > 0. */
const CHUNK_RE = /^(\d+)_/

export type Deliver = (text: string) => void

interface Held {
  messages: string[]
  deliver: Deliver
  /** The connect message is complete (all its chunks arrived) and the socket waits for its turn. */
  ready: boolean
}

export interface JoinQueueOptions {
  /** Runs `fn` in a later macrotask. Default: setImmediate (after pending I/O callbacks). */
  schedule?: (fn: () => void) => void
}

/** Whether `text` (a whole frame, or the first chunk of one) is a TLSync connect request. */
export function isConnectFrame(text: string): { connect: boolean; chunked: boolean } {
  const head = CHUNK_RE.exec(text)
  if (head) {
    const remaining = Number(head[1])
    return { connect: CONNECT_RE.test(text.slice(head[0].length)), chunked: remaining > 0 }
  }
  return { connect: CONNECT_RE.test(text), chunked: false }
}

export class JoinQueue {
  private readonly held = new Map<number, Held>()
  /** Sockets whose connect is complete, in arrival order. */
  private readonly ready: number[] = []
  private scheduled = false
  private readonly schedule: (fn: () => void) => void

  constructor(opts: JoinQueueOptions = {}) {
    this.schedule = opts.schedule ?? ((fn) => void setImmediate(fn))
  }

  /**
   * Routes one frame from socket `key`: delivered now, or held behind that socket's queued connect
   * (a connect is always queued). `deliver` is the socket's handler (captured at its first held frame).
   */
  push(key: number, text: string, deliver: Deliver): void {
    const held = this.held.get(key)
    if (held) {
      held.messages.push(text)
      // A chunked connect is ready once its last chunk ("0_…") is in. Anything else in its place is a
      // malformed stream: hand it to the room (its assembler rejects the session) instead of holding.
      if (!held.ready && (text.startsWith('0_') || !CHUNK_RE.test(text))) this.markReady(key, held)
      return
    }
    const frame = isConnectFrame(text)
    if (!frame.connect) {
      deliver(text)
      return
    }
    const entry: Held = { messages: [text], deliver, ready: false }
    this.held.set(key, entry)
    if (!frame.chunked) this.markReady(key, entry)
  }

  /** The socket closed or was replaced: forget what it still had queued. */
  drop(key: number): void {
    this.held.delete(key)
  }

  clear(): void {
    this.held.clear()
    this.ready.length = 0
  }

  /** Sockets with queued frames (tests, metrics). */
  get size(): number {
    return this.held.size
  }

  private markReady(key: number, held: Held) {
    held.ready = true
    this.ready.push(key)
    this.kick()
  }

  private kick() {
    if (this.scheduled || this.ready.length === 0) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      this.runOne()
      this.kick()
    })
  }

  /** Delivers one socket's connect and everything that queued up behind it. */
  private runOne() {
    while (this.ready.length) {
      const key = this.ready.shift() as number
      const held = this.held.get(key)
      if (!held?.ready) continue // dropped meanwhile (closed, replaced)
      this.held.delete(key) // later frames of this socket now pass straight through
      for (const m of held.messages) {
        try {
          held.deliver(m)
        } catch {
          // the handler owns its errors (the room logs and rejects the session); keep the queue going
        }
      }
      return
    }
  }
}
