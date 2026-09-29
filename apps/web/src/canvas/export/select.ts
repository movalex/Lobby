// What an export draws (docs/EXCALIDRAW-MIGRATION.md §4.5, §4.7): live elements, never a hidden one (a
// collapsed mind-map branch: render overrides do not change exports, so the exporter filters them), and,
// for a partial export, the chosen elements with their bound labels and a chosen frame's children.
// Pure: unit-tested in Node.

export interface ExportableElement {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly containerId?: string | null
  readonly frameId?: string | null
}

export interface ExportSelection {
  /** hidden ids (labels and frame children already included by the collapse): left out */
  readonly isHidden?: (id: string) => boolean
  /** only these ids (a selection or a frame), after the hidden filter */
  readonly only?: ReadonlySet<string>
}

export function exportElements<T extends ExportableElement>(
  elements: readonly T[],
  sel: ExportSelection = {},
): T[] {
  const live = elements.filter((e) => !e.isDeleted && !sel.isHidden?.(e.id))
  if (!sel.only) return live
  const keep = new Set(sel.only)
  // to a fixed point: a chosen frame's child, that child's label, …
  for (let grew = true; grew; ) {
    grew = false
    for (const e of live) {
      if (keep.has(e.id)) continue
      const viaLabel = e.type === 'text' && !!e.containerId && keep.has(e.containerId)
      const viaFrame = !!e.frameId && keep.has(e.frameId)
      if (viaLabel || viaFrame) {
        keep.add(e.id)
        grew = true
      }
    }
  }
  return live.filter((e) => keep.has(e.id))
}
