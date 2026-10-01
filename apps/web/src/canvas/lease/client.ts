// The client side of the text lease (docs/EXCALIDRAW-MIGRATION.md §2.9.2). Transport-agnostic: the spike
// connects it to ./fakeServer.ts; spike B connects it to the real socket. A lease is held per session
// (tab). One live acquire per id at a time: a second request for an id already pending shares its answer.
//
// Corrected after the second verifier:
//  - A re-acquire after a cancel is a NEW request (new req id, new promise). It used to reuse the
//    cancelled entry, whose promise cancel() had already resolved, so the new session never got an answer
//    and Lobby stayed 'pending' with the lease held and no editor. The cancelled request's answer is then
//    stale: ignored while a newer request for the id is out (the server answers in order, so the newer
//    answer follows and decides), released at once when none is.
//  - "Created here" is one-shot: `markCreated` records an element this session just created, and the
//    FIRST open takes it (`takeCreated`). It is refused when another session is known to hold the lease
//    (open item 7: the New element rule never overrides a live lease), it expires, and it never skips the
//    acquire (EditorLease still sends one in parallel).
//  - A lease lost to another session (a holder broadcast naming someone else, or clearing it while this
//    session held it) emits 'lost', so the open editor can go read-only at once (§2.9.3).

import type { LeaseTransport } from '../sync/types.ts'
import {
  type LeaseClientMessage,
  type LeaseHolder,
  type LeaseServerMessage,
  leaseServerMessage,
} from './protocol.ts'

export type LeaseOutcome =
  | { granted: true; id: string; ttlMs: number }
  | { granted: false; id: string; holder: LeaseHolder }
  /** The user cancelled (Escape) before the answer; a late grant is released at once. */
  | { granted: false; id: string; cancelled: true }

interface Pending {
  req: number
  promise: Promise<LeaseOutcome>
  resolve: (outcome: LeaseOutcome) => void
  cancelled: boolean
}

export type LeaseEvent =
  | { kind: 'acquire'; id: string; req: number }
  | { kind: 'grant'; id: string; req: number }
  | { kind: 'deny'; id: string; req: number; holder: LeaseHolder }
  | { kind: 'release'; id: string }
  | { kind: 'holder'; id: string; holder: LeaseHolder | null }
  /** This session held `id` and the server now names someone else (or nobody): §2.9.3. */
  | { kind: 'lost'; id: string; holder: LeaseHolder | null }
  /** An answer for a request that is no longer live (cancelled, or superseded by a newer one). */
  | { kind: 'stale'; id: string; req: number; answer: 'grant' | 'deny'; action: 'ignored' | 'released' }

/** How long "created here" lasts without an open (ms): the New element rule is for a JUST-created element. */
export const CREATED_HERE_TTL_MS = 5_000

export class LeaseClient {
  private readonly transport: LeaseTransport
  private nextReq = 1
  private readonly pending = new Map<string, Pending>()
  /** Every request not answered yet, live or cancelled: req -> id. */
  private readonly byReq = new Map<number, string>()
  private readonly held = new Set<string>()
  private readonly holders = new Map<string, LeaseHolder>()
  /** Elements this session just created and has not opened yet: id -> when. */
  private readonly createdHere = new Map<string, number>()
  private readonly listeners = new Set<(event: LeaseEvent) => void>()
  private readonly now: () => number

  readonly me: LeaseHolder

  constructor(
    connect: (onMessage: (message: LeaseServerMessage) => void) => LeaseTransport,
    me: LeaseHolder,
    opts: { now?: () => number } = {},
  ) {
    this.me = me
    this.now = opts.now ?? (() => Date.now())
    this.transport = connect((message) => this.receive(message))
  }

  /**
   * Asks for the lease on `id`. Already held: resolves granted at once, with no message. A live request
   * for `id` shares its answer; a cancelled one is replaced by a new request (fresh req id and promise).
   */
  acquire(id: string): Promise<LeaseOutcome> {
    if (this.held.has(id)) return Promise.resolve({ granted: true, id, ttlMs: 0 })
    const existing = this.pending.get(id)
    if (existing && !existing.cancelled) return existing.promise
    const req = this.nextReq++
    let resolve: (outcome: LeaseOutcome) => void = () => {}
    const promise = new Promise<LeaseOutcome>((r) => {
      resolve = r
    })
    this.pending.set(id, { req, promise, resolve, cancelled: false })
    this.byReq.set(req, id)
    this.emit({ kind: 'acquire', id, req })
    this.send({ type: 'lease.acquire', req, id })
    return promise
  }

