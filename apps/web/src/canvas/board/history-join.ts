/**
 * `transact(label, fn, {joinPrevious: true})` (docs/EXCALIDRAW-CONTRACTS.md §2.1, §10 item 4): a derived
 * write (the mind map's re-layout after a text change) folds into this tab's previous undo step instead
 * of becoming a step of its own, as tldraw's side-effect handlers ran inside the user's own step.
 *
 * Lobby's history (canvas/history/stack.ts, spike B's) records one entry per `transact`. The board page
 * snapshots the stack before the joined transact (`joinMark`) and, when the transact recorded exactly
 * one new entry on top of the same previous entry, merges it into that entry (`joinInto`):
 *
 *  - a field changed in both keeps the earlier `before` and the later `after`; a field only the new
 *    write changed is added as it is (its `before` is the state after the previous step, which is what
 *    the merged step undoes to);
 *  - `groupIds` and `boundElements` are re-derived from the earlier `before` and the later `after`;
 *  - pending pushes of both are kept (acks keep folding their `fix` rows into the merged change), and a
 *    change still to be sent stays to be sent.
 *
 * Remote changes interleaved between the two writes never touch entries (`absorb` only moves
 * `lastLocal`), so they are unaffected. No join when the stack was empty, when the last action was an
 * undo or a redo (a non-empty redo stack: the previous step is not the user's last change), or when the
 * transact recorded nothing.
 *
 * Pure (Node-tested). It edits the stack through `undoEntries` (the live array); a change request asks
 * spike B's history for a `mergeTop()` of its own once spike B closes (docs/EXCALIDRAW-CONTRACTS.md §10).
 */
import type { FieldChange } from '../history/diff.ts'
import type { Entry, LobbyHistory, TrackedChange } from '../history/stack.ts'

export interface JoinMark {
  readonly size: number
  readonly top: Entry | null
  readonly redo: number
}

/** The stack before a joined transact. */
export function joinMark(history: LobbyHistory): JoinMark {
  const entries = history.undoEntries
  return { size: entries.length, top: entries[entries.length - 1] ?? null, redo: history.redoSize }
}

/**
 * After the transact: merges the entry it recorded into the previous one when the rules above allow.
 * Returns true when it joined.
 */
export function joinInto(history: LobbyHistory, mark: JoinMark): boolean {
  const entries = history.undoEntries as Entry[]
  if (!mark.top || mark.redo > 0) return false
  if (entries.length !== mark.size + 1 || entries[mark.size - 1] !== mark.top) return false
  const next = entries[mark.size]
  if (!next) return false
  for (const c of next.changes.values()) {
    const p = mark.top.changes.get(c.id)
    if (p) mergeChange(p, c)
    else mark.top.changes.set(c.id, c)
  }
  entries.pop()
  return true
}

function mergeFields(into: Record<string, FieldChange>, from: Record<string, FieldChange>): void {
  for (const [k, fc] of Object.entries(from)) {
    const had = into[k]
    if (had) had.after = fc.after
    else into[k] = { before: fc.before, after: fc.after }
  }
}

function mergeChange(p: TrackedChange, c: TrackedChange): void {
  mergeFields(p.fields, c.fields)
  mergeFields(p.lobby, c.lobby)
  if (c.groupIds) {
    const before = p.groupIds?.before ?? c.groupIds.before
    const after = c.groupIds.after
    const added = after.filter((g) => !before.includes(g))
    const removed = before.filter((g) => !after.includes(g))
    p.groupIds =
      added.length || removed.length ? { added, removed, before: [...before], after: [...after] } : undefined
  }
  if (c.bound) {
    const added = [...(p.bound?.added ?? [])]
    const removed = [...(p.bound?.removed ?? [])]
    for (const r of c.bound.added) {
      const i = removed.findIndex((x) => x.id === r.id)
      if (i >= 0) removed.splice(i, 1)
      else if (!added.some((x) => x.id === r.id)) added.push(r)
    }
    for (const r of c.bound.removed) {
      const i = added.findIndex((x) => x.id === r.id)
      if (i >= 0) added.splice(i, 1)
      else if (!removed.some((x) => x.id === r.id)) removed.push(r)
    }
    p.bound = added.length || removed.length ? { added, removed } : undefined
  }
  p.pending.push(...c.pending)
  p.unsent = c.unsent ?? p.unsent
  p.lifeAt = undefined
}
