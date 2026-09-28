// Text-lease messages (docs/EXCALIDRAW-MIGRATION.md §2.4.2 and §2.9.2). Spike copy: the wave-1 home of
// these types is packages/canvas-schema/src/protocol.ts, shared with apps/sync. The shapes are the plan's:
//
//   client → server   lease.acquire {req, id}          lease.release {id}
//   server → client   lease.grant {req, id, ttlMs}     lease.deny {req, id, holder}
//   server → all      lease {id, holder: {sid, uid, name} | null}
//
// `id` is the lease id: the container for a bound label, the text element itself for free text.

import { z } from 'zod'

export interface LeaseHolder {
  sid: string
  uid: string
  name: string
}

export type LeaseAcquire = { type: 'lease.acquire'; req: number; id: string }
export type LeaseRelease = { type: 'lease.release'; id: string }
export type LeaseClientMessage = LeaseAcquire | LeaseRelease

export type LeaseGrant = { type: 'lease.grant'; req: number; id: string; ttlMs: number }
export type LeaseDeny = { type: 'lease.deny'; req: number; id: string; holder: LeaseHolder }
export type LeaseBroadcast = { type: 'lease'; id: string; holder: LeaseHolder | null }
export type LeaseServerMessage = LeaseGrant | LeaseDeny | LeaseBroadcast

/** The server's TTL from the last renewal (§2.9.2: presence `editing` renews it at least every 2 s). */
export const LEASE_TTL_MS = 10_000

const id = z.string().min(1).max(256)
const req = z.number().int().nonnegative()
const holder = z.strictObject({ sid: z.string().min(1), uid: z.string().min(1), name: z.string() })

/** Strict: what a server would accept from a client (unknown keys are refused, as in §2.4.2). */
export const leaseClientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('lease.acquire'), req, id }),
  z.strictObject({ type: z.literal('lease.release'), id }),
])

/** What the client accepts from the server. */
export const leaseServerMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('lease.grant'),
    req,
    id,
    ttlMs: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal('lease.deny'), req, id, holder }),
  z.strictObject({ type: z.literal('lease'), id, holder: holder.nullable() }),
])