  /** Escape while pending: the promise resolves `cancelled`; a grant that still arrives is released. */
  cancel(id: string): void {
    const p = this.pending.get(id)
    if (!p || p.cancelled) return
    p.cancelled = true
    p.resolve({ granted: false, id, cancelled: true })
  }

  /** Gives the lease back (the editor closed). A pending request is cancelled instead. */
  release(id: string): void {
    if (this.pending.has(id)) {
      this.cancel(id)
      return
    }
    if (!this.held.delete(id)) return // not held (never granted, or lost): nothing to give back
    this.emit({ kind: 'release', id })
    this.send({ type: 'lease.release', id })
  }

  isHeld(id: string): boolean {
    return this.held.has(id)
  }

  /** A live (not cancelled) request for `id` is out. */
  isPending(id: string): boolean {
    const p = this.pending.get(id)
    return !!p && !p.cancelled
  }

  /** The ids with a live request out (the monitor's "exactly one live request" invariant). */
  livePending(): string[] {
    return [...this.pending].filter(([, p]) => !p.cancelled).map(([id]) => id)
  }

  /** The holder from the server's broadcasts (null: nobody, as far as this client knows). */
  holderOf(id: string): LeaseHolder | null {
    return this.holders.get(id) ?? null
  }

  /** Another session holds `id`, as far as this client knows. */
  heldByOther(id: string): LeaseHolder | null {
    const h = this.holders.get(id)
    return h && h.sid !== this.me.sid ? h : null
  }

  /** "New element" rule (§2.9.2): an element this session just created. One-shot; see `takeCreated`. */
  markCreated(id: string): void {
    this.createdHere.set(id, this.now())
  }

  /** Created here, not opened yet, not expired, and not known to be held by another session. */
  isCreatedHere(id: string): boolean {
    const at = this.createdHere.get(id)
    if (at === undefined) return false
    if (this.now() - at > CREATED_HERE_TTL_MS || this.heldByOther(id)) {
      this.createdHere.delete(id)
      return false
    }
    return true
  }

  /** The first open of a just-created element takes the flag: true once, then never again. */
  takeCreated(id: string): boolean {
    const fresh = this.isCreatedHere(id)
    this.createdHere.delete(id)
    return fresh
  }

  /** Any open of `id` ends its "created here" (the rule covers the first open only). */
  forgetCreated(id: string): void {
    this.createdHere.delete(id)
  }

  on(listener: (event: LeaseEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private send(message: LeaseClientMessage): void {
    this.transport.send(message)
  }

  private receive(raw: LeaseServerMessage): void {
    const message = leaseServerMessage.parse(raw)
    if (message.type === 'lease') {
      if (message.holder) this.holders.set(message.id, message.holder)
      else this.holders.delete(message.id)
      const mine = message.holder?.sid === this.me.sid
      const lost = !mine && this.held.delete(message.id)
      this.emit({ kind: 'holder', id: message.id, holder: message.holder })
      if (lost) this.emit({ kind: 'lost', id: message.id, holder: message.holder })
      return
    }
    const id = this.byReq.get(message.req)
    this.byReq.delete(message.req)
    if (id === undefined || id !== message.id) return // not ours
    const p = this.pending.get(id)
    const answer = message.type === 'lease.grant' ? 'grant' : 'deny'
    if (!p || p.req !== message.req) {
      // A cancelled request superseded by a newer one for the same id. The server answers in request
      // order, so the newer answer is still to come and decides; releasing now would drop the lease the
      // newer request is about to be granted.
      this.emit({ kind: 'stale', id, req: message.req, answer, action: 'ignored' })
      return
    }
    this.pending.delete(id)
    if (message.type === 'lease.grant') {
      this.held.add(id)
      this.emit({ kind: 'grant', id, req: message.req })
      if (p.cancelled) {
        this.emit({ kind: 'stale', id, req: message.req, answer, action: 'released' })
        this.release(id) // Escape came first: give it straight back
        return
      }
      p.resolve({ granted: true, id, ttlMs: message.ttlMs })
      return
    }
    this.emit({ kind: 'deny', id, req: message.req, holder: message.holder })
    if (!p.cancelled) p.resolve({ granted: false, id, holder: message.holder })
  }

  private emit(event: LeaseEvent): void {
    for (const l of this.listeners) l(event)
  }
}
