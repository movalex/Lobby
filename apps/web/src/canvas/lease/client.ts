// The client side of the text lease (docs/EXCALIDRAW-MIGRATION.md §2.9.2). Transport-agnostic: the spike
// connects it to ./fakeServer.ts; spike B connects it to the real socket. A lease is held per session
// (tab). One acquire per id at a time: a second request for an id already pending shares its answer.

import type { LeaseTransport } from './fakeServer.ts'
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

export class LeaseClient {
  private readonly transport: LeaseTransport
  private nextReq = 1
  private readonly pending = new Map<string, Pending>()
  private readonly byReq = new Map<number, string>()
  private readonly held = new Set<string>()
  private readonly holders = new Map<string, LeaseHolder>()
  private readonly createdHere = new Set<string>()
  private readonly listeners = new Set<(event: LeaseEvent) => void>()

  readonly me: LeaseHolder

  constructor(
    connect: (onMessage: (message: LeaseServerMessage) => void) => LeaseTransport,
    me: LeaseHolder,
  ) {
    this.me = me
    this.transport = connect((message) => this.receive(message))
  }

  /** Asks for the lease on `id`. Already held: resolves granted at once, with no message. */
  acquire(id: string): Promise<LeaseOutcome> {
    if (this.held.has(id)) return Promise.resolve({ granted: true, id, ttlMs: 0 })
    const existing = this.pending.get(id)
    if (existing) {
      existing.cancelled = false
      return existing.promise
    }
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
    if (!this.held.delete(id)) return
    this.emit({ kind: 'release', id })
    this.send({ type: 'lease.release', id })
  }

  isHeld(id: string): boolean {
    return this.held.has(id)
  }

  isPending(id: string): boolean {
    const p = this.pending.get(id)
    return !!p && !p.cancelled
  }

  /** The holder from the server's broadcasts (null: nobody, as far as this client knows). */
  holderOf(id: string): LeaseHolder | null {
    return this.holders.get(id) ?? null
  }

  /** "New element" rule (§2.9.2): an element this session just created; its grant is certain. */
  markCreated(id: string): void {
    this.createdHere.add(id)
  }

  isCreatedHere(id: string): boolean {
    return this.createdHere.has(id)
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
      if (message.holder && message.holder.sid !== this.me.sid) this.held.delete(message.id)
      this.emit({ kind: 'holder', id: message.id, holder: message.holder })
      return
    }
    const id = this.byReq.get(message.req)
    this.byReq.delete(message.req)
    if (id === undefined || id !== message.id) return // not ours, or stale
    const p = this.pending.get(id)
    if (!p || p.req !== message.req) return
    this.pending.delete(id)
    if (message.type === 'lease.grant') {
      this.held.add(id)
      this.emit({ kind: 'grant', id, req: message.req })
      if (p.cancelled) {
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
