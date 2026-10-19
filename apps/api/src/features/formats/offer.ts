// Wave W (docs/WAVE-W-CONTRACTS.md §3.3): what GET /api/auth/config tells the web it may offer (AuthConfig.formats).
// OWNER: the wave W lead.
//
// docCards and admin are their switches. The three worker-backed features are their switch AND a worker that reported
// the kind's CURRENT capability (contracts WORKER_CAPABILITIES) within WORKER_OP_LIMITS.capabilityFreshMs, read from
// worker_capabilities_seen (written by every ops claim, worker/ops-jobs.ts). So until a worker that can do the work has
// asked for it, the web offers nothing that would only queue: in particular until the owner rebuilds the NAS worker.
// The read is cached for CACHE_MS (the config is asked on every page load) and fails closed: a database error offers
// none of the three.

import {
  FORMAT_SWITCH_OP,
  type FormatSwitches,
  type FormatsOffer,
  WORKER_CAPABILITIES,
  WORKER_OP_KINDS,
  WORKER_OP_LIMITS,
  type WorkerOpKind,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

const CACHE_MS = 15_000

/** The op kinds a capable worker reported recently (the current capability of each, exactly). */
export async function freshCapabilityKinds(q: Queryable, now: Date): Promise<Set<WorkerOpKind>> {
  const since = new Date(now.getTime() - WORKER_OP_LIMITS.capabilityFreshMs)
  const rows = await q.query<{ capability: string }>(
    'SELECT capability FROM worker_capabilities_seen WHERE capability = ANY($1::text[]) AND last_seen_at >= $2',
    [WORKER_OP_KINDS.map((k) => WORKER_CAPABILITIES[k]), since],
  )
  const seen = new Set(rows.rows.map((r) => r.capability))
  return new Set(WORKER_OP_KINDS.filter((k) => seen.has(WORKER_CAPABILITIES[k])))
}

/** The offer from the switches and the kinds a capable worker reported (pure). */
export function offerOf(switches: FormatSwitches, capable: ReadonlySet<WorkerOpKind>): FormatsOffer {
  const out = { ...switches }
  for (const [s, kind] of Object.entries(FORMAT_SWITCH_OP) as [keyof FormatSwitches, WorkerOpKind][])
    out[s] = switches[s] === true && capable.has(kind)
  return out
}

export interface FormatsOfferSource {
  /** The current offer (cached for 15 s). */
  (): Promise<FormatsOffer>
  /** Forget the cache (a claim that recorded a new capability; tests). */
  invalidate(): void
}

export function createFormatsOffer(deps: {
  db: Queryable
  now: () => Date
  switches: FormatSwitches
}): FormatsOfferSource {
  let cached: { at: number; offer: FormatsOffer } | null = null
  const anyWorkerBacked = Object.keys(FORMAT_SWITCH_OP).some((s) => deps.switches[s as keyof FormatSwitches])
  const source = (async () => {
    // nothing worker-backed is on: no read at all
    if (!anyWorkerBacked) return offerOf(deps.switches, new Set())
    const now = deps.now()
    if (cached && now.getTime() - cached.at < CACHE_MS) return cached.offer
    let capable: Set<WorkerOpKind>
    try {
      capable = await freshCapabilityKinds(deps.db, now)
    } catch {
      capable = new Set() // fail closed
    }
    const offer = offerOf(deps.switches, capable)
    cached = { at: now.getTime(), offer }
    return offer
  }) as FormatsOfferSource
  source.invalidate = () => {
    cached = null
  }
  return source
}
