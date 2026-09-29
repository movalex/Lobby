// The room's index cache and step 11 of the accept algorithm (docs/EXCALIDRAW-MIGRATION.md §2.4.3,
// §2.11 "Ordering"): `index` is kept valid and unique among live elements with
// `@excalidraw/fractional-indexing` at the pinned version (through canvas-schema's engine wrappers), and
// a bound label sorts after its container. A null or invalid key gets a key at the top; a key another live
// element uses gets a key right above it; a label at or below its container gets a key right above the
// container. Each rewrite comes back to the writer as `fix` (or reaches everyone as a repair).

import { compareByIndex, indexKeyBetween, isValidIndexKey } from '@draftroom/canvas-schema/engine'

interface Entry {
  idx: string
  id: string
}

const cmp = (a: Entry, b: Entry) => compareByIndex({ index: a.idx, id: a.id }, { index: b.idx, id: b.id })

/** Live elements' `(idx, id)` in Excalidraw's order (SQLite's `ORDER BY idx, id`). */
export class IndexCache {
  private list: Entry[] = []
  private byId = new Map<string, string>()

  reset(rows: readonly { idx: string; id: string }[]): void {
    this.list = rows.map((r) => ({ idx: r.idx, id: r.id }))
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

  /** Another live element (not `id`) uses `idx`. */
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
