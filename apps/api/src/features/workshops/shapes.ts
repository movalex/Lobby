// Which shapes exist on a board, and where (parent chain), for vote eligibility. The canvas has one
// authority (the sync server), so the API asks it for the board snapshot through the internal client.
// Snapshots are cached briefly and fetched single-flight, so a burst of casts costs one snapshot; a
// "not eligible" answer from a cache entry that is not brand new is re-checked against a fresh one
// (a note created a second ago can be voted on right away).

import type { VoteShapeInfo } from '@draftroom/contracts'
import { ApiError } from '../../errors.ts'
import type { RoomSnapshotJson, SyncInternalClient } from '../../sync-internal.ts'

export type ShapeMap = ReadonlyMap<string, VoteShapeInfo>

export interface ShapeIndex {
  /** Shapes of the board; `maxAgeMs` bounds how old a cached copy may be. */
  get(boardId: string, opts?: { maxAgeMs?: number }): Promise<ShapeMap>
  /** Checks with the cache first; on a miss from a cached copy older than `recheckAfterMs`, re-fetches. */
  check(boardId: string, test: (shapes: ShapeMap) => boolean): Promise<boolean>
}

const MAX_BOARDS = 200

export function shapesFromSnapshot(snapshot: RoomSnapshotJson): Map<string, VoteShapeInfo> {
  const out = new Map<string, VoteShapeInfo>()
  for (const doc of snapshot.documents ?? []) {
    const r = doc?.state as Record<string, unknown> | undefined
    if (r?.typeName !== 'shape') continue
    const { id, type, parentId } = r
    if (typeof id !== 'string' || typeof type !== 'string' || typeof parentId !== 'string') continue
    out.set(id, { id, type, parentId })
  }
  return out
}

export const syncUnavailable = () =>
  new ApiError(503, 'SYNC_UNAVAILABLE', "Voting can't reach the board right now. Try again in a moment.")

export function createShapeIndex(
  sync: SyncInternalClient,
  opts: { ttlMs?: number; recheckAfterMs?: number; clock?: () => number } = {},
): ShapeIndex {
  const ttl = opts.ttlMs ?? 2_000
  const recheckAfter = opts.recheckAfterMs ?? 250
  const clock = opts.clock ?? (() => performance.now())
  const cache = new Map<string, { at: number; value: Promise<ShapeMap> }>()

  const fetchFresh = (boardId: string) => {
    const at = clock()
    const slot: { at: number; value: Promise<ShapeMap> } = { at, value: Promise.resolve(new Map()) }
    slot.value = sync.snapshot(boardId).then(
      (snap) => shapesFromSnapshot(snap) as ShapeMap,
      () => {
        if (cache.get(boardId) === slot) cache.delete(boardId) // never cache a failure
        throw syncUnavailable()
      },
    )
    cache.delete(boardId) // re-insert at the end: the first key is always the oldest
    cache.set(boardId, slot)
    if (cache.size > MAX_BOARDS) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined && oldest !== boardId) cache.delete(oldest)
    }
    return slot
  }

  const entry = (boardId: string, maxAgeMs: number) => {
    const hit = cache.get(boardId)
    if (hit && clock() - hit.at <= maxAgeMs) return hit
    return fetchFresh(boardId)
  }

  return {
    get: (boardId, o = {}) => entry(boardId, o.maxAgeMs ?? ttl).value,
    async check(boardId, test) {
      const first = entry(boardId, ttl)
      if (test(await first.value)) return true
      if (clock() - first.at < recheckAfter) return false
      const again = cache.get(boardId)
      // Someone may already have refreshed it since; otherwise fetch a fresh copy.
      const fresh = again && again.at > first.at ? again : fetchFresh(boardId)
      return test(await fresh.value)
    },
  }
}
