// Text-lease messages (docs/EXCALIDRAW-MIGRATION.md §2.4.2 and §2.9.2). Since spike B this file only
// re-exports the frozen wire protocol (packages/canvas-schema/src/protocol.ts, §8.6.1: "protocol.ts
// re-exports canvas-schema/protocol.ts"), under the names spike A's lease code uses:
//
//   client → server   lease.acquire {req, id}          lease.release {id}
//   server → client   lease.grant {req, id, ttlMs}     lease.deny {req, id, holder}
//   server → all      lease {id, holder: {sid, uid, name} | null}
//
// `id` is the lease id: the container for a bound label, the text element itself for free text.
//
// NODE-SAFE (CONTRACTS.md): `client.ts` imports it and runs in Node.

import {
  LeaseAcquire,
  LeaseBroadcast,
  LeaseDeny,
  LeaseGrant,
  LeaseRelease,
} from '@draftroom/canvas-schema/protocol'
import { z } from 'zod'

export type {
  LeaseAcquire,
  LeaseBroadcast,
  LeaseClientMessage,
  LeaseDeny,
  LeaseGrant,
  LeaseHolder,
  LeaseRelease,
  LeaseServerMessage,
} from '@draftroom/canvas-schema/protocol'
export { LEASE_TTL_MS } from '@draftroom/canvas-schema/protocol'

/** Strict: what a server accepts from a client (unknown keys are refused, as in §2.4.2). */
export const leaseClientMessage = z.discriminatedUnion('type', [LeaseAcquire, LeaseRelease])

/** What the client accepts from the server. */
export const leaseServerMessage = z.discriminatedUnion('type', [LeaseGrant, LeaseDeny, LeaseBroadcast])
