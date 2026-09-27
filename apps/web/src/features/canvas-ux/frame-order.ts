// Frame outline ordering (MAK-13): pure helpers that turn a drag, "Auto-order" or a skip toggle into
// shape `meta` partials. The presentation order itself is board-ops `presentationOrder` (numeric
// meta.presentationIndex first, then reading order); present-export reads the same fields.
//
// tldraw's updateShapes merges `meta` shallowly (Editor.applyPartialToRecordWithProps), so a key cannot
// be deleted through a partial: "no explicit index" is written as `presentationIndex: null` (board-ops
// only honours numbers) and "not skipped" as `presentationSkip: false`.

export type Meta = Readonly<Record<string, unknown>>

export interface FrameMetaLike {
  id: string
  meta: Meta
}

export interface MetaPatch {
  id: string
  /** Keys to set (merged into the frame's existing meta by the editor). */
  meta: Record<string, unknown>
}

/** A copy of `list` with the item at `from` moved to `to` (indices clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const [item] = out.splice(from, 1)
  const target = Math.max(0, Math.min(out.length, to))
  out.splice(target, 0, item as T)
  return out
}

/**
 * presentationIndex 0..n-1 in `orderedIds` order for every listed frame, so the whole order becomes
 * explicit (frames created later are appended after them, like Miro). Unchanged frames get no patch.
 */
export function presentationIndexPatches(
  orderedIds: readonly string[],
  frames: readonly FrameMetaLike[],
): MetaPatch[] {
  const byId = new Map(frames.map((f) => [f.id, f]))
  const patches: MetaPatch[] = []
  orderedIds.forEach((id, index) => {
    const frame = byId.get(id)
    if (!frame || frame.meta.presentationIndex === index) return
    patches.push({ id, meta: { presentationIndex: index } })
  })
  return patches
}

/**
 * "Auto-order": clear every explicit presentationIndex, so the order follows the board layout (rows
 * top to bottom, left to right within a row) and keeps following it as frames move.
 */
export function autoOrderPatches(frames: readonly FrameMetaLike[]): MetaPatch[] {
  return frames
    .filter((f) => typeof f.meta.presentationIndex === 'number')
    .map((f) => ({ id: f.id, meta: { presentationIndex: null } }))
}

export function isSkipped(meta: Meta | undefined): boolean {
  return meta?.presentationSkip === true
}

/** Skip / include in presentation. */
export function skipPatch(frame: FrameMetaLike, skip: boolean): MetaPatch | null {
  if (isSkipped(frame.meta) === skip) return null
  return { id: frame.id, meta: { presentationSkip: skip } }
}

/** Whether the order is explicit (someone reordered) or automatic (follows the layout). */
export function hasManualOrder(frames: readonly FrameMetaLike[]): boolean {
  return frames.some((f) => typeof f.meta.presentationIndex === 'number')
}

/** Applies patches the way tldraw does (shallow meta merge). For tests and optimistic UI. */
export function mergeMeta(meta: Meta, patch: MetaPatch | undefined): Record<string, unknown> {
  return patch ? { ...meta, ...patch.meta } : { ...meta }
}

/**
 * F20: the outline's row number, or null when the frame's name already starts with one ("2 · What
 * went well" would otherwise read "1  2 · What went well").
 */
export function rowNumberLabel(name: string, index: number): string | null {
  return /^\s*\d/.test(name) ? null : String(index + 1)
}

/** F12: Shift/Ctrl/Cmd-click on a frame row adds it to the selection, or takes it out. */
export function toggleInSelection<T extends string>(selected: readonly T[], id: T): T[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]
}
