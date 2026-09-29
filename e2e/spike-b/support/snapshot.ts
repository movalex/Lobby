// Convergence and invariants (docs/EXCALIDRAW-MIGRATION.md §8.1, §8.6.2 hash.ts): the test snapshot
// (`GET <sync>/internal/test/boards/:bid/snapshot`, live elements AND tombstones, behind the internal
// secret and DRAFTROOM_TEST_HOOKS=1), its hash.ts digest, the invariant checker on it (O1's
// `checkInvariants`), and the comparison of every browser's and headless client's map with it.
//
// A check whose `horizon` moved during its window saw a compaction purge and is invalid (§8.1): the
// report says `horizonMoved`, `ok` is false, and the spec re-runs the check instead of counting it.

import type { SceneElement } from '../../../apps/web/src/canvas/sync/types.ts'
import { canonicalElement, canonicalJson, hashElements } from '../../../packages/canvas-schema/src/hash.ts'
import { checkInvariants as checkBoardInvariants } from '../../../packages/canvas-schema/src/invariants.ts'
import { TEST_HOOK_PATHS, TestSnapshot } from '../../../packages/canvas-schema/src/protocol.ts'
import { canvasOf } from './facade.ts'
import type { BrowserProcess, ConvergenceReport, InvariantReport, Snapshot, SpikeBStack } from './types.ts'

const SECRET_HEADER = 'x-draftroom-internal'

/** Something whose element map can be hashed: a browser (through its facade) or a headless client. */
export type HashTarget = BrowserProcess | { readonly name: string; hash(): Promise<string> }

/** Reads the test snapshot and hashes it. Throws with the status on anything but 200. */
export async function readSnapshot(stack: SpikeBStack, boardId: string): Promise<Snapshot> {
  const res = await fetch(`${stack.ports.syncUrl}${TEST_HOOK_PATHS.snapshot(boardId)}`, {
    headers: { [SECRET_HEADER]: stack.internalSecret, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status !== 200) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(
      res.status === 404
        ? `test snapshot: 404 (${body}) — the stack needs DRAFTROOM_TEST_HOOKS=1 and a room that registered its hooks (O1)`
        : `test snapshot: HTTP ${res.status} ${body}`,
    )
  }
  const snap = TestSnapshot.parse(await res.json())
  return { ...snap, hash: await hashElements(snap.elements) }
}

/** O1's invariant checker on a snapshot (live elements and tombstones). */
export function checkInvariants(snapshot: Snapshot): InvariantReport {
  const violations = checkBoardInvariants(snapshot.elements)
  return { ok: violations.length === 0, violations }
}

const isBrowser = (t: HashTarget): t is BrowserProcess => 'page' in t && 'browser' in t

export async function hashOf(target: HashTarget): Promise<string> {
  return isBrowser(target) ? canvasOf(target.page).hash() : target.hash()
}

/**
 * Waits (up to `timeoutMs`, default 20 s) until every target's hash equals the snapshot's, re-reading
 * the snapshot on each attempt, and reports the last attempt. Never throws on divergence: the caller
 * asserts `ok` (and, on failure, calls `explainDivergence` for the ids).
 */
export async function converged(
  stack: SpikeBStack,
  boardId: string,
  targets: readonly HashTarget[],
  opts: { readonly horizonAtStart?: number; readonly timeoutMs?: number; readonly pollMs?: number } = {},
  read: (stack: SpikeBStack, boardId: string) => Promise<Snapshot> = readSnapshot,
): Promise<ConvergenceReport> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000)
  for (;;) {
    const snapshot = await read(stack, boardId)
    const hashes: Record<string, string> = {}
    for (const t of targets) hashes[t.name] = await hashOf(t)
    const horizonMoved = opts.horizonAtStart !== undefined && snapshot.horizon !== opts.horizonAtStart
    const same = Object.values(hashes).every((h) => h === snapshot.hash)
    if ((same && !horizonMoved) || horizonMoved || Date.now() >= deadline)
      return { ok: same && !horizonMoved, snapshot, hashes, horizonMoved }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 250))
  }
}

/** Per id, how a map differs from the snapshot: missing on either side, or different canonical JSON. */
export interface Divergence {
  readonly name: string
  readonly onlyInSnapshot: string[]
  readonly onlyInMap: string[]
  /** ids whose canonical element differs, with the differing top-level keys (never their values) */
  readonly differ: { id: string; keys: string[] }[]
}

/** Compares a map (every element, deleted ones included) with the snapshot, element by element. */
export function divergence(name: string, map: readonly SceneElement[], snapshot: Snapshot): Divergence {
  const snap = new Map(snapshot.elements.map((e) => [e.id, canonicalElement(e as Record<string, unknown>)]))
  const mine = new Map(map.map((e) => [e.id, canonicalElement(e as Record<string, unknown>)]))
  const differ: { id: string; keys: string[] }[] = []
  for (const [id, a] of mine) {
    const b = snap.get(id)
    if (!b) continue
    if (canonicalJson(a) === canonicalJson(b)) continue
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (k) => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null),
    )
    differ.push({ id, keys })
  }
  return {
    name,
    onlyInSnapshot: [...snap.keys()].filter((id) => !mine.has(id)),
    onlyInMap: [...mine.keys()].filter((id) => !snap.has(id)),
    differ,
  }
}

/** For a failed convergence: each browser's divergence from the snapshot (ids and keys only). */
export async function explainDivergence(
  report: ConvergenceReport,
  browsers: readonly BrowserProcess[],
): Promise<Divergence[]> {
  const out: Divergence[] = []
  for (const b of browsers) {
    if (report.hashes[b.name] === report.snapshot.hash) continue
    out.push(divergence(b.name, await canvasOf(b.page).allElements(), report.snapshot))
  }
  return out
}
