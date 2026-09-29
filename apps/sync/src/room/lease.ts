// The text lease table of one room (docs/EXCALIDRAW-MIGRATION.md §2.9.2): held per SESSION (tab), shown
// with the user's name. Granted when the id is free, expired or already held by this session; a second tab
// of the same user is refused like anyone else. TTL from the last renewal: `lease.acquire`, a presence
// message with `editing: <id>`, and every push of the holder that writes the element. A lease survives a
// socket drop until its TTL (a reconnecting tab has the same sid and keeps it, §2.9.3).
//
// Not durable: leases live in memory only. Acquire and release are ordered with the session's pushes by
// the stage-0 FIFO and the room queue (§2.4.3), so a release sent after the final push takes effect after
// that push commits.
//
// The test hook (§2.4.6 `lease-hook`, B3 L12): `delay` (ms) and `hold` postpone the GRANT MESSAGE of the
// next grants, not the decision: the lease is the requester's from the moment it is decided in queue
// order (so a competing acquire meanwhile is denied), and the grant reaches the requester after the delay
// or at `release`. A grant whose lease was released or taken over meanwhile is never sent.

import type { LeaseHookRequest } from '@draftroom/canvas-schema/protocol'

export interface LeaseHolderInfo {
  readonly sid: string
  readonly uid: string
  readonly name: string
}

interface Lease {
  readonly id: string
  readonly holder: LeaseHolderInfo
  expiresAt: number
  /** bumped on every grant, so a postponed grant can tell whether it is still current */
  readonly seq: number
}

export type AcquireResult =
  | { readonly granted: true; readonly seq: number; readonly fresh: boolean }
  | { readonly granted: false; readonly holder: LeaseHolderInfo }

export class LeaseTable {
  private readonly leases = new Map<string, Lease>()
  private seq = 0
  hook: LeaseHookRequest = { mode: 'off' }

  readonly ttlMs: number
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  /** The live holder of `id` at `now` (null: free or expired). */
  holderOf(id: string, now: number): LeaseHolderInfo | null {
    const l = this.leases.get(id)
    return l && l.expiresAt > now ? l.holder : null
  }

  /** Whether `sid` holds `id` now. */
  holds(id: string, sid: string, now: number): boolean {
    return this.holderOf(id, now)?.sid === sid
  }

  acquire(id: string, holder: LeaseHolderInfo, now: number): AcquireResult {
    const cur = this.holderOf(id, now)
    if (cur && cur.sid !== holder.sid) return { granted: false, holder: cur }
    if (cur) {
      const l = this.leases.get(id) as Lease
      l.expiresAt = now + this.ttlMs
      return { granted: true, seq: l.seq, fresh: false }
    }
    const lease: Lease = { id, holder, expiresAt: now + this.ttlMs, seq: ++this.seq }
    this.leases.set(id, lease)
    return { granted: true, seq: lease.seq, fresh: true }
  }

  /** Whether the grant `seq` of `id` is still the live lease of `sid`. */
  stillGranted(id: string, sid: string, seq: number, now: number): boolean {
    const l = this.leases.get(id)
    return !!l && l.seq === seq && l.holder.sid === sid && l.expiresAt > now
  }

  /** Releases `id` if `sid` holds it; true when a lease was removed. */
  release(id: string, sid: string, now: number): boolean {
    const l = this.leases.get(id)
    if (!l || l.holder.sid !== sid) return false
    this.leases.delete(id)
    return l.expiresAt > now
  }

  /** Renews `id` if `sid` holds it (presence `editing`, the holder's pushes). */
  renew(id: string, sid: string, now: number): boolean {
    const l = this.leases.get(id)
    if (!l || l.holder.sid !== sid || l.expiresAt <= now) return false
    l.expiresAt = now + this.ttlMs
    return true
  }

  /** Removes and returns the leases that expired by `now`. */
  expire(now: number): Lease[] {
    const out: Lease[] = []
    for (const l of this.leases.values()) if (l.expiresAt <= now) out.push(l)
    for (const l of out) this.leases.delete(l.id)
    return out
  }

  /** Every live lease (welcome.leases). */
  live(now: number): { id: string; holder: LeaseHolderInfo }[] {
    const out: { id: string; holder: LeaseHolderInfo }[] = []
    for (const l of this.leases.values()) if (l.expiresAt > now) out.push({ id: l.id, holder: l.holder })
    return out
  }

  get size(): number {
    return this.leases.size
  }
}
