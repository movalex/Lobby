// Wave W (docs/WAVE-W-CONTRACTS.md §3.3): which capabilities this worker reports on every ops claim. OWNER: the wave W
// lead. A capability is reported only when all of these hold:
//   - its kind is enabled by WORKER_OPS (a comma list of kinds; unset = every kind this build has; `none` = none);
//   - this build has a runner for it (ops/dispatch.ts OP_RUNNERS);
//   - its prerequisites hold: remove-bg needs the model file to pass ops/bg-model.ts checkBgModel.
// The api hands out only kinds whose CURRENT capability (contracts WORKER_CAPABILITIES) is reported, and offers the
// feature to the web only while one was reported recently, so a worker that cannot do a kind is never given one.

import { WORKER_CAPABILITIES, WORKER_OP_KINDS, type WorkerOpKind } from '@draftroom/contracts'
import type { BgModelCheck } from './bg-model.ts'
import type { OpRunner } from './dispatch.ts'

/** WORKER_OPS: unset or empty = all; `none` = none; else a comma list of op kinds (anything else refuses to start). */
export function parseWorkerOps(raw: string | undefined): WorkerOpKind[] {
  const v = raw?.trim().toLowerCase() ?? ''
  if (v === '' || v === 'all') return [...WORKER_OP_KINDS]
  if (v === 'none') return []
  const out: WorkerOpKind[] = []
  for (const part of v.split(',').map((s) => s.trim())) {
    if (!(WORKER_OP_KINDS as readonly string[]).includes(part))
      throw new Error(`WORKER_OPS must be all, none or a comma list of ${WORKER_OP_KINDS.join(', ')}`)
    if (!out.includes(part as WorkerOpKind)) out.push(part as WorkerOpKind)
  }
  return out
}

export interface CapabilityReport {
  capabilities: string[]
  /** why each enabled kind is not reported (logged at start, without paths or values) */
  missing: { kind: WorkerOpKind; why: string }[]
}

export function reportedCapabilities(o: {
  enabled: readonly WorkerOpKind[]
  runners: Readonly<Partial<Record<WorkerOpKind, OpRunner>>>
  bgModel: BgModelCheck
}): CapabilityReport {
  const capabilities: string[] = []
  const missing: CapabilityReport['missing'] = []
  for (const kind of o.enabled) {
    if (!o.runners[kind]) {
      missing.push({ kind, why: 'this worker build has no runner for it' })
      continue
    }
    if (kind === 'remove-bg' && !o.bgModel.ok) {
      missing.push({ kind, why: `the model file is not usable (${o.bgModel.reason})` })
      continue
    }
    capabilities.push(WORKER_CAPABILITIES[kind])
  }
  return { capabilities, missing }
}
