// Spike B ports (docs/EXCALIDRAW-MIGRATION.md §8.6.5), frozen at the contracts step C0. Lead-owned.
//
// Spike B uses 7850–7999, and the wave-5 owners who run its specs their own ranges (below). Everything else stays free: today's e2e defaults (sync 5881, api 5882,
// web 4191) and earlier bases such as E2E_PORT_BASE=6500, and spike A's ranges 7700–7849.
//
// Each stack uses one base: sync on base, api on base + 1, web on base + 2, with the web build in
// `apps/web/dist/spike-b-<web port>` and Playwright's output in `e2e/test-results/spike-b-<web port>`.
// Exception: B8's staging runs keep their data dir, TEMP/TMP and Playwright output inside `spike-b8/`
// (§8.6.7; the `b8-staging` project). Separate browser processes need no port; tests that bind port 0 stay
// on port 0. Every owner lists the listeners in its range before starting and after finishing, and leaves
// nothing listening or running.

export const HOST = '127.0.0.1'
export const SPIKE_B_PORT_MIN = 7850
export const SPIKE_B_PORT_MAX = 7999

export type SpikeBOwner =
  | 'lead'
  | 'O1'
  | 'O2'
  | 'O3'
  | 'O4'
  | 'O5'
  | 'V1'
  | 'V2'
  | 'V3'
  | 'spare'
  | '2B'
  | 'engine-int'
  | 'wave-c5'

/** §8.6.5: each owner's range. */
export const PORT_RANGES: Readonly<Record<SpikeBOwner, readonly [number, number]>> = {
  lead: [7850, 7859],
  O1: [7860, 7869],
  O2: [7870, 7879],
  O3: [7880, 7899],
  O4: [7900, 7909],
  O5: [7910, 7919],
  V1: [7920, 7929],
  V2: [7930, 7939],
  V3: [7940, 7949],
  spare: [7950, 7999],
  /** wave 5: the sync edges owner (B8's specs and drills on engine/w5-2b), docs/EXCALIDRAW-CONTRACTS.md §0a */
  '2B': [6440, 6479],
  /** wave 5: the engine integrator (the spike-b suite and B8's generated rows on the merged engine/excalidraw) */
  'engine-int': [6520, 6559],
  /** wave C, workstream C5 (e2e harness and coverage): its own range for the split arrows specs and the e2e runs */
  'wave-c5': [7460, 7499],
}

/** §8.6.5: the named stacks (the base of each; sync = base, api = base + 1, web = base + 2). */
export const STACKS = {
  /** the lead's integration stack (also SPIKE_WEB_PORT for the spike A suite) */
  leadIntegration: 7850,
  /** the lead's final pass, second stack */
  leadFinalSecond: 7855,
  o1Dev: 7860,
  o2: 7870,
  o3Harness: 7880,
  /** §8.4 measurements */
  o3Measure: 7885,
  /** a local load-generator dry run */
  o3LoadDry: 7890,
  /** B9's workstation half: two browsers with a local L2 */
  o3B9Workstation: 7895,
  /** the R0 stand-in (tldraw sync and api); data, temp and output under spike-b8/ when it touches staging copies */
  o4R0: 7900,
  /** the Excalidraw stack of B8 */
  o4Excalidraw: 7905,
  o5: 7910,
  v1: 7920,
  v2: 7930,
  v3: 7940,
} as const

export interface StackPorts {
  readonly base: number
  readonly sync: number
  readonly api: number
  readonly web: number
  readonly syncUrl: string
  readonly apiUrl: string
  readonly webUrl: string
  /** the web build folder, relative to apps/web */
  readonly webOutDir: string
  /** Playwright's output folder name under e2e/test-results */
  readonly runTag: string
}

/** The ports of the stack at `base` (checked to lie, with its two neighbours, in one owner's range). */
export function stackPorts(base: number): StackPorts {
  const owner = Number.isInteger(base) ? ownerOf(base) : null
  const inSpike = base >= SPIKE_B_PORT_MIN && base + 2 <= SPIKE_B_PORT_MAX
  if (!owner || (!inSpike && ownerOf(base + 2) !== owner))
    throw new Error(
      `a spike B stack base must be in ${SPIKE_B_PORT_MIN}-${SPIKE_B_PORT_MAX - 2} or one owner's range (got ${base})`,
    )
  const web = base + 2
  return {
    base,
    sync: base,
    api: base + 1,
    web,
    syncUrl: `http://${HOST}:${base}`,
    apiUrl: `http://${HOST}:${base + 1}`,
    webUrl: `http://${HOST}:${web}`,
    webOutDir: `dist/spike-b-${web}`,
    runTag: `spike-b-${web}`,
  }
}

/** The owner whose range holds `port`, or null outside every range. */
export function ownerOf(port: number): SpikeBOwner | null {
  for (const [owner, [lo, hi]] of Object.entries(PORT_RANGES) as [SpikeBOwner, readonly [number, number]][])
    if (port >= lo && port <= hi) return owner
  return null
}

/** SPIKE_B_PORT_BASE picks the stack a Playwright run builds and serves (default: the lead's integration stack). */
export function stackFromEnv(env: Record<string, string | undefined> = process.env): StackPorts {
  const raw = env.SPIKE_B_PORT_BASE
  return stackPorts(raw === undefined || raw === '' ? STACKS.leadIntegration : Number(raw))
}
