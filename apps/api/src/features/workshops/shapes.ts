// Which shapes exist on a board, and where (parent chain), for vote eligibility. The canvas has one
// authority (the sync server), so the API asks it for the board snapshot through the internal client.
// Snapshots are cached briefly and fetched single-flight, so a burst of casts costs one snapshot; a
// "not eligible" answer from a cache entry that is not brand new is re-checked against a fresh one
// (a note created a second ago can be voted on right away).

import { LobbyElementsSnapshot, type VoteShapeInfo } from '@draftroom/contracts'
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

/**
 * The vote vocabulary (tldraw's shape types, which `VoteSession.shapeTypes` and VOTE_INELIGIBLE_TYPES
 * use) for an element of the Excalidraw engine's `lobby-elements` snapshot (docs/EXCALIDRAW-MIGRATION.md
 * §2.4.6 "vote eligibility", §3.1): null for an element that is not an object of its own (a bound label).
 */
export function voteTypeOfElement(el: Readonly<Record<string, unknown>>): string | null {
  switch (el.type) {
    case 'stickynote':
      return 'note'
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return 'geo'
    case 'text':
      return typeof el.containerId === 'string' && el.containerId ? null : 'text'
    case 'freedraw': {
      const kind = (el.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind
      return kind === 'highlight' ? 'highlight' : 'draw'
    }
    case 'arrow':
    case 'line':
    case 'image':
    case 'frame':
      return el.type
    default:
      return null
  }
}

/**
 * The shapes of an Excalidraw engine snapshot (`LobbyElementsSnapshot`, @draftroom/contracts
 * sync-internal.ts): live elements only, as `shape:<elementId>` refs (canvas-schema refs.ts), parented
 * to their frame or to the one page.
 */
function shapesFromElements(elements: readonly Readonly<Record<string, unknown>>[]) {
  const out = new Map<string, VoteShapeInfo>()
  for (const el of elements) {
    const id = el.id
    if (typeof id !== 'string' || el.isDeleted === true) continue
    const ref = elementRef(id)
    const type = voteTypeOfElement(el)
    if (!ref || !type) continue
    const frameRef = typeof el.frameId === 'string' ? elementRef(el.frameId) : null
    out.set(ref, { id: ref, type, parentId: frameRef ?? 'page:page' })
  }
  return out
}

/** `shape:<id>` for an element id (canvas-schema refs.ts `toShapeRef`, without importing the engine package). */
const ELEMENT_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const elementRef = (id: string) => (ELEMENT_ID.test(id) ? `shape:${id}` : null)

export function shapesFromSnapshot(
  snapshot: RoomSnapshotJson | LobbyElementsSnapshot,
): Map<string, VoteShapeInfo> {
  // The Excalidraw engine's sync answers the `lobby-elements` envelope (the api asks the same route).
  const lobby = LobbyElementsSnapshot.safeParse(snapshot)
  if (lobby.success) return shapesFromElements(lobby.data.elements)
  const out = new Map<string, VoteShapeInfo>()
  for (const doc of (snapshot as RoomSnapshotJson).documents ?? []) {
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
