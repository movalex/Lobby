// In-memory state an open room keeps next to its board file (docs/EXCALIDRAW-MIGRATION.md §2.13 "Per
// open board"): the group-parent map, the live counts, and the writer ledger. Rebuilt from the file when
// the room opens or reopens (after a failed COMMIT, or a push that threw).

import { groupParents } from '@draftroom/canvas-schema/invariants'

/** Each group id's parent group, counted over the live elements (§2.4.4 "Group nesting"). */
export class GroupMap {
  private readonly parents = new Map<string, Map<string | null, number>>()

  reset(): void {
    this.parents.clear()
  }

  add(groupIds: readonly string[] | undefined): void {
    for (const [g, p] of groupParents(groupIds ?? [])) {
      const m = this.parents.get(g) ?? new Map<string | null, number>()
      m.set(p, (m.get(p) ?? 0) + 1)
      this.parents.set(g, m)
    }
  }

  remove(groupIds: readonly string[] | undefined): void {
    for (const [g, p] of groupParents(groupIds ?? [])) {
      const m = this.parents.get(g)
      if (!m) continue
      const n = (m.get(p) ?? 0) - 1
      if (n > 0) m.set(p, n)
      else m.delete(p)
      if (m.size === 0) this.parents.delete(g)
    }
  }

  /**
   * The groups that would have more than one parent if the live elements `removed` (their old
   * `groupIds`) were replaced by `added` (their new ones).
   */
  conflicts(removed: readonly (readonly string[])[], added: readonly (readonly string[])[]): Set<string> {
    const delta = new Map<string, Map<string | null, number>>()
    const bump = (ids: readonly string[], by: number) => {
      for (const [g, p] of groupParents(ids)) {
        const m = delta.get(g) ?? new Map<string | null, number>()
        m.set(p, (m.get(p) ?? 0) + by)
        delta.set(g, m)
      }
    }
    for (const ids of removed) bump(ids, -1)
    for (const ids of added) bump(ids, 1)
    const out = new Set<string>()
    for (const [g, d] of delta) {
      const merged = new Map(this.parents.get(g) ?? [])
      for (const [p, n] of d) merged.set(p, (merged.get(p) ?? 0) + n)
      let distinct = 0
      for (const n of merged.values()) if (n > 0) distinct++
      if (distinct > 1) out.add(g)
    }
    return out
  }
}

/** Who wrote each clock (the push's author), for the STALE rules of §2.4.3 step 8. Bounded. */
export class WriterLedger {
  private readonly map = new Map<number, string>()
  private readonly max: number
  constructor(max = 200_000) {
    this.max = max
  }
  set(clock: number, uid: string): void {
    this.map.set(clock, uid)
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value
      if (first !== undefined) this.map.delete(first)
    }
  }
  /** The author of `clock`, or null when unknown (before this room opened: treated as someone else). */
  get(clock: number): string | null {
    return this.map.get(clock) ?? null
  }
}

/** Live counts for the board caps (§3.5): items (a bound label does not count) and elements. */
export interface LiveCounts {
  elements: number
  items: number
}
