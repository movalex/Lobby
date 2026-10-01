// The room's index cache and step 11 of the accept algorithm (docs/EXCALIDRAW-MIGRATION.md §2.4.3,
// §2.11 "Ordering"): `index` is kept valid and unique with `@excalidraw/fractional-indexing` at the pinned
// version (through canvas-schema's engine wrappers), and a bound label sorts after its container. A null or
// invalid key gets a key at the top; a key another element uses gets a key right above it; a label at or
// below its container gets a key right above the container. Each rewrite comes back to the writer as `fix`
// (or reaches everyone as a repair).
//
// "Another element" includes the tombstones (V3, wave 5): a live element never takes a deleted element's
// key. Before, the cache held live elements only, so a raw push could store a live element at a tombstone's
// key; the next browser to open the board re-keyed the tombstone (an echo, §2.5.5), and a roll-forward that
// edited that element failed INDEX_DUPLICATE (§5.9 step g). Tombstones keep their keys; new keys are made
// between the keys of live elements AND tombstones.

import { compareByIndex, indexKeyBetween, isValidIndexKey } from '@draftroom/canvas-schema/engine'

interface Entry {
  idx: string
  id: string
  /** a tombstone's key: no live element may take it, and new keys are made around it */
  dead?: true
}

const cmp = (a: Entry, b: Entry) => compareByIndex({ index: a.idx, id: a.id }, { index: b.idx, id: b.id })

/** Every element's `(idx, id)`, tombstones marked, in Excalidraw's order (SQLite's `ORDER BY idx, id`). */
export class IndexCache {
  private list: Entry[] = []
  private byId = new Map<string, string>()

  /** `rows`: the live elements; `dead`: the tombstones (their keys are taken too). */
  reset(
    rows: readonly { idx: string; id: string }[],
    dead: readonly { idx: string; id: string }[] = [],
  ): void {
    this.list = [
      ...rows.map((r) => ({ idx: r.idx, id: r.id })),
      ...dead
        .filter((r) => isValidIndexKey(r.idx))
        .map((r) => ({ idx: r.idx, id: r.id, dead: true as const })),
    ]
    this.list.sort(cmp)
    this.byId = new Map(this.list.map((e) => [e.id, e.idx]))
  }

  get size(): number {
    return this.list.length
  }

  /** First position whose entry sorts at or after `e`. */
  private lowerBound(e: Entry): number {
    let lo = 0
    let hi = this.list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cmp(this.list[mid] as Entry, e) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  remove(id: string): void {
    const idx = this.byId.get(id)
    if (idx === undefined) return
    const i = this.lowerBound({ idx, id })
    if (this.list[i]?.id === id) this.list.splice(i, 1)
    this.byId.delete(id)
  }

  set(id: string, idx: string): void {
    this.remove(id)
    const e = { idx, id }
    this.list.splice(this.lowerBound(e), 0, e)
    this.byId.set(id, idx)
  }

  /** `id` is a tombstone at `idx` (deleted now, or a tombstone re-keyed): its key stays taken. */
  setDead(id: string, idx: string | null | undefined): void {
    this.remove(id)
    if (!isValidIndexKey(idx)) return
    const e: Entry = { idx, id, dead: true }
    this.list.splice(this.lowerBound(e), 0, e)
    this.byId.set(id, idx)
  }

  /** Another element (not `id`), live or a tombstone, uses `idx`. */
  usedByOther(idx: string, id: string): boolean {
    let i = this.lowerBound({ idx, id: '' })
    while (i < this.list.length && (this.list[i] as Entry).idx === idx) {
      if ((this.list[i] as Entry).id !== id) return true
      i++
    }
    return false
  }

  /** The smallest key strictly greater than `idx`, ignoring `exceptId` (null: none). */
  nextKeyAbove(idx: string, exceptId: string): string | null {
    let i = this.lowerBound({ idx, id: '￿' })
    while (i < this.list.length) {
      const e = this.list[i] as Entry
      if (e.idx > idx && e.id !== exceptId) return e.idx
      i++
    }
    return null
  }

  /** The largest key, ignoring `exceptId`. */
  maxKey(exceptId?: string): string | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i] as Entry
      if (e.id !== exceptId) return e.idx
    }
    return null
  }

  keyOf(id: string): string | undefined {
    return this.byId.get(id)
  }
}

/** A fresh key right above `lo` (below the next key above it), or at the top when `lo` is null. */
export function keyAbove(cache: IndexCache, lo: string | null, selfId: string): string {
  if (lo === null) return indexKeyBetween(cache.maxKey(selfId), null)
  return indexKeyBetween(lo, cache.nextKeyAbove(lo, selfId))
}

export { isValidIndexKey }
