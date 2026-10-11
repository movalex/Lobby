// OWNER: WS4 (wave N, N4-2). Narrowing "what changed since your last visit" with a checkpoint from before the visit.
// The timestamps (./model.ts) are exact about WHEN, but a tombstone cannot say whether the person ever saw the element
// (made and deleted while they were away), and an arrow's `updated` cannot say whether a person or the server's
// re-snap moved it. A checkpoint at or before the visit can: W7's time-travel diff (../history/ported/diff.ts) compares
// the checkpoint with the board now by id, version and field, and calls an arrow that only followed a moved shape
// 'derived'. So, over the timestamp result:
//  - changed: only what the diff also calls a change (geometry, text, style), or an element new since the checkpoint
//    (made before the visit, then edited after it); 'derived' arrows and elements with no net difference are dropped;
//  - removed: only what the checkpoint had (it was on the board at some point before the visit), with the name and the
//    place the checkpoint knew it by, which a tombstone does not keep;
//  - added: unchanged (the server's creation stamp is exact).
// Pure; a board of 20,000 elements or more is not compared (the caller skips it: MAX_DIFF_ELEMENTS).

import { type DiffBounds, type DiffEntry, diffCheckpoint } from '../history/ported/diff.ts'
import { finish, type RemovedItem, type VisitChanges } from './model.ts'

/** Boards at or over this many elements keep the timestamps' answer: the diff walks both sides' fields. */
export const MAX_DIFF_ELEMENTS = 20_000

/** The diff kinds that are a person's change to an element that was already on the board. */
const REAL_CHANGES = new Set<DiffEntry['kind']>(['geometry', 'text', 'style', 'added'])

export function refineWithCheckpoint(
  changes: VisitChanges,
  checkpoint: readonly unknown[],
  live: readonly unknown[],
  opts: { isHidden?: (id: string) => boolean } = {},
): VisitChanges {
  const diff = diffCheckpoint(checkpoint, live, opts.isHidden ? { liveHidden: opts.isHidden } : {})
  const byId = new Map<string, DiffEntry>(diff.entries.map((e) => [e.id, e]))
  let derived = changes.derived
  const changed: string[] = []
  for (const id of changes.changed) {
    const entry = byId.get(id)
    if (entry && REAL_CHANGES.has(entry.kind)) changed.push(id)
    else if (entry?.kind === 'derived') derived++
  }
  const removed: RemovedItem[] = []
  for (const r of changes.removed) {
    const entry = byId.get(r.id)
    if (entry?.kind !== 'removed') continue
    removed.push({ ...r, name: entry.name, bounds: boundsOf(entry.bounds) })
  }
  return finish(changes.seenAt, changes.added, changed, removed, derived, false)
}

const boundsOf = (b: DiffBounds): NonNullable<RemovedItem['bounds']> => ({
  x: b.x,
  y: b.y,
  width: b.width,
  height: b.height,
})
